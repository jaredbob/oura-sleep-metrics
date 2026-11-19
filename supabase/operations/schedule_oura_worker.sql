-- Run manually after deploying the function and configuring its OURA_WORKER_SECRET.
-- Create Vault secrets named oura_worker_url (the deployed /work URL) and
-- oura_worker_secret (matching OURA_WORKER_SECRET) through the project dashboard.
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;

do $check$
begin
  if (select count(*) from vault.decrypted_secrets
      where name in ('oura_worker_url', 'oura_worker_secret') and decrypted_secret <> '') <> 2 then
    raise exception 'Configure the Oura worker URL and secret in Supabase Vault first.';
  end if;
end;
$check$;

select cron.schedule(
  'oura-webhook-worker',
  '* * * * *',
  $job$
    select net.http_post(
      url := worker_url.decrypted_secret,
      headers := jsonb_build_object(
        'Authorization', 'Bearer ' || worker_secret.decrypted_secret,
        'Content-Type', 'application/json'
      ),
      timeout_milliseconds := 55000
    )
    from vault.decrypted_secrets worker_url
    cross join vault.decrypted_secrets worker_secret
    where worker_url.name = 'oura_worker_url' and worker_secret.name = 'oura_worker_secret'
  $job$
);
