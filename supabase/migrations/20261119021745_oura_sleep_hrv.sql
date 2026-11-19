create table oura_private.sleep_sessions (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  bedtime_start timestamptz not null,
  bedtime_end timestamptz not null,
  total_sleep_duration integer check (total_sleep_duration >= 0),
  average_hrv integer,
  primary key (owner_id, document_id)
);

create index oura_sleep_sessions_day on oura_private.sleep_sessions
  (owner_id, day, total_sleep_duration desc nulls last, bedtime_end desc, document_id desc);

alter table oura_private.sleep_sessions enable row level security;
create policy oura_sleep_sessions_owner_read on oura_private.sleep_sessions
  for select to authenticated
  using ((select auth.uid()) = owner_id);
revoke all on oura_private.sleep_sessions from public, anon, authenticated, service_role;
-- Let the invoker views read these relations without allowing direct access to this schema.
grant select on oura_private.sleep_sessions to authenticated;

-- Oura classifies sleep longer than three hours as long_sleep. Break ties among
-- candidates for one Sleep Day with the reported duration, bedtime end, then ID.
create view oura_private.main_sleep
with (security_invoker = true) as
select distinct on (owner_id, day) owner_id, day, document_id, average_hrv
from oura_private.sleep_sessions
order by owner_id, day, total_sleep_duration desc nulls last, bedtime_end desc, document_id desc;

revoke all on oura_private.main_sleep from public, anon, authenticated, service_role;
grant select on oura_private.main_sleep to authenticated;

create table public.oura_hrv_samples (
  owner_id uuid not null,
  sleep_session_document_id text not null,
  sample_index integer not null check (sample_index >= 0),
  sampled_at timestamptz not null,
  hrv double precision,
  primary key (owner_id, sleep_session_document_id, sample_index),
  foreign key (owner_id, sleep_session_document_id)
    references oura_private.sleep_sessions (owner_id, document_id) on delete cascade
);

alter table public.oura_hrv_samples enable row level security;
create policy oura_hrv_samples_owner_read on public.oura_hrv_samples
  for select to authenticated
  using (
    (select auth.uid()) = owner_id
    and (owner_id, sleep_session_document_id) in (
      select owner_id, document_id from oura_private.main_sleep
    )
  );
revoke all on public.oura_hrv_samples from public, anon, authenticated, service_role;
grant select on public.oura_hrv_samples to authenticated;

create or replace view public.oura_nightly
with (security_invoker = true) as
with sleep_scores as (
  select distinct on (owner_id, day) owner_id, day, sleep_score
  from public.oura_daily_sleep
  order by owner_id, day, reported_at desc, document_id desc
)
select owner_id, day, sleep_score,
       main_sleep.document_id as sleep_session_document_id,
       main_sleep.average_hrv
from sleep_scores
full join oura_private.main_sleep using (owner_id, day);

insert into oura_private.import_jobs (owner_id, collection, start_day, end_day)
select owner_id, 'sleep', date '2015-01-01', current_date + 2
from oura_private.connections;
