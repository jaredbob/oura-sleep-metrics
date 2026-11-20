# Oura webhook flow

The paths below are relative to the receiving host. The diagram uses the default
Supabase webhook path. `OURA_WEBHOOK_URL` can override the callback URL
registered with Oura.

```mermaid
sequenceDiagram
    actor Owner as Owner CLI / browser
    participant Oura as Oura
    participant Cron as Supabase Cron
    participant Edge as oura-oauth Edge Function
    participant Auth as Supabase Auth
    participant DB as Postgres

    Note over Owner,DB: Connect the Oura account
    Owner->>Edge: POST /functions/v1/oura-oauth/connect
    Edge->>Auth: GET /auth/v1/user
    Edge->>DB: Save OAuth state and PKCE verifier
    Edge-->>Owner: Return Oura authorization URL
    Owner->>Oura: GET /oauth/authorize
    Oura-->>Owner: Redirect with authorization code and state
    Owner->>Edge: GET /functions/v1/oura-oauth/callback?code={code}&state={state}
    Edge->>DB: Validate and consume OAuth state
    Edge->>Oura: POST /oauth/token
    Edge->>Oura: GET /v2/usercollection/personal_info
    Edge->>DB: Save linked account, tokens, and known missing permissions, then queue history
    Edge->>Edge: Start subscription reconciliation and import via waitUntil
    Edge-->>Owner: 200 Oura is connected

    Note over Oura,DB: Reconcile subscriptions after consent and on scheduled runs
    opt Subscription coverage is missing or expired
        Edge->>Oura: GET /v2/webhook/subscription
        loop Each missing collection and event pair
            alt Oura already has an active subscription for this callback
                Edge->>Edge: Reuse the existing subscription
            else Create a subscription
                Edge->>Oura: POST /v2/webhook/subscription
                Oura->>Edge: GET /functions/v1/oura-oauth/webhook<br/>?challenge={challenge}&verification_token={token}
                Edge->>Edge: Verify token and challenge
                Edge-->>Oura: 200 with the challenge
                Oura-->>Edge: Subscription ID and expiration
            end
        end
        Edge->>DB: Save subscriptions and record failures for retry
    end
    opt History is pending for a fully covered collection with consent
        Edge->>Oura: GET /v2/usercollection/{endpoint}<br/>?start_date={start}&end_date={end}
        Edge->>DB: Apply history page and save pagination progress
    end

    Note over Oura,DB: Receive an Oura Webhook Notification
    Oura->>Edge: POST /functions/v1/oura-oauth/webhook
    Edge->>Edge: Verify HMAC and validate notification fields
    alt Invalid request
        Edge-->>Oura: 401 invalid signature, 400 invalid payload, or 413 oversized body
    else Valid request
        Edge->>DB: Match linked Oura account and insert delivery with deduplication
        alt Account mismatch or database failure
            Edge-->>Oura: 403 account mismatch or 503 database failure
        else Delivery stored or already present
            opt A new row was inserted
                Edge->>Edge: Start background processing via waitUntil
            end
            Edge-->>Oura: 200 accepted
        end
    end

    Note over Oura,DB: Process queued deliveries independently of the webhook response
    opt Scheduled run every minute
        Cron->>Edge: POST /functions/v1/oura-oauth/work
        Edge->>Edge: Verify dedicated worker bearer secret
    end
    loop Due deliveries, via background processing or the scheduled worker
        Edge->>DB: Claim with a lease and check document version
        alt Stale event
            Edge->>DB: Mark processed and preserve the current record
        else Delete event
            Edge->>DB: Delete the local record, record deletion, and mark processed
        else Create or update event
            opt Stored access token expired
                Edge->>Oura: POST /oauth/token with refresh grant
            end
            Edge->>Oura: GET /v2/usercollection/{endpoint}/{document_id}
            opt Lookup returned 401 without an explicit permission error
                Edge->>Oura: POST /oauth/token if a fresh token is needed
                Edge->>Oura: Retry GET /v2/usercollection/{endpoint}/{document_id}
            end
            alt Current document fetched and write succeeds
                Edge->>DB: Upsert document, record version, and mark processed atomically
            else Fetch or write fails
                Edge->>DB: Release lease and schedule retry with backoff
            end
        end
    end

    opt Scheduled run and active subscription expires within 24 hours
        Edge->>Oura: PUT /v2/webhook/subscription/renew/{subscription_id}
        Edge->>DB: Save renewed expiration or schedule retry
    end
```

Each collection has separate `create`, `update`, and `delete` subscriptions.
For VO₂ Max, the webhook collection is `vo2_max` and the GET endpoint is
`vO2_max`. Requests include `fields` where the endpoint supports field
selection. History requests add `next_token` when continuing a paginated
result. Missing permissions appear as `consent_required` for the affected
history collections.

On each run, the scheduled worker processes deliveries, renews subscriptions,
prunes deliveries processed more than seven days ago, and advances repair and
initial sync in parallel. Initial sync reconciles subscriptions before importing
history.

| Owner action | Relative URL |
| --- | --- |
| Check subscription coverage, queued deliveries, and sync status | `GET /functions/v1/oura-oauth/status` |
| Reconcile subscriptions and advance history on demand | `POST /functions/v1/oura-oauth/import` |
| Recover changes missed during an outage | `POST /functions/v1/oura-oauth/repair` |

[Rollout guide](rollout.md) ·
[Edge Function handler](../supabase/functions/oura-oauth/handler.ts) ·
[Subscription logic](../supabase/functions/_shared/webhook-subscriptions.ts) ·
[Delivery processing](../supabase/functions/_shared/webhook-work.ts)
