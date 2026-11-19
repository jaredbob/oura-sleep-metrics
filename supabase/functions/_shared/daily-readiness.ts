import type { Collection, OuraRecord } from "./collection.ts";

type DailyReadinessRecord = OuraRecord & {
  reported_at: string;
  readiness_score: number | null;
  temperature_deviation_c: number | null;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;

export const dailyReadiness: Collection<DailyReadinessRecord> = {
  name: "daily_readiness",
  fields: "id,day,timestamp,score,temperature_deviation",
  parse,
  async upsert(tx, ownerId, records) {
    await tx`
      insert into public.oura_daily_readiness
      ${
      tx(
        records.map((record) => ({ ...record, owner_id: ownerId })),
        "owner_id",
        "document_id",
        "day",
        "reported_at",
        "readiness_score",
        "temperature_deviation_c",
      )
    }
      on conflict (owner_id, document_id) do update
      set day = excluded.day, reported_at = excluded.reported_at,
          readiness_score = excluded.readiness_score,
          temperature_deviation_c = excluded.temperature_deviation_c
    `;
  },
  async remove(tx, ownerId, documentId) {
    await tx`
      delete from public.oura_daily_readiness
      where owner_id = ${ownerId} and document_id = ${documentId}
    `;
  },
};

function parse(value: unknown): DailyReadinessRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid Daily Readiness document.");
  }
  const { id, day, timestamp, score, temperature_deviation } = value as Record<
    string,
    unknown
  >;
  if (
    typeof id !== "string" || !id ||
    typeof day !== "string" || !datePattern.test(day) ||
    typeof timestamp !== "string" || !timestampPattern.test(timestamp) ||
    !Number.isFinite(Date.parse(timestamp)) ||
    (score != null &&
      (typeof score !== "number" || !Number.isInteger(score) || score < 0 ||
        score > 100)) ||
    (temperature_deviation != null &&
      (typeof temperature_deviation !== "number" ||
        !Number.isFinite(temperature_deviation)))
  ) {
    throw new Error("Invalid Daily Readiness document.");
  }
  return {
    document_id: id,
    day,
    reported_at: timestamp,
    readiness_score: score ?? null,
    temperature_deviation_c: temperature_deviation ?? null,
  };
}
