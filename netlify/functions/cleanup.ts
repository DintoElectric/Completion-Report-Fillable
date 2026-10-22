import type { Config } from '@netlify/functions';
import { db } from './_lib/db.ts';
import { purgeFiles } from './_lib/files.ts';
import { RUN_KEEP_MS, RUN_STALE_MS, STALE_UPLOAD_MS } from './_lib/limits.ts';

// Half-finished uploads (a tab closed mid-upload) are removed after an hour.
export default async () => {
  const cutoff = new Date(Date.now() - STALE_UPLOAD_MS).toISOString();
  const stale = (await db().pool.query(`select id, chunk_count from files where upload_status = 'uploading' and created_at < $1::timestamptz`, [cutoff])).rows;
  await purgeFiles(stale);

  // AI runs that never finished are marked failed (and their documents' text dropped); finished runs are deleted after a week.
  const q = (text: string, params?: unknown[]) => db().pool.query(text, params);
  const runCut = new Date(Date.now() - RUN_STALE_MS).toISOString();
  await q(`update fill_runs set status = 'failed', error = 'The AI took too long. Try again.', payload = null, finished_at = now() where status in ('queued', 'running') and created_at < $1::timestamptz`, [runCut]);
  await q(`delete from fill_runs where created_at < $1::timestamptz`, [new Date(Date.now() - RUN_KEEP_MS).toISOString()]);
  return new Response(JSON.stringify({ removed: stale.length }));
};

export const config: Config = { schedule: '@hourly' };
