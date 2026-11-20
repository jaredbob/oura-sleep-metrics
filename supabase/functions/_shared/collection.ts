import type { SqlTransaction } from "./db.ts";
import type { AdditionalScope } from "./oura-auth.ts";

export type OuraRecord = {
  document_id: string;
  day: string;
};

export interface Collection<Record extends OuraRecord = OuraRecord> {
  name: string;
  apiName?: string;
  scope?: AdditionalScope;
  fields?: string;
  sourceTable: string;
  shouldStore?(record: Record): boolean;
  parse(value: unknown): Record;
  parseListed?(value: unknown): Record | null;
  upsert(
    tx: SqlTransaction,
    ownerId: string,
    records: readonly Record[],
  ): Promise<void>;
  remove(
    tx: SqlTransaction,
    ownerId: string,
    documentId: string,
  ): Promise<void>;
}

export function collectionPath(
  collection: Collection,
  documentId?: string,
  params = new URLSearchParams(),
): string {
  const name = collection.apiName ?? collection.name;
  const document = documentId === undefined
    ? ""
    : `/${encodeURIComponent(documentId)}`;
  if (collection.fields) params.set("fields", collection.fields);
  const query = params.size ? `?${params}` : "";
  return `/v2/usercollection/${name}${document}${query}`;
}

export function isDay(value: unknown): value is string {
  if (
    typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith("0000")
  ) {
    return false;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value;
}
