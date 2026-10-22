// /api/jobs           GET list · POST create (member)
// /api/jobs/:id       GET detail with files · PATCH (creator or admin) · DELETE with its files (creator or admin)
import type { Context } from '@netlify/functions';
import { atLeast, requireRole, requireUser, type Actor } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { onlyKeys, oneOf, reqStr, str, uuid } from './_lib/validate.ts';
import { FILE_COLS, purgeFiles } from './_lib/files.ts';
import { MAX_NOTE } from './_lib/limits.ts';

const LIST = `
  select j.id, j.name, j.template_id, t.name as template_name, j.status, j.notes, j.created_by, j.created_by_name,
         j.created_at, j.updated_at,
         (select count(*)::int from files f where f.job_id = j.id and f.kind = 'source' and f.upload_status = 'ready') as source_count,
         (select count(*)::int from files f where f.job_id = j.id and f.kind = 'output' and f.upload_status = 'ready') as output_count
    from jobs j left join templates t on t.id = j.template_id
   where j.archived_at is null`;

const q = (text: string, params?: unknown[]) => db().pool.query(text, params);

async function loadJob(id: string) {
  const j = (await q(`${LIST} and j.id = $1`, [id])).rows[0];
  if (!j) throw notFound('That job');
  return j;
}
const canEdit = (a: Actor, job: { created_by: string }) => job.created_by === a.id || atLeast(a, 'admin');

async function templateId(v: unknown): Promise<string | null> {
  if (v === null || v === undefined || v === '') return null;
  const id = uuid(v, 'template id');
  const t = (await q(`select id from templates where id = $1 and archived_at is null`, [id])).rows[0];
  if (!t) throw new HttpError(400, 'That template is no longer available. Pick another.');
  return id;
}

export default handle(async (req: Request, _ctx: Context) => {
  const [, idRaw] = segments(req);

  if (!idRaw) {
    if (req.method === 'GET') {
      await requireUser();
      return json({ jobs: (await q(`${LIST} order by j.updated_at desc`)).rows });
    }
    if (req.method === 'POST') {
      const a = await requireRole('member');
      const b = await readJson(req);
      onlyKeys(b, ['name', 'template_id', 'notes']);
      const row = (await q(
        `insert into jobs (name, template_id, notes, created_by, created_by_name) values ($1, $2, $3, $4, $5) returning id`,
        [reqStr(b.name, 'Name'), await templateId(b.template_id), str(b.notes, 'Notes', { max: MAX_NOTE }), a.id, a.name],
      )).rows[0];
      return json({ job: await loadJob(row.id) }, 201);
    }
    throw methodNotAllowed();
  }

  const id = uuid(idRaw, 'job id');
  if (req.method === 'GET') {
    await requireUser();
    const job = await loadJob(id);
    const files = (await q(`select ${FILE_COLS} from files f where f.job_id = $1 and f.upload_status = 'ready' order by f.created_at desc`, [id])).rows;
    return json({ job: { ...job, files } });
  }
  if (req.method === 'PATCH') {
    const a = await requireRole('member');
    const job = await loadJob(id);
    if (!canEdit(a, job)) throw new HttpError(403, 'Only the person who created this job, or an admin, can change it.');
    const b = await readJson(req);
    onlyKeys(b, ['name', 'template_id', 'notes', 'status']);
    const sets: string[] = []; const vals: unknown[] = [id];
    if ('name' in b) { vals.push(reqStr(b.name, 'Name')); sets.push(`name = $${vals.length}`); }
    if ('template_id' in b) { vals.push(await templateId(b.template_id)); sets.push(`template_id = $${vals.length}`); }
    if ('notes' in b) { vals.push(str(b.notes, 'Notes', { max: MAX_NOTE })); sets.push(`notes = $${vals.length}`); }
    if ('status' in b) { vals.push(oneOf(b.status, ['draft', 'filled'] as const, 'Status')); sets.push(`status = $${vals.length}`); }
    if (sets.length) await q(`update jobs set ${sets.join(', ')}, updated_at = now() where id = $1`, vals);
    return json({ job: await loadJob(id) });
  }
  if (req.method === 'DELETE') {
    const a = await requireRole('member');
    const job = await loadJob(id);
    if (!canEdit(a, job)) throw new HttpError(403, 'Only the person who created this job, or an admin, can delete it.');
    const files = (await q(`select id, chunk_count from files where job_id = $1`, [id])).rows;
    await purgeFiles(files);
    await q(`delete from jobs where id = $1`, [id]);
    return json({ ok: true });
  }
  throw methodNotAllowed();
});
