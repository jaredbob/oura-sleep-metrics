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
Supabase supplies the function's database and Auth configuration. In the
[Oura API application settings](https://cloud.ouraring.com/oauth/applications),
enable Tag, Heart Health, and Stress. The function requests
`daily personal spo2 tag heart_health stress`.

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
history and date-range repair. It prunes completed delivery diagnostics seven
days after processing. Pending and retryable deliveries stay queued, and
document versions and deletion markers remain available to order subsequent
updates.
[Supabase scheduling documentation](https://supabase.com/docs/guides/functions/schedule-functions)

## 4. Verify retention and deletion before live consent

Rehearse deletion with synthetic records in a disposable environment and keep
the evidence and any project details private. Follow the timing in the
[privacy policy](../PRIVACY.md).

1. Inventory recoverable copies of Oura data and credentials. Check the
   project's daily backups or point-in-time recovery, manual exports, restore
   and staging copies, and available log retention and drains. Review which
   callback parameters, headers, and SQL statements appear in logs. Keep
   readings, Oura identifiers, and credentials out of log messages and exports.
   See
   [Supabase database backups](https://supabase.com/docs/guides/platform/backups)
   and [Supabase logs](https://supabase.com/docs/guides/observability/logs).
2. For a full deletion, revoke sharing in the Oura app, remove this
   integration's webhook subscriptions from Oura, and stop the
   `oura-webhook-worker` schedule and `oura-oauth` endpoint. Confirm outstanding
   function requests have finished before deleting database rows.
3. In a transaction, delete the configured owner's row from
   `oura_private.connections` and any authorization state for that owner from
   `oura_private.oauth_states`. The connection deletion cascades to the readings
   and HRV samples, document versions, queued webhook deliveries, history jobs,
   and date-range repair. Remove the integration's
   `oura_private.webhook_subscriptions` and
   `oura_private.webhook_registration_failures` rows for its callback URL.
   Remove its Oura Edge Function secrets and the two worker secrets in Vault.
   Scope the procedure to these Oura integration objects.
4. Verify the owner's Oura queries return no rows and the private Oura tables
   contain no remaining data for the deleted connection or registrations for the
   removed callback. Check for Oura-derived exports and remove those copies. In
   an isolated restore rehearsal, verify Oura records and credentials can be
   excluded or removed before the restored data becomes available. Confirm the
   deletion procedure covers all retained copies within the policy's 72-hour
   window, including any provider-managed recovery points or logs that can still
   expose recoverable Oura data. Proceed to live consent only after the project
   can meet that requirement.

## 5. Connect and verify as the owner

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
coverage and queued deliveries, and the latest requested range repair. History
advances for each collection once its create, update, and delete subscriptions
are active. Status shows which subscription registrations are retryable while
healthy collections continue. Use `reconnect --no-open` with the same Oura
account to grant the three new permissions on an existing connection or to
restore access. A history collection with `retry_reason: "consent_required"`
needs that step. The worker advances initial import in batches.
`scripts/oura.ts import` advances it on demand with the same Deno permissions.
After reconnecting, check that both `daily_stress` and `daily_resilience`
complete and that all three webhook events are active for each new collection.

Use the SQL Editor or a direct Postgres connection with an authorized database
role to query Oura data. The Oura tables and views are unavailable through
the Data API.

```sql
select owner_id, day, sleep_score, readiness_score, temperature_deviation_c,
       average_spo2, sleep_session_document_id, average_hrv
from public.oura_nightly
order by day desc
limit 7;
```

The `day` column is the Oura-reported date. Compare day boundaries before
joining it to the dates in another health source, and use the appropriate
mapping between `owner_id` and the other source's user identifier. Query
`public.oura_hrv_samples` by `sleep_session_document_id`.

The additional collections are in
`public.oura_enhanced_tag`, `public.oura_daily_cardiovascular_age`,
`public.oura_vo2_max`, `public.oura_daily_stress`, and
`public.oura_daily_resilience`. Join on `owner_id` and the relevant Oura
date. For tags, `day` is the start day. To find tags spanning a date, use
`day <= target_day` and `coalesce(end_day, day) >= target_day`.
Tag timestamps preserve the provider's local time and any reported offset.
Daily Stress durations are stored in seconds.

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

For Enhanced Tags, repair uses the Oura-reported start day. To repair a tag
that spans multiple dates, include its start day in the requested range.

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
