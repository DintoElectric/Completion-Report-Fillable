// /api/templates            GET list · POST create (admin)
// /api/templates/:id        PATCH rename/describe (admin) · DELETE archive (admin)
import type { Context } from '@netlify/functions';
import { requireRole, requireUser } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { onlyKeys, reqStr, str, uuid } from './_lib/validate.ts';
import { FILE_COLS } from './_lib/files.ts';
import { MAX_NOTE } from './_lib/limits.ts';

const LIST = `
  select t.id, t.name, t.description, t.created_by_name, t.created_at, t.updated_at,
         (select count(*)::int from jobs j where j.template_id = t.id and j.archived_at is null) as job_count,
         (select row_to_json(x) from (select ${FILE_COLS} from files f where f.id = t.file_id and f.upload_status = 'ready') x) as file
    from templates t
   where t.archived_at is null`;

export default handle(async (req: Request, _ctx: Context) => {
  const [, idRaw] = segments(req);
  const q = (text: string, params?: unknown[]) => db().pool.query(text, params);

  if (!idRaw) {
    if (req.method === 'GET') {
      await requireUser();
      return json({ templates: (await q(`${LIST} order by lower(t.name)`)).rows });
    }
    if (req.method === 'POST') {
      const a = await requireRole('admin');
      const b = await readJson(req);
      onlyKeys(b, ['name', 'description']);
      const row = (await q(
        `insert into templates (name, description, created_by, created_by_name) values ($1, $2, $3, $4) returning id`,
        [reqStr(b.name, 'Name'), str(b.description, 'Description', { max: MAX_NOTE }), a.id, a.name],
      )).rows[0];
      return json({ template: (await q(`${LIST} and t.id = $1`, [row.id])).rows[0] }, 201);
    }
    throw methodNotAllowed();
  }

  const id = uuid(idRaw, 'template id');
  if (req.method === 'PATCH') {
    await requireRole('admin');
    const b = await readJson(req);
    onlyKeys(b, ['name', 'description']);
    const sets: string[] = []; const vals: unknown[] = [id];
    if ('name' in b) { vals.push(reqStr(b.name, 'Name')); sets.push(`name = $${vals.length}`); }
    if ('description' in b) { vals.push(str(b.description, 'Description', { max: MAX_NOTE })); sets.push(`description = $${vals.length}`); }
    if (sets.length) await q(`update templates set ${sets.join(', ')}, updated_at = now() where id = $1 and archived_at is null`, vals);
    const t = (await q(`${LIST} and t.id = $1`, [id])).rows[0];
    if (!t) throw notFound('That template');
    return json({ template: t });
  }
  if (req.method === 'DELETE') {
    // Archived, not erased: jobs that used it keep their history; it just leaves the list.
    await requireRole('admin');
    await q(`update templates set archived_at = now() where id = $1 and archived_at is null`, [id]);
    return json({ ok: true });
  }
  throw methodNotAllowed();
});
