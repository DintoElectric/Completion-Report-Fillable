-- Template Fill: initial schema.
-- Never edit this file after it has been deployed: Netlify checksums every migration it has run and refuses to build
-- when one changes. To change the schema, add a new timestamped migration file instead.

create table templates (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  description      text,
  file_id          uuid,                         -- the current template file; foreign key added below
  created_by       text not null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz
);

create table jobs (
  id               uuid primary key default gen_random_uuid(),
  name             text not null,
  template_id      uuid references templates(id) on delete set null,
  status           text not null default 'draft' check (status in ('draft', 'filled')),
  notes            text,
  created_by       text not null,
  created_by_name  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  archived_at      timestamptz
);
create index jobs_created_idx on jobs (created_at desc);

-- Every stored file: a template's file, a job's source documents, and (later) a job's filled outputs.
-- The bytes live in Netlify Blobs in pieces of CHUNK_BYTES, under files/<id>/<n>.
create table files (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('template', 'source', 'output')),
  template_id      uuid references templates(id) on delete cascade,
  job_id           uuid references jobs(id) on delete cascade,
  file_name        text not null,
  file_type        text not null,
  size_bytes       bigint not null check (size_bytes > 0),
  chunk_count      int not null check (chunk_count > 0),
  upload_status    text not null default 'uploading' check (upload_status in ('uploading', 'ready')),
  uploaded_by      text not null,
  uploaded_by_name text,
  created_at       timestamptz not null default now(),
  -- a template file belongs to a template; sources and outputs belong to a job
  check ((kind = 'template') = (template_id is not null)),
  check ((kind in ('source', 'output')) = (job_id is not null))
);
create index files_job_idx on files (job_id);
create index files_template_idx on files (template_id);
create index files_stale_idx on files (upload_status, created_at);

alter table templates add constraint templates_file_fk foreign key (file_id) references files(id) on delete set null;
