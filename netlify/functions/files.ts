// Files travel in pieces: Netlify functions take about 6 MB per request, and documents can be far bigger.
//   POST /api/files/begin            { kind, job_id | template_id, file_name, size_bytes } -> { file }
//   POST /api/files/:id/chunk        { index, dataB64 }   (the uploader only, while uploading)
//   POST /api/files/:id/commit       checks every piece arrived; a template's new file replaces its old one
//   GET  /api/files/:id              the file's details
//   GET  /api/files/:id/chunk/:n     one piece's bytes (anyone signed in, once the file is ready)
//   DELETE /api/files/:id            the uploader or an admin (a template's file: admins only)
import type { Context } from '@netlify/functions';
import { atLeast, requireRole, requireUser } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { int, oneOf, reqStr, uuid } from './_lib/validate.ts';
import { exists, getBytes, keys, putBytes, sleep } from './_lib/blobs.ts';
import { FILE_COLS, purgeFiles } from './_lib/files.ts';
import { CHUNK_BYTES, FILE_TYPES, fileTypeOf, limitMessages, magicMatches, maxFileBytes, type FileType } from './_lib/limits.ts';
import type { FileRow } from '../../shared/types.ts';

const q = (text: string, params?: unknown[]) => db().pool.query(text, params);

async function loadFile(id: string): Promise<FileRow> {
  const f = (await q(`select ${FILE_COLS} from files f where f.id = $1`, [id])).rows[0];
  if (!f) throw notFound('That file');
  return f as FileRow;
}

export default handle(async (req: Request, _ctx: Context) => {
  const seg = segments(req);   // ['files', id|'begin', action, n]
  const second = seg[1];

  if (second === 'begin' && req.method === 'POST') {
    const b = await readJson(req);
    const kind = oneOf(b.kind, ['template', 'source', 'output'] as const, 'File kind');
    const a = await requireRole(kind === 'template' ? 'admin' : 'member');
    const name = reqStr(b.file_name, 'File name', 255);
    const type = fileTypeOf(name);
    const use = kind === 'template' ? 'template' : 'source';
    if (!type || (kind !== 'output' && !FILE_TYPES[type][use])) throw new HttpError(400, limitMessages.badType(use));
    const size = int(b.size_bytes, 'File size', 1, Number.MAX_SAFE_INTEGER);
    const max = maxFileBytes();
    if (size > max) throw new HttpError(413, limitMessages.tooBig(size, max));
    let templateId: string | null = null, jobId: string | null = null;
    if (kind === 'template') {
      templateId = uuid(b.template_id, 'template id');
      if (!(await q(`select 1 from templates where id = $1 and archived_at is null`, [templateId])).rows[0]) throw notFound('That template');
    } else {
      jobId = uuid(b.job_id, 'job id');
      if (!(await q(`select 1 from jobs where id = $1 and archived_at is null`, [jobId])).rows[0]) throw notFound('That job');
    }
    const row = (await q(
      `insert into files (kind, template_id, job_id, file_name, file_type, size_bytes, chunk_count, uploaded_by, uploaded_by_name)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
      [kind, templateId, jobId, name, type, size, Math.ceil(size / CHUNK_BYTES), a.id, a.name],
    )).rows[0];
    return json({ file: await loadFile(row.id) }, 201);
  }

  if (!second) throw new HttpError(404, 'That address was not found.');
  const id = uuid(second, 'file id');
  const action = seg[2];

  if (action === 'chunk' && req.method === 'POST') {
    const a = await requireUser();
    const f = await loadFile(id);
    if (f.uploaded_by !== a.id) throw new HttpError(403, 'Only the person uploading this file can send its pieces.');
    if (f.upload_status !== 'uploading') throw new HttpError(409, 'This upload is no longer accepting data.');
    const b = await readJson(req);
    const index = int(b.index, 'Piece number', 0, f.chunk_count - 1);
    if (typeof b.dataB64 !== 'string' || b.dataB64.length > Math.ceil((CHUNK_BYTES * 4) / 3) + 16) throw new HttpError(400, 'That piece of the file is not valid.');
    const bytes = Buffer.from(b.dataB64, 'base64');
    if (bytes.length === 0 || bytes.length > CHUNK_BYTES) throw new HttpError(400, 'That piece of the file is empty or too large.');
    if (index === 0 && !magicMatches(f.file_type as FileType, bytes.subarray(0, 8))) {
      throw new HttpError(400, limitMessages.notWhatItSays(FILE_TYPES[f.file_type as FileType].label));
    }
    await putBytes(keys.chunk(f.id, index), bytes, 'application/octet-stream');
    return json({ ok: true });
  }

  if (action === 'commit' && req.method === 'POST') {
    const a = await requireUser();
    const f = await loadFile(id);
    if (f.uploaded_by !== a.id) throw new HttpError(403, 'Only the person uploading this file can finish it.');
    if (f.upload_status === 'ready') return json({ file: f });
    // Blob writes can take a moment to show up: look a few times before calling a piece missing.
    let missing: number[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      missing = [];
      for (let n = 0; n < f.chunk_count; n++) if (!(await exists(keys.chunk(f.id, n)))) missing.push(n);
      if (!missing.length) break;
      await sleep(400 * (attempt + 1));
    }
    if (missing.length) throw new HttpError(409, `Part of the file didn't arrive (${missing.length} of ${f.chunk_count} pieces). Upload it again.`);
    await q(`update files set upload_status = 'ready' where id = $1`, [f.id]);
    if (f.kind === 'template') {
      // A template keeps one current file: the new one replaces the old.
      const old = (await q(`select f.id, f.chunk_count from files f join templates t on t.file_id = f.id where t.id = $1 and f.id <> $2`, [f.template_id, f.id])).rows;
      await q(`update templates set file_id = $2, updated_at = now() where id = $1`, [f.template_id, f.id]);
      await purgeFiles(old);
    }
    if (f.job_id) await q(`update jobs set updated_at = now() where id = $1`, [f.job_id]);
    return json({ file: await loadFile(f.id) });
  }

  if (!action && req.method === 'GET') {
    await requireUser();
    return json({ file: await loadFile(id) });
  }

  if (action === 'chunk' && req.method === 'GET') {
    await requireUser();
    const f = await loadFile(id);
    if (f.upload_status !== 'ready') throw new HttpError(409, 'This file is still uploading.');
    const n = int(Number(seg[3]), 'Piece number', 0, f.chunk_count - 1);
    const bytes = await getBytes(keys.chunk(f.id, n));
    if (!bytes) throw notFound('That part of the file');
    return new Response(bytes, { headers: { 'content-type': 'application/octet-stream', 'cache-control': 'private, max-age=3600' } });
  }

  if (!action && req.method === 'DELETE') {
    const a = await requireUser();
    let f: FileRow;
    try { f = await loadFile(id); } catch (e) { if (e instanceof HttpError && e.status === 404) return json({ ok: true }); throw e; }   // already gone is success
    const mayDelete = f.kind === 'template' ? atLeast(a, 'admin') : f.uploaded_by === a.id || atLeast(a, 'admin');
    if (!mayDelete) throw new HttpError(403, f.kind === 'template' ? 'Only an admin can remove a template file.' : 'Only the person who uploaded this file, or an admin, can delete it.');
    await purgeFiles([f]);
    if (f.job_id) await q(`update jobs set updated_at = now() where id = $1`, [f.job_id]);
    return json({ ok: true });
  }

  throw methodNotAllowed();
});
