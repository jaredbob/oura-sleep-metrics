import { sql, type SqlTransaction } from "./db.ts";
import { ouraUserFetch, ReconnectRequired } from "./oura-auth.ts";

type Job = {
  revision: string;
  generation: string;
  start_day: string;
  end_day: string;
  next_token: string | null;
  status: "pending" | "retryable" | "complete";
};

type DailySleepRecord = {
  owner_id: string;
  document_id: string;
  day: string;
  reported_at: string;
  sleep_score: number | null;
};

const dailySleepPath = "/v2/usercollection/daily_sleep";
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

export async function queueHistoryImport(tx: SqlTransaction, ownerId: string) {
  // Use explicit bounds so the request includes the earliest ring history.
  // Extend past both today's latest local date and an exclusive end boundary.
  await tx`
    insert into oura_private.import_jobs (owner_id, collection, start_day, end_day)
    values (${ownerId}, 'daily_sleep', date '2015-01-01', current_date + 2)
    on conflict (owner_id, collection) do nothing
  `;
}

export async function getConnectionStatus(ownerId: string) {
  const [status] = await sql()`
    select connections.status as connection, connections.connected_at,
           import_jobs.status as import_status, import_jobs.pages_imported,
           import_jobs.updated_at as import_updated_at
    from oura_private.connections
    left join oura_private.import_jobs using (owner_id)
    where owner_id = ${ownerId}
      and (import_jobs.collection = 'daily_sleep' or import_jobs.collection is null)
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

export async function runHistoryImport(ownerId: string, pageLimit = 5) {
  for (let page = 0; page < pageLimit; page++) {
    const [job] = await sql()<Job[]>`
      select jobs.revision, connections.generation, jobs.start_day::text, jobs.end_day::text,
             jobs.next_token, jobs.status
      from oura_private.import_jobs jobs
      join oura_private.connections using (owner_id)
      where owner_id = ${ownerId} and collection = 'daily_sleep'
        and connections.status = 'connected'
    `;
    if (!job || job.status === "complete") break;

    try {
      const params = new URLSearchParams({
        start_date: job.start_day,
        end_date: job.end_day,
        fields: "id,day,timestamp,score",
      });
      if (job.next_token) params.set("next_token", job.next_token);

      const response = await ouraUserFetch(
        ownerId,
        `${dailySleepPath}?${params}`,
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
      const records = new Map<string, DailySleepRecord>();
      for (const document of result.data) {
        const record = dailySleepRecord(ownerId, document);
        records.set(record.document_id, record);
      }

      await sql().begin(async (tx) => {
        const [connection] = await tx`
          select generation, status from oura_private.connections where owner_id = ${ownerId}
          for update
        `;
        if (
          connection?.generation !== job.generation ||
          connection.status !== "connected"
        ) return;

        const updated = await tx`
          update oura_private.import_jobs
          set revision = gen_random_uuid(), next_token = ${result.next_token},
              status = ${result.next_token ? "pending" : "complete"},
              pages_imported = pages_imported + 1, updated_at = now()
          where owner_id = ${ownerId} and collection = 'daily_sleep' and revision = ${job.revision}
        `;
        if (updated.count === 0) return;

        if (records.size > 0) {
          await tx`
            insert into public.oura_daily_sleep
            ${
            tx(
              [...records.values()],
              "owner_id",
              "document_id",
              "day",
              "reported_at",
              "sleep_score",
            )
          }
            on conflict (owner_id, document_id) do update
            set day = excluded.day, reported_at = excluded.reported_at, sleep_score = excluded.sleep_score
          `;
        }
      });
    } catch (error) {
      if (error instanceof ReconnectRequired) break;
      await sql()`
        update oura_private.import_jobs
        set status = 'retryable', updated_at = now()
        where owner_id = ${ownerId} and collection = 'daily_sleep' and revision = ${job.revision}
      `;
      break;
    }
  }
  return await getConnectionStatus(ownerId);
}

export function dailySleepRecord(
  ownerId: string,
  value: unknown,
): DailySleepRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid Sleep Score document.");
  }
  const { id, day, timestamp, score } = value as Record<string, unknown>;
  if (
    typeof id !== "string" || !id ||
    typeof day !== "string" || !datePattern.test(day) ||
    typeof timestamp !== "string" || !timestampPattern.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    (score != null &&
      (typeof score !== "number" || !Number.isInteger(score) || score < 0 ||
        score > 100))
  ) {
    throw new Error("Invalid Sleep Score document.");
  }
  return {
    owner_id: ownerId,
    document_id: id,
    day,
    reported_at: timestamp,
    sleep_score: score ?? null,
  };
}
