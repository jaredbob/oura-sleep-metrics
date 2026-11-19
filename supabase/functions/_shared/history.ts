import {
  type Collection,
  collectionPath,
  type OuraRecord,
} from "./collection.ts";
import { collections } from "./collections.ts";
import { sql, type SqlTransaction } from "./db.ts";
import { applySnapshots, nextReadRevision } from "./document-versions.ts";
import { ouraUserFetch, ReconnectRequired } from "./oura-auth.ts";

type Job = {
  revision: string;
  generation: string;
  start_day: string;
  end_day: string;
  next_token: string | null;
};

export async function queueHistoryImport(tx: SqlTransaction, ownerId: string) {
  // Use explicit bounds so the request includes the earliest ring history.
  // Extend past both today's latest local date and an exclusive end boundary.
  await tx`
    insert into oura_private.import_jobs (owner_id, collection, start_day, end_day)
    select ${ownerId}, collection, date '2015-01-01', current_date + 2
    from unnest(${
    tx.array(collections.map(({ name }) => name))
  }::text[]) as collection
    on conflict (owner_id, collection) do nothing
  `;
}

export async function getConnectionStatus(ownerId: string) {
  const [status] = await sql()`
    select connections.status as connection, connections.connected_at,
           import_jobs.status as import_status, import_jobs.pages_imported,
           import_jobs.updated_at as import_updated_at
    from oura_private.connections
    left join oura_private.import_jobs on import_jobs.owner_id = connections.owner_id
      and import_jobs.collection = 'daily_sleep'
    where connections.owner_id = ${ownerId}
  `;
  return {
    connection: status?.connection ?? "disconnected",
    connected_at: status?.connected_at ?? null,
    history: status?.import_status
      ? {
        status: status.import_status,
        pages_imported: status.pages_imported,
        updated_at: status.import_updated_at,
      }
      : null,
  };
}

export async function runHistoryImport(
  ownerId: string,
  pageLimit = 5,
  scheduled = false,
) {
  for (const collection of collections) {
    await importCollection(ownerId, collection, pageLimit, scheduled);
  }
  return await getConnectionStatus(ownerId);
}

async function importCollection(
  ownerId: string,
  collection: Collection,
  pageLimit: number,
  scheduled: boolean,
) {
  for (let page = 0; page < pageLimit; page++) {
    const [job] = await sql()<Job[]>`
      select jobs.revision, connections.generation, jobs.start_day::text, jobs.end_day::text, jobs.next_token
      from oura_private.import_jobs jobs
      join oura_private.connections using (owner_id)
      where owner_id = ${ownerId} and collection = ${collection.name}
        and connections.status = 'connected' and jobs.status <> 'complete'
        and (not ${scheduled} or jobs.available_at <= now())
    `;
    if (!job) break;

    try {
      const params = new URLSearchParams({
        start_date: job.start_day,
        end_date: job.end_day,
        fields: collection.fields,
      });
      if (job.next_token) params.set("next_token", job.next_token);

      const readRevision = await nextReadRevision();
      const response = await ouraUserFetch(
        ownerId,
        `${collectionPath(collection)}?${params}`,
      );
      if (!response.ok) throw new Error("Oura history request failed.");
      const result = await response.json();
      if (
        !Array.isArray(result?.data) ||
        (result.next_token !== null &&
          (typeof result.next_token !== "string" || !result.next_token ||
            result.next_token === job.next_token))
      ) {
        throw new Error("Invalid Oura history page.");
      }
      const records = new Map<string, OuraRecord>();
      for (const document of result.data) {
        const record = collection.parse(document);
        records.set(record.document_id, record);
      }

      await sql().begin(async (tx) => {
        const [connection] = await tx`
          select generation, status from oura_private.connections where owner_id = ${ownerId}
          for no key update
        `;
        if (
          connection?.generation !== job.generation ||
          connection.status !== "connected"
        ) return;

        const updated = await tx`
          update oura_private.import_jobs
          set revision = gen_random_uuid(), next_token = ${result.next_token},
              status = ${
          result.next_token ? "pending" : "complete"
        }, available_at = now(),
              pages_imported = pages_imported + 1, updated_at = now()
          where owner_id = ${ownerId} and collection = ${collection.name} and revision = ${job.revision}
        `;
        if (updated.count === 0) return;

        await applySnapshots(tx, ownerId, collection, readRevision, records);
      });
    } catch (error) {
      if (error instanceof ReconnectRequired) break;
      await sql()`
        update oura_private.import_jobs
        set status = 'retryable', updated_at = now(), available_at = now() + interval '1 minute'
        where owner_id = ${ownerId} and collection = ${collection.name} and revision = ${job.revision}
      `;
      break;
    }
  }
}
