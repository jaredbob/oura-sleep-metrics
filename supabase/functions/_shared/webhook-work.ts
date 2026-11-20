import {
  type Collection,
  collectionPath,
  type OuraRecord,
} from "./collection.ts";
import { collections } from "./collections.ts";
import { sql, type SqlTransaction } from "./db.ts";
import { nextReadRevision } from "./document-versions.ts";
import {
  ConsentRequired,
  ouraUserFetch,
  ReconnectRequired,
} from "./oura-auth.ts";
import { eventRanks } from "./webhook.ts";

type Delivery = {
  id: string;
  collection: string;
  document_id: string;
  event_time: string;
  event_rank: number;
  generation: string;
  lease: string;
};

class DocumentUnavailable extends Error {}
class DocumentChanged extends Error {}

export async function runWebhookWork(ownerId: string): Promise<void> {
  // Bound the number of outstanding provider requests per Edge invocation.
  const deadline = Date.now() + 8_000;
  for (let count = 0; count < 12 && Date.now() < deadline; count++) {
    const delivery = await claimDelivery(ownerId);
    if (!delivery) break;

    try {
      const collection = collections.find(({ name }) =>
        name === delivery.collection
      );
      if (!collection) throw new Error("Unknown webhook collection.");

      const revision = await nextReadRevision(ownerId);
      const version = await documentVersion(sql(), ownerId, delivery, revision);
      const deleting = delivery.event_rank === eventRanks.delete;
      const record = !version?.stale && !deleting
        ? await fetchDocument(ownerId, collection, delivery.document_id)
        : null;
      await completeDelivery(ownerId, collection, delivery, revision, record);
    } catch (error) {
      const retryReason = error instanceof ReconnectRequired
        ? "reconnect_required"
        : error instanceof ConsentRequired
        ? "consent_required"
        : error instanceof DocumentUnavailable
        ? "oura_document_unavailable"
        : error instanceof DocumentChanged
        ? "document_changed"
        : "processing_failed";
      await sql()`
        update oura_private.webhook_deliveries
        set lease = null, retry_reason = ${retryReason},
            available_at = now() + make_interval(secs => least(900, power(2, least(attempts, 10))))
        where id = ${delivery.id} and lease = ${delivery.lease}
      `;
    }
  }
}

export async function pruneCompletedDeliveries(ownerId: string): Promise<void> {
  await sql()`
    with old_deliveries as (
      select id from oura_private.webhook_deliveries
      where owner_id = ${ownerId} and processed_at < now() - interval '7 days'
      order by processed_at, id
      limit 1000
      for update skip locked
    )
    delete from oura_private.webhook_deliveries deliveries
    using old_deliveries where deliveries.id = old_deliveries.id
  `;
}

async function claimDelivery(ownerId: string): Promise<Delivery | undefined> {
  const [delivery] = await sql()<Delivery[]>`
    with pending as (
      select deliveries.id, connections.generation
      from oura_private.webhook_deliveries deliveries
      join oura_private.connections using (owner_id)
      where owner_id = ${ownerId}
        and (connections.status = 'connected' or deliveries.event_rank = ${eventRanks.delete})
        and deliveries.processed_at is null and deliveries.available_at <= now()
      order by deliveries.available_at, deliveries.id
      for update of deliveries skip locked
      limit 1
    )
    update oura_private.webhook_deliveries deliveries
    set lease = gen_random_uuid(), available_at = now() + interval '1 minute', attempts = attempts + 1
    from pending
    where deliveries.id = pending.id
    returning deliveries.id::text, deliveries.collection, deliveries.document_id, deliveries.event_time::text,
              deliveries.event_rank, deliveries.lease, pending.generation
  `;
  return delivery;
}

function documentVersion(
  tx: SqlTransaction | ReturnType<typeof sql>,
  ownerId: string,
  delivery: Delivery,
  revision: string,
) {
  return tx<{ stale: boolean | null; write_allowed: boolean }[]>`
    select
           (event_time, event_rank) >= (${delivery.event_time}::timestamptz, ${delivery.event_rank}::smallint) as stale,
           (read_revision < ${revision}::bigint) as write_allowed
    from oura_private.document_versions
    where owner_id = ${ownerId} and collection = ${delivery.collection}
      and document_id = ${delivery.document_id}
  `.then(([version]) => version);
}

async function fetchDocument(
  ownerId: string,
  collection: Collection,
  documentId: string,
): Promise<OuraRecord> {
  const response = await ouraUserFetch(
    ownerId,
    collectionPath(collection, documentId),
    collection.scope,
  );
  if (!response.ok) {
    await response.body?.cancel();
    // A missing current document may precede delivery of its delete event.
    throw new DocumentUnavailable();
  }
  const record = collection.parse(await response.json());
  if (record.document_id !== documentId) throw new DocumentUnavailable();
  return record;
}

async function completeDelivery(
  ownerId: string,
  collection: Collection,
  delivery: Delivery,
  revision: string,
  record: OuraRecord | null,
) {
  await sql().begin(async (tx) => {
    const [connection] = await tx`
      select generation, status from oura_private.connections
      where owner_id = ${ownerId} for no key update
    `;
    const deleted = delivery.event_rank === eventRanks.delete;
    if (
      connection?.generation !== delivery.generation ||
      (!deleted && connection.status !== "connected")
    ) {
      throw new Error(
        "The Oura connection changed during delivery processing.",
      );
    }

    const marked = await tx`
      update oura_private.webhook_deliveries
      set lease = null, processed_at = now(), retry_reason = null
      where id = ${delivery.id} and lease = ${delivery.lease}
    `;
    if (marked.count === 0) return;

    const version = await documentVersion(tx, ownerId, delivery, revision);
    if (version?.stale) return;

    if (deleted) {
      await collection.remove(tx, ownerId, delivery.document_id);
    } else {
      // Leave the delivery retryable so it reads the current source again.
      if (version && !version.write_allowed) throw new DocumentChanged();
      if (!record) throw new DocumentUnavailable();
      await collection.upsert(tx, ownerId, [record]);
    }
    // Fence off every snapshot read started before this authoritative write.
    await tx`
      insert into oura_private.document_versions
        (owner_id, collection, document_id, read_revision, event_time, event_rank, deleted)
      values
        (${ownerId}, ${collection.name}, ${delivery.document_id}, nextval('oura_private.document_read_revision'),
         ${delivery.event_time}::timestamptz, ${delivery.event_rank}, ${deleted})
      on conflict (owner_id, collection, document_id) do update
      set event_time = excluded.event_time, event_rank = excluded.event_rank, deleted = excluded.deleted,
          read_revision = excluded.read_revision
    `;
  });
}
