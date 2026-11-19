import type { Collection, OuraRecord } from "./collection.ts";
import { sql, type SqlTransaction } from "./db.ts";

export async function nextReadRevision(ownerId: string): Promise<string> {
  // Allocate after the connection lock so new reads start on the far side
  // of any authoritative webhook write already committing for this owner.
  const [result] = await sql()<{ revision: string }[]>`
    with owner_lock as materialized (
      select owner_id from oura_private.connections
      where owner_id = ${ownerId} for share
    )
    select nextval('oura_private.document_read_revision')::text as revision
    from owner_lock
  `;
  if (!result) throw new Error("Oura connection is missing.");
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
