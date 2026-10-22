// Runs the real migrations against an in-memory Postgres (PGlite) and checks the rules the schema enforces.
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const db = new PGlite();
const dir = 'netlify/database/migrations';
for (const f of readdirSync(dir).sort()) await db.exec(readFileSync(`${dir}/${f}`, 'utf8'));
const one = async (sql, params) => (await db.query(sql, params)).rows[0];

const t = await one(`insert into templates (name, created_by) values ('Pay app', 'u1') returning id`);
const j = await one(`insert into jobs (name, template_id, created_by) values ('October', $1, 'u1') returning id`, [t.id]);
const addFile = (kind, owner, extra = {}) => one(
  `insert into files (kind, template_id, job_id, file_name, file_type, size_bytes, chunk_count, uploaded_by, upload_status)
   values ($1, $2, $3, 'a.pdf', 'pdf', 10, 1, 'u1', $4) returning id`,
  [kind, kind === 'template' ? owner : null, kind === 'template' ? null : owner, extra.status ?? 'ready']);

// a template file belongs to a template; sources and outputs to a job
const tf = await addFile('template', t.id);
const src = await addFile('source', j.id);
await addFile('output', j.id);
await assert.rejects(db.query(`insert into files (kind, job_id, file_name, file_type, size_bytes, chunk_count, uploaded_by) values ('template', $1, 'x.pdf', 'pdf', 1, 1, 'u')`, [j.id]));
await assert.rejects(db.query(`insert into files (kind, template_id, file_name, file_type, size_bytes, chunk_count, uploaded_by) values ('source', $1, 'x.pdf', 'pdf', 1, 1, 'u')`, [t.id]));
await assert.rejects(db.query(`insert into files (kind, job_id, file_name, file_type, size_bytes, chunk_count, uploaded_by) values ('source', $1, 'x.pdf', 'pdf', 0, 1, 'u')`, [j.id]));   // empty file
await assert.rejects(db.query(`insert into jobs (name, status, created_by) values ('x', 'done', 'u')`));                                                                       // unknown status

// a template's current file; removing that file leaves the template without one, not broken
await db.query(`update templates set file_id = $2 where id = $1`, [t.id, tf.id]);
await db.query(`delete from files where id = $1`, [tf.id]);
assert.equal((await one(`select file_id from templates where id = $1`, [t.id])).file_id, null);

// the job list's counts (the same subqueries the jobs function uses)
const row = await one(`select (select count(*)::int from files f where f.job_id = j.id and f.kind = 'source' and f.upload_status = 'ready') as sources,
                              (select count(*)::int from files f where f.job_id = j.id and f.kind = 'output' and f.upload_status = 'ready') as outputs
                         from jobs j where j.id = $1`, [j.id]);
assert.deepEqual(row, { sources: 1, outputs: 1 });

// deleting a job removes its files' rows; archiving a template keeps jobs pointing at it
await db.query(`update templates set archived_at = now() where id = $1`, [t.id]);
assert.equal((await one(`select template_id from jobs where id = $1`, [j.id])).template_id, t.id);
await db.query(`delete from jobs where id = $1`, [j.id]);
assert.equal((await one(`select count(*)::int n from files where job_id = $1`, [j.id])).n, 0);
assert.ok(src.id);
console.log('db.test OK');

// AI fill runs: a run belongs to a job, goes queued -> running -> ready or failed, and goes away with its job
const j2 = await one(`insert into jobs (name, created_by) values ('Fill job', 'u1') returning id`);
const run = await one(`insert into fill_runs (job_id, payload, created_by) values ($1, '{"documents":[]}'::jsonb, 'u1') returning id, status`, [j2.id]);
assert.equal(run.status, 'queued');
// claiming a run only works once: the second claim finds nothing (this is how the background function avoids doing a run twice)
const claim = () => db.query(`update fill_runs set status = 'running', started_at = now() where id = $1 and status = 'queued' returning payload`, [run.id]);
assert.equal((await claim()).rows.length, 1);
assert.equal((await claim()).rows.length, 0);
await db.query(`update fill_runs set status = 'ready', result = '[]'::jsonb, payload = null, finished_at = now() where id = $1`, [run.id]);
assert.equal((await one(`select payload from fill_runs where id = $1`, [run.id])).payload, null);
await assert.rejects(db.query(`insert into fill_runs (job_id, status, created_by) values ($1, 'done', 'u1')`, [j2.id]));          // unknown status
await assert.rejects(db.query(`insert into fill_runs (job_id, created_by) values ('00000000-0000-4000-8000-000000000000', 'u1')`)); // no such job
// stale runs are marked failed, old ones deleted (the same statements cleanup.ts runs)
await db.query(`insert into fill_runs (job_id, created_by, created_at) values ($1, 'u1', now() - interval '1 hour')`, [j2.id]);
await db.query(`update fill_runs set status = 'failed', error = 'The AI took too long. Try again.', payload = null, finished_at = now() where status in ('queued', 'running') and created_at < now() - interval '20 minutes'`);
assert.equal((await one(`select count(*)::int as n from fill_runs where status = 'failed'`)).n, 1);
await db.query(`delete from fill_runs where created_at < now() - interval '30 minutes'`);
assert.equal((await one(`select count(*)::int as n from fill_runs`)).n, 1);
await db.query(`delete from jobs where id = $1`, [j2.id]);
assert.equal((await one(`select count(*)::int as n from fill_runs`)).n, 0);
console.log('fill_runs rules ok');
