// Runs one queued fill run. The file name ends in "-background", which tells Netlify to answer the caller at once (202) and
// let this function keep going for up to 15 minutes. It does nothing but claim a queued run by its id and answer it, and
// the answer can only be read through /api/fill/:id, which needs a signed-in user.
import { db } from './_lib/db.ts';
import { HttpError } from './_lib/http.ts';
import { isUuid } from './_lib/validate.ts';
import { askClaude } from './_lib/ai.ts';
import type { FillRequest } from '../../shared/types.ts';

const q = (text: string, params?: unknown[]) => db().pool.query(text, params);

export default async (req: Request) => {
  let runId = '';
  try { const b = (await req.json()) as { run_id?: unknown } | null; if (isUuid(b?.run_id)) runId = b.run_id.toLowerCase(); } catch { /* not a valid call */ }
  if (!runId) return new Response('Not valid.', { status: 400 });

  // Claim it: only one caller can move a run from queued to running.
  const claimed = (await q(`update fill_runs set status = 'running', started_at = now() where id = $1 and status = 'queued' returning payload`, [runId])).rows[0];
  if (!claimed?.payload) return new Response('Nothing to do.', { status: 200 });

  try {
    const proposals = await askClaude(claimed.payload as FillRequest);
    await q(`update fill_runs set status = 'ready', result = $2::jsonb, payload = null, finished_at = now() where id = $1`, [runId, JSON.stringify(proposals)]);
  } catch (e) {
    console.error('Fill run failed', runId, e);
    const message = e instanceof HttpError ? e.message : 'The AI could not read the documents. Try again.';
    await q(`update fill_runs set status = 'failed', error = $2, payload = null, finished_at = now() where id = $1`, [runId, message]);
  }
  return new Response('Done.', { status: 200 });
};
