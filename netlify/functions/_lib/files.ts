// Shared by the functions that list or delete files.
import { db } from './db.ts';
import { chunkKeys, deleteKeys } from './blobs.ts';

export const FILE_COLS = `f.id, f.kind, f.template_id, f.job_id, f.file_name, f.file_type, f.size_bytes::float8 as size_bytes,
  f.chunk_count, f.upload_status, f.uploaded_by, f.uploaded_by_name, f.created_at`;

/** Removes files' rows and their stored pieces. */
export async function purgeFiles(files: { id: string; chunk_count: number }[]): Promise<void> {
  if (!files.length) return;
  await db().pool.query(`delete from files where id = any($1::uuid[])`, [files.map((f) => f.id)]);
  await deleteKeys(files.flatMap((f) => chunkKeys(f.id, f.chunk_count)));
}
