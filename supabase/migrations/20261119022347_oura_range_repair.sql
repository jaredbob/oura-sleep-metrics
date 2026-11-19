create table oura_private.repair_runs (
  id bigint generated always as identity primary key,
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  start_day date not null,
  end_day date not null check (end_day >= start_day)
);

create index oura_repair_owner_runs on oura_private.repair_runs (owner_id, id desc);

create table oura_private.repair_jobs (
  run_id bigint not null references oura_private.repair_runs (id) on delete cascade,
  collection text not null,
  status text not null default 'pending' check (status in ('pending', 'retryable', 'complete')),
  listed boolean not null default false,
  next_token text,
  page_tokens text[] not null default '{}',
  pages_imported integer not null default 0,
  documents_checked integer not null default 0,
  available_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  lease uuid,
  retry_reason text,
  primary key (run_id, collection)
);

create index oura_repair_pending on oura_private.repair_jobs (available_at, run_id, collection)
  where status <> 'complete';

create table oura_private.repair_documents (
  run_id bigint not null,
  collection text not null,
  document_id text not null,
  needs_check boolean not null default false,
  primary key (run_id, collection, document_id),
  foreign key (run_id, collection)
    references oura_private.repair_jobs (run_id, collection) on delete cascade
);

alter table oura_private.repair_runs enable row level security;
alter table oura_private.repair_jobs enable row level security;
alter table oura_private.repair_documents enable row level security;

revoke all on oura_private.repair_runs, oura_private.repair_jobs, oura_private.repair_documents
  from public, anon, authenticated, service_role;
revoke all on sequence oura_private.repair_runs_id_seq
  from public, anon, authenticated, service_role;
