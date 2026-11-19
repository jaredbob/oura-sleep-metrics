import type { Collection, OuraRecord } from "./collection.ts";

type HrvSeries = {
  started_at: string;
  interval_seconds: number;
  items: (number | null)[];
};

type SleepSession = {
  bedtime_start: string;
  bedtime_end: string;
  total_sleep_duration: number | null;
  average_hrv: number | null;
  hrv: HrvSeries | null;
};

type SleepRecord = OuraRecord & { session: SleepSession | null };

const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const timestampPattern = /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/;
const otherSleepTypes = ["sleep", "late_nap", "rest", "deleted"];

export const sleep: Collection<SleepRecord> = {
  name: "sleep",
  fields:
    "id,day,type,bedtime_start,bedtime_end,total_sleep_duration,average_hrv,hrv",
  parse,
  async upsert(tx, ownerId, records) {
    // Clear corrected samples and remove any session Oura has reclassified.
    await tx`
      delete from oura_private.sleep_sessions
      where owner_id = ${ownerId}
        and document_id = any(${
      tx.array(records.map(({ document_id }) => document_id))
    }::text[])
    `;

    const sessions = records.flatMap(({ session, ...record }) =>
      session ? [{ ...record, ...session, owner_id: ownerId }] : []
    );
    if (sessions.length === 0) return;

    await tx`
      insert into oura_private.sleep_sessions
      ${
      tx(
        sessions,
        "owner_id",
        "document_id",
        "day",
        "bedtime_start",
        "bedtime_end",
        "total_sleep_duration",
        "average_hrv",
      )
    }
    `;

    const series = sessions.flatMap(({ document_id, hrv }) =>
      hrv ? [{ document_id, ...hrv }] : []
    );
    if (series.length === 0) return;

    await tx`
      insert into public.oura_hrv_samples
        (owner_id, sleep_session_document_id, sample_index, sampled_at, hrv)
      select ${ownerId}, source.document_id, sample.position - 1,
             source.started_at + (sample.position - 1) * source.interval_seconds * interval '1 second',
             sample.value
      from jsonb_to_recordset(${tx.json(series)})
        as source (document_id text, started_at timestamptz, interval_seconds double precision, items double precision[])
      cross join lateral unnest(source.items) with ordinality as sample (value, position)
    `;
  },
  async remove(tx, ownerId, documentId) {
    await tx`
      delete from oura_private.sleep_sessions
      where owner_id = ${ownerId} and document_id = ${documentId}
    `;
  },
};

function parse(value: unknown): SleepRecord {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid Oura Sleep Session document.");
  }
  const {
    id,
    day,
    type,
    bedtime_start,
    bedtime_end,
    total_sleep_duration,
    average_hrv,
    hrv,
  } = value as Record<string, unknown>;
  if (
    typeof id !== "string" || !id || typeof day !== "string" ||
    !datePattern.test(day)
  ) {
    throw new Error("Invalid Oura Sleep Session document.");
  }
  if (
    type == null || (typeof type === "string" && otherSleepTypes.includes(type))
  ) {
    return { document_id: id, day, session: null };
  }
  if (
    type !== "long_sleep" ||
    !isTimestamp(bedtime_start) || !isTimestamp(bedtime_end) ||
    (total_sleep_duration != null &&
      (typeof total_sleep_duration !== "number" ||
        !Number.isInteger(total_sleep_duration) || total_sleep_duration < 0)) ||
    (average_hrv != null &&
      (typeof average_hrv !== "number" || !Number.isInteger(average_hrv)))
  ) {
    throw new Error("Invalid Oura Sleep Session document.");
  }
  return {
    document_id: id,
    day,
    session: {
      bedtime_start,
      bedtime_end,
      total_sleep_duration: total_sleep_duration ?? null,
      average_hrv: average_hrv ?? null,
      hrv: hrv == null ? null : parseHrv(hrv),
    },
  };
}

function parseHrv(value: unknown): HrvSeries {
  if (typeof value !== "object" || value === null) {
    throw new Error("Invalid Oura HRV series.");
  }
  const { timestamp, interval, items } = value as Record<string, unknown>;
  if (
    !isTimestamp(timestamp) || typeof interval !== "number" ||
    !Number.isFinite(interval) || interval <= 0 || !Array.isArray(items) ||
    !items.every((item) =>
      item === null || (typeof item === "number" && Number.isFinite(item))
    )
  ) {
    throw new Error("Invalid Oura HRV series.");
  }
  return { started_at: timestamp, interval_seconds: interval, items };
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && timestampPattern.test(value) &&
    Number.isFinite(Date.parse(value));
}
