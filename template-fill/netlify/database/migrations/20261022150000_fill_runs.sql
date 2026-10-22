-- A "fill run" is one request to the AI to read a job's documents and propose values for the template's blanks.
-- The AI call can take longer than a normal function may run, so it is done by a background function: this table is how the
-- browser asks "is it finished yet?". The documents' text (payload) is deleted from the row as soon as the run ends.
-- Never edit this file after it has deployed; add a new timestamped migration instead.

create table fill_runs (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references jobs(id) on delete cascade,
  status           text not null default 'queued' check (status in ('queued', 'running', 'ready', 'failed')),
  payload          jsonb,
  result           jsonb,
  error            text,
  created_by       text not null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  started_at       timestamptz,
  finished_at      timestamptz
);
create index fill_runs_job_idx on fill_runs (job_id, created_at desc);
create index fill_runs_status_idx on fill_runs (status, created_at);
