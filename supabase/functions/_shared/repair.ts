import {
  type Collection,
  collectionPath,
  isDay,
  type OuraRecord,
} from "./collection.ts";
import {
  InvalidCursor,
  type PageCursor,
  readCollectionPage,
} from "./collection-page.ts";
import { collections } from "./collections.ts";
import { sql, type SqlTransaction } from "./db.ts";
import {
  applyMissingDocument,
  applySnapshots,
  nextReadRevision,
} from "./document-versions.ts";
import { HttpError } from "./http.ts";
import {
  ConsentRequired,
  ouraUserFetch,
  ReconnectRequired,
} from "./oura-auth.ts";

type RepairJob = PageCursor & {
  run_id: string;
  collection: string;
  generation: string;
  lease: string;
  start_day: string;
  end_day: string;
  provider_end_day: string;
  document_id: string | null;
};

type JobStatus = {
  start_day: string;
  end_day: string;
  collection: string;
  status: "pending" | "retryable" | "complete";
  listed: boolean;
  pages_imported: number;
  documents_checked: number;
  retry_reason: string | null;
  updated_at: Date;
};

export async function requestRepair(ownerId: string, req: Request) {
  const range = await req.json().catch(() => null);
  const start = range?.start_day;
  const end = range?.end_day;
  if (!isDay(start) || !isDay(end) || start > end) {
    throw new HttpError(
      400,
      "Use an ordered range of calendar dates in YYYY-MM-DD format.",
    );
  }

  const runId = await sql().begin(async (tx) => {
    const [connection] = await tx`
      select status from oura_private.connections
      where owner_id = ${ownerId}
      for no key update
    `;
    if (connection?.status !== "connected") {
      throw new HttpError(
        409,
        "Connect or reconnect Oura before repairing a date range.",
      );
    }
    const [active] = await tx<{ id: string }[]>`
      select runs.id::text from oura_private.repair_runs runs
      where runs.owner_id = ${ownerId}
        and runs.start_day = ${start}::date and runs.end_day = ${end}::date
        and exists (
          select 1 from oura_private.repair_jobs jobs
          where jobs.run_id = runs.id and jobs.status <> 'complete'
        )
      order by runs.id desc
      limit 1
    `;
    if (active) {
      await tx`
        update oura_private.repair_jobs set available_at = now()
        where run_id = ${active.id}::bigint and status = 'retryable' and lease is null
      `;
      return active.id;
    }
    const [run] = await tx<{ id: string }[]>`
      insert into oura_private.repair_runs (owner_id, start_day, end_day)
      values (${ownerId}, ${start}::date, ${end}::date)
      returning id::text
    `;
    await tx`
      insert into oura_private.repair_jobs (run_id, collection)
      select ${run.id}::bigint, collection
      from unnest(${
      tx.array(collections.map(({ name }) => name))
    }::text[]) as collection
    `;
    return run.id;
  });

  await runRepairWork(ownerId, runId);
  return { repair: await repairStatus(ownerId, runId) };
}

export async function repairStatus(ownerId: string, runId?: string) {
  const jobs = await sql()<JobStatus[]>`
    select runs.start_day::text, runs.end_day::text, jobs.collection,
           jobs.status, jobs.listed, jobs.pages_imported, jobs.documents_checked,
           jobs.retry_reason, jobs.updated_at
    from oura_private.repair_runs runs
    join oura_private.repair_jobs jobs on jobs.run_id = runs.id
    where runs.owner_id = ${ownerId} and runs.id = coalesce(${
    runId ?? null
  }::bigint, (
      select id from oura_private.repair_runs
      where owner_id = ${ownerId}
      order by id desc
      limit 1
    ))
    order by jobs.collection
  `;
  if (jobs.length === 0) return null;
  return {
    start_day: jobs[0].start_day,
    end_day: jobs[0].end_day,
    status: jobs.some((job) => job.status === "retryable")
      ? "retryable"
      : jobs.every((job) => job.status === "complete")
      ? "complete"
      : "pending",
    collections: Object.fromEntries(jobs.map((job) => [
      job.collection,
      {
        status: job.status,
        phase: job.status === "complete"
          ? "complete"
          : job.listed
          ? "checking"
          : "listing",
        pages_imported: job.pages_imported,
        documents_checked: job.documents_checked,
        retry_reason: job.retry_reason,
        updated_at: job.updated_at,
      },
    ])),
  };
}

