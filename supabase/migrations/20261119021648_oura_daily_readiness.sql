create table public.oura_daily_readiness (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  reported_at timestamptz not null,
  readiness_score smallint check (readiness_score between 0 and 100),
  temperature_deviation_c double precision,
  primary key (owner_id, document_id)
);

create index oura_daily_readiness_day on public.oura_daily_readiness
  (owner_id, day, reported_at desc, document_id desc);

alter table public.oura_daily_readiness enable row level security;
create policy oura_daily_readiness_owner_read on public.oura_daily_readiness
  for select to authenticated
  using ((select auth.uid()) = owner_id);
revoke all on public.oura_daily_readiness from public, anon, authenticated, service_role;
grant select on public.oura_daily_readiness to authenticated;

create or replace view public.oura_nightly
with (security_invoker = true) as
with sleep as (
  select distinct on (owner_id, day) owner_id, day, sleep_score
  from public.oura_daily_sleep
  order by owner_id, day, reported_at desc, document_id desc
), spo2 as (
  -- Oura supplies no timestamp for ordering documents for the same day.
  select distinct on (owner_id, day) owner_id, day, average_spo2
  from public.oura_daily_spo2
  order by owner_id, day, document_id desc
), readiness as (
  select distinct on (owner_id, day)
    owner_id, day, readiness_score, temperature_deviation_c
  from public.oura_daily_readiness
  order by owner_id, day, reported_at desc, document_id desc
)
select owner_id, day, sleep.sleep_score, spo2.average_spo2,
  readiness.readiness_score, readiness.temperature_deviation_c
from sleep
full join spo2 using (owner_id, day)
full join readiness using (owner_id, day);
