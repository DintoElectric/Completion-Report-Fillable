// Fill runs: asking the AI to read a job's documents.
//   POST /api/fill        member: validate the request, store it, answer with the run (status "queued").
//                         The browser then calls /api/fill-background to start it (the AI can take minutes).
//   GET  /api/fill/:id    anyone signed in: the run's status, and its result once ready.
import type { Context } from '@netlify/functions';
import { requireRole, requireUser } from './_lib/auth.ts';
import { db } from './_lib/db.ts';
import { HttpError, handle, json, methodNotAllowed, notFound, readJson, segments } from './_lib/http.ts';
import { uuid } from './_lib/validate.ts';
import { validateFillRequest } from './_lib/fillRequest.ts';
import { RUN_STALE_MS } from './_lib/limits.ts';

const q = (text: string, params?: unknown[]) => db().pool.query(text, params);
const COLS = `id, job_id, status, error, result, created_at, finished_at`;

export default handle(async (req: Request, _ctx: Context) => {
  const [, idRaw] = segments(req);

  if (idRaw) {
    if (req.method !== 'GET') throw methodNotAllowed();
    await requireUser();
    const run = (await q(`select ${COLS} from fill_runs where id = $1`, [uuid(idRaw, 'run id')])).rows[0];
    if (!run) throw notFound('That run');
    return json({ run });
  }

  if (req.method !== 'POST') throw methodNotAllowed();
  const a = await requireRole('member');
  if (!process.env.ANTHROPIC_API_KEY) throw new HttpError(503, 'The AI is not set up yet. An admin needs to add ANTHROPIC_API_KEY in Netlify.');
  const body = validateFillRequest(await readJson(req));
  if (!(await q(`select 1 from jobs where id = $1 and archived_at is null`, [body.job_id])).rows[0]) throw notFound('That job');

  const cutoff = new Date(Date.now() - RUN_STALE_MS).toISOString();
  const busy = (await q(`select 1 from fill_runs where job_id = $1 and status in ('queued', 'running') and created_at > $2::timestamptz`, [body.job_id, cutoff])).rows[0];
  if (busy) throw new HttpError(409, 'The AI is already reading this job\'s documents. Wait for it to finish.');

  const row = (await q(
    `insert into fill_runs (job_id, payload, created_by, created_by_name) values ($1, $2::jsonb, $3, $4) returning ${COLS}`,
    [body.job_id, JSON.stringify(body), a.id, a.name],
  )).rows[0];
  return json({ run: row }, 201);
});
