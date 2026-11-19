# Manual Oura rollout on Supabase

## 1. Apply the database migrations

In the existing Supabase project that holds the owner's health data, review and
run the SQL files in [supabase/migrations](../supabase/migrations) in filename
order. Use the SQL Editor or an equivalent reviewed SQL workflow and verify each
file succeeded before continuing. Keep track of the files already applied if you
resume a partial rollout. Production shares migration history with other
applications, so apply the Oura SQL manually.

## 2. Configure and deploy the Edge Function

Use the existing Supabase Auth user's UUID for `OURA_OWNER_ID`. Configure the
Edge Function secrets in the Supabase Dashboard, or import them from a private
environment file outside this repository.

| Secret                            | Value                                                                |
| --------------------------------- | -------------------------------------------------------------------- |
| `OURA_OWNER_ID`                   | `<owner-auth-user-uuid>`                                             |
| `OURA_CLIENT_ID`                  | `<oura-client-id>`                                                   |
| `OURA_CLIENT_SECRET`              | `<oura-client-secret>`                                               |
| `OURA_REDIRECT_URI`               | `https://<project-ref>.supabase.co/functions/v1/oura-oauth/callback` |
| `OURA_WEBHOOK_VERIFICATION_TOKEN` | `<random-oura-verification-token>`                                   |
| `OURA_WORKER_SECRET`              | `<random-dedicated-worker-secret>`                                   |
| `OURA_WEBHOOK_URL` (optional)     | Defaults to the `/webhook` endpoint next to the callback             |

Use the exact callback URL already registered with the Oura API application.
Supabase supplies the function's database and Auth configuration. The function
requests the `daily`, `personal`, and `spo2` Oura scopes.

Deploy only `oura-oauth` from the repository root using Supabase CLI v3.

```sh
supabase functions deploy oura-oauth --remote='<project-ref>' --use-api --no-verify-jwt
```

Supabase CLI v2 uses `--project-ref '<project-ref>'` in place of `--remote`.
Oura must be able to call the callback and webhook without a Supabase JWT. The
function validates OAuth state and Oura notification signatures, checks owner
commands against Supabase Auth, and checks the dedicated worker secret on
`/work`.

## 3. Schedule the worker

Create these secrets in Supabase Vault on the same project.

| Vault name           | Value                                                            |
| -------------------- | ---------------------------------------------------------------- |
| `oura_worker_url`    | `https://<project-ref>.supabase.co/functions/v1/oura-oauth/work` |
| `oura_worker_secret` | The same private value as `OURA_WORKER_SECRET`                   |

Review and run
[schedule_oura_worker.sql](../supabase/operations/schedule_oura_worker.sql) in
the SQL Editor. Confirm the `oura-webhook-worker` job runs every minute. It
processes pending deliveries, renews subscriptions, and continues initial
history and date-range repair.
[Supabase scheduling documentation](https://supabase.com/docs/guides/functions/schedule-functions)

## 4. Connect and verify as the owner

Set `OURA_FUNCTIONS_URL` to `https://<project-ref>.supabase.co/functions/v1`.
Supply a current access token from the configured owner's Supabase Auth session
as `OURA_OWNER_ACCESS_TOKEN`. Keep the token in a private environment and
refresh it through the existing sign-in flow when it expires.

```sh
deno run --allow-env --allow-net scripts/oura.ts connect --no-open
deno run --allow-env --allow-net scripts/oura.ts status
```

Open the returned authorization URL privately and finish Oura consent before
running `status`. Status reports the connection, history progress, webhook
coverage and queued deliveries, and the latest requested range repair. Use
`reconnect --no-open` with the same Oura account if access needs to be restored.
The worker advances initial import in batches. `scripts/oura.ts import` advances
it on demand with the same Deno permissions.

Query `public.oura_nightly` using the authenticated owner identity. For a manual
check in the SQL Editor, run the query in a transaction under that role.

```sql
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '<owner-auth-user-uuid>', true);

select owner_id, day, sleep_score, readiness_score, temperature_deviation_c,
       average_spo2, sleep_session_document_id, average_hrv
from public.oura_nightly
order by day desc
limit 7;

rollback;
```

The `day` column is the Oura-reported date. Compare day boundaries before
joining it to the dates in another health source, and use the appropriate
mapping between `owner_id` and the other source's user identifier. The
`public.oura_hrv_samples` relation is available to the authenticated owner by
`sleep_session_document_id`.

## Repair a missed range

```sh
deno run --allow-env --allow-net scripts/oura.ts repair 2024-03-10 2024-03-12
```

Both dates are inclusive Oura-reported days. The command does an initial batch
and prints progress for each collection. The scheduled worker continues pending
work and retries temporary failures. A retryable result gives the collection and
failed phase. Run the same command to resume the active range immediately or run
a fresh repair after it completes. A repair checks omitted local IDs against
their individual Oura endpoints after the collection listing completes. An Oura
response confirming absence removes the corresponding reading and any dependent
HRV samples.

## Verify with synthetic Oura data

Use Deno and a fresh, disposable local Supabase CLI stack with email signup
enabled and email confirmation disabled. The test runner starts the Edge
Function handler and the Oura fixture on loopback, creates two synthetic Auth
users, and runs a single integration suite against the local database and Data
API.

```sh
supabase start
supabase db reset --no-seed
supabase status -o env
```

Set `TEST_OURA_SUPABASE_URL` to the local API URL, `TEST_OURA_DB_URL` to the
local database URL, and `TEST_OURA_SUPABASE_ANON_KEY` to the local publishable
or anon key from that output. Run each suite against a fresh local database.
Reset the disposable database between suites.

```sh
deno run --allow-env --allow-net --allow-run tests/run-local.ts tests/oura-repair.test.ts
```
