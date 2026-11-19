import type { SqlTransaction } from "./db.ts";

export type OuraRecord = {
  document_id: string;
  day: string;
};

export interface Collection<Record extends OuraRecord = OuraRecord> {
  name: string;
  fields: string;
  sourceTable: string;
  shouldStore?(record: Record): boolean;
  parse(value: unknown): Record;
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
): string {
  const path = `/v2/usercollection/${collection.name}`;
  return documentId === undefined
    ? path
    : `${path}/${encodeURIComponent(documentId)}`;
}