export async function runRepairWork(ownerId: string, runId?: string) {
  const deadline = Date.now() + 8_000;
  // Allow a page per collection and keep the same room for follow-up steps.
  const stepLimit = collections.length + 8;
  for (let count = 0; count < stepLimit && Date.now() < deadline; count++) {
    const job = await claimJob(ownerId, runId);
    if (!job) break;
    const collection = collections.find(({ name }) => name === job.collection)!;
    try {
      const revision = await nextReadRevision(ownerId);
      if (job.document_id !== null) {
        await checkDocument(
          ownerId,
          collection,
          job,
          revision,
          job.document_id,
        );
      } else {
        await repairPage(ownerId, collection, job, revision);
      }
    } catch (error) {
      await failJob(job, error);
    }
  }
}

async function claimJob(
  ownerId: string,
  runId?: string,
): Promise<RepairJob | undefined> {
  const [job] = await sql()<RepairJob[]>`
    with pending as (
      select jobs.run_id, jobs.collection, connections.generation,
             runs.start_day::text, runs.end_day::text,
             least(runs.end_day + 1, date '9999-12-31')::text as provider_end_day,
             case when jobs.listed then (
               select document_id from oura_private.repair_documents documents
               where documents.run_id = jobs.run_id and documents.collection = jobs.collection
                 and documents.needs_check
               order by document_id
               limit 1
             ) end as document_id
      from oura_private.repair_jobs jobs
      join oura_private.repair_runs runs on runs.id = jobs.run_id
      join oura_private.connections connections on connections.owner_id = runs.owner_id
      where runs.owner_id = ${ownerId}
        and (${runId ?? null}::bigint is null or runs.id = ${
    runId ?? null
  }::bigint)
        and connections.status = 'connected'
        and jobs.status <> 'complete' and jobs.available_at <= now()
      order by jobs.available_at, jobs.run_id, jobs.collection
      for update of jobs skip locked
      limit 1
    )
    update oura_private.repair_jobs jobs
    set available_at = now() + interval '1 minute', lease = gen_random_uuid()
    from pending
    where jobs.run_id = pending.run_id and jobs.collection = pending.collection
    returning jobs.run_id::text, jobs.collection, jobs.lease, jobs.next_token, jobs.page_tokens,
              pending.generation, pending.start_day, pending.end_day, pending.provider_end_day, pending.document_id
  `;
  return job;
}

async function repairPage(
  ownerId: string,
  collection: Collection,
  job: RepairJob,
  revision: string,
) {
  const { records: page, nextToken, pageTokens } = await readCollectionPage(
    ownerId,
    collection,
    job.start_day,
    job.provider_end_day,
    job,
  );

  const records = new Map<string, OuraRecord>();
  for (const record of page) {
    if (record.day < job.start_day || record.day > job.end_day) continue;
    // A non-Main Sleep Session may remove a local record. Confirm it directly
    // after finishing the listing, alongside any other omitted local IDs.
    if (collection.shouldStore?.(record) !== false) {
      records.set(record.document_id, record);
    }
  }
  await completeStep(ownerId, job, async (tx) => {
    await applySnapshots(tx, ownerId, collection, revision, records);
    if (records.size) {
      await tx`
        insert into oura_private.repair_documents (run_id, collection, document_id)
        select ${job.run_id}::bigint, ${job.collection}, document_id
        from unnest(${tx.array([...records.keys()])}::text[]) as document_id
        on conflict do nothing
      `;
    }
    if (nextToken === null) {
      await queueMissingDocuments(tx, ownerId, collection, job);
    }
    await tx`
      update oura_private.repair_jobs
      set next_token = ${nextToken}, listed = ${nextToken === null},
          page_tokens = ${tx.array(pageTokens)}::text[],
          pages_imported = pages_imported + 1,
          status = case when ${nextToken === null} and not exists (
            select 1 from oura_private.repair_documents documents
            where documents.run_id = repair_jobs.run_id and documents.collection = repair_jobs.collection
              and documents.needs_check
          ) then 'complete' else 'pending' end
      where run_id = ${job.run_id}::bigint and collection = ${job.collection}
    `;
  });
}

