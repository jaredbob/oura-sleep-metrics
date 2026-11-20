alter table oura_private.connections add column missing_scopes text[] not null default '{}';

-- Existing connections predate these authorization requests.
update oura_private.connections
set missing_scopes = array['tag', 'heart_health', 'stress'];

create table public.oura_enhanced_tag (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  end_day date,
  start_time text not null,
  end_time text,
  tag_type_code text,
  custom_name text,
  primary key (owner_id, document_id)
);
comment on column public.oura_enhanced_tag.day is 'The Oura-reported start day of the tag.';
comment on column public.oura_enhanced_tag.start_time is 'Oura''s local ISO 8601 timestamp, preserving its original offset when present.';
comment on column public.oura_enhanced_tag.end_time is 'Oura''s local ISO 8601 timestamp, preserving its original offset when present.';

create table public.oura_daily_cardiovascular_age (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  vascular_age integer,
  pulse_wave_velocity_m_per_s double precision,
  primary key (owner_id, document_id)
);

create table public.oura_vo2_max (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  reported_at timestamptz not null,
  vo2_max_ml_per_kg_min integer not null,
  primary key (owner_id, document_id)
);

create table public.oura_daily_stress (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  day_summary text,
  stress_high_seconds integer,
  recovery_high_seconds integer,
  primary key (owner_id, document_id)
);

create table public.oura_daily_resilience (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  document_id text not null check (document_id <> ''),
  day date not null,
  level text not null,
  sleep_recovery double precision not null,
  daytime_recovery double precision not null,
  stress double precision not null,
  primary key (owner_id, document_id)
);

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'oura_enhanced_tag', 'oura_daily_cardiovascular_age', 'oura_vo2_max',
    'oura_daily_stress', 'oura_daily_resilience'
  ] loop
    execute format('create index %I on public.%I (owner_id, day)', table_name || '_day', table_name);
    execute format('alter table public.%I enable row level security', table_name);
    execute format(
      'create policy %I on public.%I for select to authenticated using ((select auth.uid()) = owner_id)',
      table_name || '_owner_read', table_name
    );
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', table_name);
    execute format('grant select on public.%I to authenticated', table_name);
  end loop;
end
$$;
