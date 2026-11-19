import type { Collection, OuraRecord } from "./collection.ts";

type DailySpo2Record = OuraRecord & {
  average_spo2: number | null;
};

const datePattern = /^\d{4}-\d{2}-\d{2}$/;

export const dailySpo2: Collection<DailySpo2Record> = {
  name: "daily_spo2",
  sourceTable: "public.oura_daily_spo2",
  fields: "id,day,spo2_percentage",
  parse,
  async upsert(tx, ownerId, records) {
    await tx`
      insert into public.oura_daily_spo2
      ${
      tx(
        records.map((record) => ({ ...record, owner_id: ownerId })),
        "owner_id",
        "document_id",
        "day",
        "average_spo2",
      )
    }
      on conflict (owner_id, document_id) do update
      set day = excluded.day, average_spo2 = excluded.average_spo2
    `;
  },
  async remove(tx, ownerId, documentId) {
    await tx`
      delete from public.oura_daily_spo2
      where owner_id = ${ownerId} and document_id = ${documentId}
    `;
  },
};

function parse(value: unknown): DailySpo2Record {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid Overnight SpO₂ document.");
  }
  const { id, day, spo2_percentage } = value as Record<string, unknown>;
  const average = (spo2_percentage as { average?: unknown } | null | undefined)
    ?.average;
  if (
    typeof id !== "string" || !id ||
    typeof day !== "string" || !datePattern.test(day) ||
    (spo2_percentage != null &&
      (typeof spo2_percentage !== "object" ||
        Array.isArray(spo2_percentage))) ||
    (average != null &&
      (typeof average !== "number" || !Number.isFinite(average) ||
        average < 0 || average > 100))
  ) {
    throw new Error("Invalid Overnight SpO₂ document.");
  }
  return { document_id: id, day, average_spo2: average ?? null };
}
