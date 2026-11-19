create table oura_private.webhook_deliveries (
  id bigint generated always as identity primary key,
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  collection text not null,
  document_id text not null,
  event_time timestamptz not null,
  event_rank smallint not null check (event_rank between 1 and 3),
  received_at timestamptz not null default now(),
  available_at timestamptz not null default now(),
  attempts integer not null default 0,
  lease uuid,
  processed_at timestamptz,
  retry_reason text,
  unique (owner_id, collection, document_id, event_time, event_rank)
);

create index oura_webhook_pending
  on oura_private.webhook_deliveries (owner_id, available_at, id)
  where processed_at is null;

create sequence oura_private.document_read_revision;

create table oura_private.document_versions (
  owner_id uuid not null references oura_private.connections (owner_id) on delete cascade,
  collection text not null,
  document_id text not null,
  read_revision bigint not null,
  event_time timestamptz,
  event_rank smallint check (event_rank between 1 and 3),
  deleted boolean not null default false,
  primary key (owner_id, collection, document_id),
  check ((event_time is null) = (event_rank is null))
);

create table oura_private.webhook_subscriptions (
  collection text not null,
  event_type text not null check (event_type in ('create', 'update', 'delete')),
  provider_id text not null,
  callback_url text not null,
  expires_at timestamptz not null,
  primary key (collection, event_type)
);

alter table oura_private.import_jobs
  add column available_at timestamptz not null default now();

alter table oura_private.webhook_deliveries enable row level security;
alter table oura_private.document_versions enable row level security;
alter table oura_private.webhook_subscriptions enable row level security;
revoke all on all tables in schema oura_private from public, anon, authenticated, service_role;
revoke all on all sequences in schema oura_private from public, anon, authenticated, service_role;
