alter table oura_private.webhook_subscriptions
  add column renewal_attempts integer not null default 0 check (renewal_attempts >= 0),
  add column renewal_retry_at timestamptz;
