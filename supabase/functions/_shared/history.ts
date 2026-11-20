import type { Collection } from "./collection.ts";
import {
  InvalidCursor,
  type PageCursor,
  readCollectionPage,
} from "./collection-page.ts";
import { collections } from "./collections.ts";
import { sql, type SqlTransaction } from "./db.ts";
import { applySnapshots, nextReadRevision } from "./document-versions.ts";
import { ConsentRequired, ReconnectRequired } from "./oura-auth.ts";

type Job = PageCursor & {
  revision: string;
  generation: string;
  start_day: string;
  end_day: string;
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

export async function rewindHistory(
  tx: SqlTransaction,
  ownerId: string,
  collectionNames: string[],
) {
  await tx`
    update oura_private.import_jobs
    set revision = gen_random_uuid(), next_token = null, page_tokens = '{}',
        status = 'pending', pages_imported = 0,
        end_day = greatest(end_day, current_date + 2), updated_at = now(), available_at = now()
    where owner_id = ${ownerId} and collection = any(${
    tx.array(collectionNames)
  }::text[])
  `;
}

export async function runHistoryImport(
  ownerId: string,
  coveredCollections: readonly string[],
  pageLimit = 5,
  scheduled = false,
) {
  for (const collection of collections) {
    if (coveredCollections.includes(collection.name)) {
      await importCollection(ownerId, collection, pageLimit, scheduled);
    }
  }
}

async function importCollection(
  ownerId: string,
  collection: Collection,
  pageLimit: number,
  scheduled: boolean,
) {
  for (let page = 0; page < pageLimit; page++) {
    const [job] = await sql()<Job[]>`
      select jobs.revision, connections.generation, jobs.start_day::text, jobs.end_day::text,
             jobs.next_token, jobs.page_tokens
      from oura_private.import_jobs jobs
      join oura_private.connections using (owner_id)
      where owner_id = ${ownerId} and collection = ${collection.name}
        and connections.status = 'connected' and jobs.status <> 'complete'
        and ${collection.scope ?? ""} <> all(connections.missing_scopes)
        and (not ${scheduled} or jobs.available_at <= now())
    `;
    if (!job) break;

    try {
      const readRevision = await nextReadRevision(ownerId);
      const { records, nextToken, pageTokens } = await readCollectionPage(
        ownerId,
        collection,
        job.start_day,
        job.end_day,
        job,
      );

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
          set revision = gen_random_uuid(), next_token = ${nextToken},
              page_tokens = ${tx.array(pageTokens)}::text[],
              status = ${
          nextToken ? "pending" : "complete"
        }, available_at = now(),
              pages_imported = pages_imported + 1, updated_at = now()
          where owner_id = ${ownerId} and collection = ${collection.name} and revision = ${job.revision}
        `;
        if (updated.count === 0) return;

        await applySnapshots(
          tx,
          ownerId,
          collection,
          readRevision,
          new Map(records.map((record) => [record.document_id, record])),
        );
      });
    } catch (error) {
      if (
        error instanceof ReconnectRequired || error instanceof ConsentRequired
      ) break;
      const reset = error instanceof InvalidCursor;
      await sql()`
        update oura_private.import_jobs
        set status = 'retryable', updated_at = now(), available_at = now() + interval '1 minute',
            revision = case when ${reset} then gen_random_uuid() else revision end,
            next_token = case when ${reset} then null else next_token end,
            page_tokens = case when ${reset} then '{}' else page_tokens end,
            pages_imported = case when ${reset} then 0 else pages_imported end
        where owner_id = ${ownerId} and collection = ${collection.name} and revision = ${job.revision}
          and exists (
            select 1 from oura_private.connections
            where owner_id = ${ownerId} and generation = ${job.generation} and status = 'connected'
          )
      `;
      break;
    }
  }
}
