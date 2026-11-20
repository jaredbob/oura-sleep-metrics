import { type Collection, isDay, type OuraRecord } from "./collection.ts";

export const enhancedTag = documentCollection({
  name: "enhanced_tag",
  scope: "tag",
  columns: [
    "day",
    "end_day",
    "start_time",
    "end_time",
    "tag_type_code",
    "custom_name",
  ],
  parse(value) {
    const tag = object(value);
    return {
      ...identity(tag.id, tag.start_day),
      end_day: tag.end_day == null ? null : day(tag.end_day),
      start_time: timestamp(tag.start_time, true),
      end_time: tag.end_time == null ? null : timestamp(tag.end_time, true),
      tag_type_code: tag.tag_type_code == null
        ? null
        : string(tag.tag_type_code),
      custom_name: tag.custom_name == null ? null : string(tag.custom_name),
    };
  },
});

export const dailyCardiovascularAge = documentCollection({
  name: "daily_cardiovascular_age",
  scope: "heart_health",
  fields: "day,pulse_wave_velocity,vascular_age",
  columns: ["day", "vascular_age", "pulse_wave_velocity_m_per_s"],
  parse(value) {
    const age = object(value);
    return {
      ...identity(age.id, age.day),
      vascular_age: age.vascular_age == null ? null : integer(age.vascular_age),
      pulse_wave_velocity_m_per_s: age.pulse_wave_velocity == null
        ? null
        : number(age.pulse_wave_velocity),
    };
  },
});

export const vo2Max = documentCollection({
  name: "vo2_max",
  apiName: "vO2_max",
  scope: "heart_health",
  fields: "day,timestamp,vo2_max",
  columns: ["day", "reported_at", "vo2_max_ml_per_kg_min"],
  parse(value) {
    const estimate = object(value);
    return {
      ...identity(estimate.id, estimate.day),
      reported_at: timestamp(estimate.timestamp),
      vo2_max_ml_per_kg_min: integer(estimate.vo2_max),
    };
  },
});

export const dailyStress = documentCollection({
  name: "daily_stress",
  scope: "stress",
  fields: "day,day_summary,stress_high,recovery_high",
  columns: [
    "day",
    "day_summary",
    "stress_high_seconds",
    "recovery_high_seconds",
  ],
  parse(value) {
    const stress = object(value);
    return {
      ...identity(stress.id, stress.day),
      day_summary: stress.day_summary == null
        ? null
        : string(stress.day_summary),
      stress_high_seconds: stress.stress_high == null
        ? null
        : integer(stress.stress_high),
      recovery_high_seconds: stress.recovery_high == null
        ? null
        : integer(stress.recovery_high),
    };
  },
});

export const dailyResilience = documentCollection({
  name: "daily_resilience",
  scope: "stress",
  columns: ["day", "level", "sleep_recovery", "daytime_recovery", "stress"],
  parse(value) {
    const resilience = object(value);
    const contributors = object(resilience.contributors);
    return {
      ...identity(resilience.id, resilience.day),
      level: string(resilience.level),
      sleep_recovery: number(contributors.sleep_recovery),
      daytime_recovery: number(contributors.daytime_recovery),
      stress: number(contributors.stress),
    };
  },
});

type StoredDocument = OuraRecord & Record<string, string | number | null>;

function documentCollection(
  definition:
    & Pick<
      Collection<StoredDocument>,
      "name" | "scope" | "apiName" | "fields" | "parse"
    >
    & {
      columns: string[];
    },
): Collection<StoredDocument> {
  const { columns, ...collection } = definition;
  const sourceTable = `public.oura_${collection.name}`;
  return {
    ...collection,
    sourceTable,
    async upsert(tx, ownerId, records) {
      const rows: Record<string, string | number | null>[] = records.map(
        (record) => ({ ...record, owner_id: ownerId }),
      );
      await tx`
        insert into ${tx(sourceTable)}
        ${tx(rows, "owner_id", "document_id", ...columns)}
        on conflict (owner_id, document_id) do update set
          (${tx(columns)}) = (${
        tx(columns.map((column) => `excluded.${column}`))
      })
      `;
    },
    async remove(tx, ownerId, documentId) {
      await tx`
        delete from ${tx(sourceTable)}
        where owner_id = ${ownerId} and document_id = ${documentId}
      `;
    },
  };
}

function identity(id: unknown, date: unknown): OuraRecord {
  const documentId = string(id);
  if (!documentId) throw invalidDocument();
  return { document_id: documentId, day: day(date) };
}

function day(value: unknown): string {
  if (!isDay(value)) throw invalidDocument();
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidDocument();
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw invalidDocument();
  return value;
}

function number(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidDocument();
  }
  return value;
}

function integer(value: unknown): number {
  const integer = number(value);
  if (
    !Number.isInteger(integer) || integer < -2147483648 || integer > 2147483647
  ) {
    throw invalidDocument();
  }
  return integer;
}

const localTimePattern =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?$/;
const offsetPattern = /(?:Z|[+-]\d{2}:\d{2})$/;

function timestamp(value: unknown, mayBeLocal = false): string {
  const time = string(value);
  const hasOffset = offsetPattern.test(time);
  if (
    !localTimePattern.test(time) || !isDay(time.slice(0, 10)) ||
    (!hasOffset && !mayBeLocal) ||
    !Number.isFinite(Date.parse(hasOffset ? time : time + "Z"))
  ) {
    throw invalidDocument();
  }
  return time;
}

function invalidDocument(): Error {
  return new Error("Invalid Oura document.");
}