async function queueMissingDocuments(
  tx: SqlTransaction,
  ownerId: string,
  collection: Collection,
  job: RepairJob,
) {
  await tx`
    insert into oura_private.repair_documents (run_id, collection, document_id, needs_check)
    select ${job.run_id}::bigint, ${job.collection}, source.document_id, true
    from ${tx(collection.sourceTable)} source
    where source.owner_id = ${ownerId} and source.day between ${job.start_day}::date and ${job.end_day}::date
    on conflict do nothing
  `;
  await tx`
    delete from oura_private.repair_documents
    where run_id = ${job.run_id}::bigint and collection = ${job.collection} and not needs_check
  `;
}

async function checkDocument(
  ownerId: string,
  collection: Collection,
  job: RepairJob,
  revision: string,
  documentId: string,
) {
  const response = await ouraUserFetch(
    ownerId,
    collectionPath(collection, documentId),
    collection.scope,
  );
  let record: OuraRecord | null = null;
  if (response.ok) {
    record = collection.parse(await response.json());
    if (record.document_id !== documentId || !isDay(record.day)) {
      throw new Error("Invalid Oura document response.");
    }
  } else {
    await response.body?.cancel();
    if (response.status !== 404 && response.status !== 410) {
      throw new Error("Oura document check failed.");
    }
  }

  await completeStep(ownerId, job, async (tx) => {
    if (record) {
      await applySnapshots(
        tx,
        ownerId,
        collection,
        revision,
        new Map([[documentId, record]]),
      );
    } else {
      await applyMissingDocument(tx, ownerId, collection, revision, documentId);
    }
    await tx`
      delete from oura_private.repair_documents
      where run_id = ${job.run_id}::bigint and collection = ${job.collection} and document_id = ${documentId}
    `;
    await tx`
      update oura_private.repair_jobs
      set documents_checked = documents_checked + 1,
          status = case when exists (
            select 1 from oura_private.repair_documents documents
            where documents.run_id = repair_jobs.run_id and documents.collection = repair_jobs.collection
          ) then 'pending' else 'complete' end
      where run_id = ${job.run_id}::bigint and collection = ${job.collection}
    `;
  });
}

async function completeStep(
  ownerId: string,
  job: RepairJob,
  apply: (tx: SqlTransaction) => Promise<void>,
) {
  await sql().begin(async (tx) => {
    const [connection] = await tx`
      select generation, status from oura_private.connections
      where owner_id = ${ownerId} for no key update
    `;
    if (
      connection?.generation !== job.generation ||
      connection.status !== "connected"
    ) {
      throw new ReconnectRequired();
    }
    const saved = await tx`
      update oura_private.repair_jobs
      set lease = null, available_at = now(), retry_reason = null, updated_at = now()
      where run_id = ${job.run_id}::bigint and collection = ${job.collection} and lease = ${job.lease}
    `;
    if (saved.count) await apply(tx);
  });
}

async function failJob(job: RepairJob, error: unknown) {
  const reset = error instanceof InvalidCursor;
  const retryReason = error instanceof ReconnectRequired
    ? "connection_changed"
    : error instanceof ConsentRequired
    ? "consent_required"
    : reset
    ? "pagination_restarted"
    : job.document_id !== null
    ? "document_check_failed"
    : "list_request_failed";
  await sql().begin(async (tx) => {
    const changed = await tx`
      update oura_private.repair_jobs
      set lease = null, status = 'retryable', retry_reason = ${retryReason},
          updated_at = now(), available_at = now() + interval '1 minute',
          next_token = case when ${reset} then null else next_token end,
          page_tokens = case when ${reset} then '{}' else page_tokens end,
          pages_imported = case when ${reset} then 0 else pages_imported end
      where run_id = ${job.run_id}::bigint and collection = ${job.collection} and lease = ${job.lease}
    `;
    if (reset && changed.count) {
      await tx`
        delete from oura_private.repair_documents
        where run_id = ${job.run_id}::bigint and collection = ${job.collection}
      `;
    }
  });
}
