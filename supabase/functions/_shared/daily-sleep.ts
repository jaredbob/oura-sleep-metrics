import type { Collection, OuraRecord } from "./collection.ts";

type DailySleepRecord = OuraRecord & {
  reported_at: string;
  sleep_score: number | null;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

export const dailySleep: Collection<DailySleepRecord> = {
  name: "daily_sleep",
  sourceTable: "public.oura_daily_sleep",
  fields: "id,day,timestamp,score",
  parse,
  async upsert(tx, ownerId, records) {
    await tx`
      insert into public.oura_daily_sleep
      ${
      tx(
        records.map((record) => ({ ...record, owner_id: ownerId })),
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
  },
  async remove(tx, ownerId, documentId) {
    await tx`
      delete from public.oura_daily_sleep
      where owner_id = ${ownerId} and document_id = ${documentId}
    `;
  },
};

function parse(value: unknown): DailySleepRecord {
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
    document_id: id,
    day,
    reported_at: timestamp,
    sleep_score: score ?? null,
  };
}
