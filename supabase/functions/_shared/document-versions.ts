import type { Collection, OuraRecord } from "./collection.ts";
import { sql, type SqlTransaction } from "./db.ts";

export async function nextReadRevision(): Promise<string> {
  const [result] = await sql()<{ revision: string }[]>`
    select nextval('oura_private.document_read_revision')::text as revision
  `;
  return result.revision;
}

// Call within the page/repair transaction after locking the owner's connection.
export async function applySnapshots(
  tx: SqlTransaction,
  ownerId: string,
  collection: Collection,
  revision: string,
  records: ReadonlyMap<string, OuraRecord>,
): Promise<void> {
  if (records.size === 0) return;
  const eligible = await tx<{ document_id: string }[]>`
    insert into oura_private.document_versions (owner_id, collection, document_id, read_revision)
    select ${ownerId}, ${collection.name}, document_id, ${revision}::bigint
    from unnest(${tx.array([...records.keys()])}::text[]) as document_id
    on conflict (owner_id, collection, document_id) do update
    set read_revision = excluded.read_revision
    where not document_versions.deleted and document_versions.read_revision < excluded.read_revision
    returning document_id
  `;
  if (eligible.length > 0) {
    await collection.upsert(
      tx,
      ownerId,
      eligible.map(({ document_id }) => records.get(document_id)!),
    );
  }
}

// Call under the connection lock after Oura confirms the document is absent.
export async function applyMissingDocument(
  tx: SqlTransaction,
  ownerId: string,
  collection: Collection,
  revision: string,
  documentId: string,
): Promise<void> {
  const marked = await tx`
    insert into oura_private.document_versions
      (owner_id, collection, document_id, read_revision, deleted)
    values (${ownerId}, ${collection.name}, ${documentId}, ${revision}::bigint, true)
    on conflict (owner_id, collection, document_id) do update
    set read_revision = excluded.read_revision, deleted = true
    where document_versions.read_revision < excluded.read_revision
    returning document_id
  `;
  if (marked.length) await collection.remove(tx, ownerId, documentId);
}
