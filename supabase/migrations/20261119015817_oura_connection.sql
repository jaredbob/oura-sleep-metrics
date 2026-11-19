create schema oura_private;
revoke all on schema oura_private from public, anon, authenticated, service_role;

create table oura_private.connections (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  oura_user_id text not null unique check (oura_user_id <> ''),
  generation uuid not null default gen_random_uuid(),
  status text not null check (status in ('connected', 'reconnect_required')),
  access_token text,
  refresh_token text,
  expires_at timestamptz,
  connected_at timestamptz not null default now(),
  check (
    (status = 'connected' and access_token is not null and refresh_token is not null and expires_at is not null)
    or (status = 'reconnect_required' and access_token is null and refresh_token is null and expires_at is null)
  )
);

create table oura_private.oauth_states (
  owner_id uuid primary key references auth.users (id) on delete cascade,
  state_hash text not null unique,
  code_verifier text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);

create table oura_private.import_jobs (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  collection text not null,
  revision uuid not null default gen_random_uuid(),
  start_day date not null,
  end_day date not null,
  next_token text,
  pages_imported integer not null default 0 check (pages_imported >= 0),
  status text not null default 'pending' check (status in ('pending', 'retryable', 'complete')),
  updated_at timestamptz not null default now(),
  primary key (owner_id, collection),
  check (start_day < end_day)
);

alter table oura_private.connections enable row level security;
alter table oura_private.oauth_states enable row level security;
alter table oura_private.import_jobs enable row level security;
revoke all on all tables in schema oura_private from public, anon, authenticated, service_role;

create table public.oura_daily_sleep (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  reported_at timestamptz not null,
  sleep_score smallint check (sleep_score between 0 and 100),
  primary key (owner_id, document_id)
);

create index oura_daily_sleep_day on public.oura_daily_sleep
  (owner_id, day, reported_at desc, document_id desc);

alter table public.oura_daily_sleep enable row level security;
create policy oura_daily_sleep_owner_read on public.oura_daily_sleep
  for select to authenticated
  using ((select auth.uid()) = owner_id);
revoke all on public.oura_daily_sleep from public, anon, authenticated, service_role;
grant select on public.oura_daily_sleep to authenticated;

create view public.oura_nightly
with (security_invoker = true) as
select distinct on (owner_id, day) owner_id, day, sleep_score
from public.oura_daily_sleep
order by owner_id, day, reported_at desc, document_id desc;

revoke all on public.oura_nightly from public, anon, authenticated, service_role;
grant select on public.oura_nightly to authenticated;
