alter table oura_private.import_jobs
  add column page_tokens text[] not null default '{}';

update oura_private.import_jobs
set page_tokens = array[next_token]
where next_token is not null;

create index oura_webhook_processed
  on oura_private.webhook_deliveries (owner_id, processed_at, id)
  where processed_at is not null;

create table oura_private.webhook_registration_failures (
  collection text not null,
  event_type text not null check (event_type in ('create', 'update', 'delete')),
  callback_url text not null,
  retry_at timestamptz not null,
  retry_reason text not null check (retry_reason in ('listing_failed', 'registration_failed')),
  primary key (collection, event_type)
);

alter table oura_private.webhook_registration_failures enable row level security;
revoke all on oura_private.webhook_registration_failures
  from public, anon, authenticated, service_role;
