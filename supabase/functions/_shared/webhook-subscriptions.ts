import { collections } from "./collections.ts";
import { requiredEnv, sql } from "./db.ts";
import { queueHistoryImport } from "./history.ts";
import { ouraApiFetch } from "./oura-api.ts";
import { eventRanks } from "./webhook.ts";

const subscriptionPath = "/v2/webhook/subscription";

type EventType = keyof typeof eventRanks;

type Subscription = {
  id: string;
  callback_url: string;
  data_type: string;
  event_type: EventType;
  expiration_time: string;
};

const desiredSubscriptions = collections.flatMap(({ name }) =>
  (Object.keys(eventRanks) as EventType[]).map((eventType) => ({
    data_type: name,
    event_type: eventType,
  }))
);

export async function ensureSubscriptions(ownerId: string): Promise<void> {
  await sql().begin(async (tx) => {
    // Oura subscriptions belong to the app. Serialize reconciliation across invocations.
    await tx`select pg_advisory_xact_lock(hashtext('oura_webhook_subscriptions'))`;
    const [connection] = await tx`
      select owner_id from oura_private.connections where owner_id = ${ownerId}
    `;
    if (!connection) return;

    // Covers a collection added after the owner first connected.
    await queueHistoryImport(tx, ownerId);

    const callbackUrl = webhookUrl();
    const active = await tx<{ collection: string; event_type: string }[]>`
      select collection, event_type from oura_private.webhook_subscriptions
      where callback_url = ${callbackUrl} and expires_at > now()
    `;
    const missing = desiredSubscriptions.filter((desired) =>
      !active.some((cached) =>
        cached.collection === desired.data_type &&
        cached.event_type === desired.event_type
      )
    );
    if (missing.length === 0) return;

    const remote = await subscriptionRequest(subscriptionPath);
    if (!Array.isArray(remote)) {
      throw new Error("Invalid Oura subscription list.");
    }
    const existing = remote.map(parseSubscription).filter((entry) =>
      entry !== null
    );
    const reconciled = await Promise.allSettled(
      missing.map(async (desired) => {
        const known = existing.find((item) =>
          item.callback_url === callbackUrl &&
          item.data_type === desired.data_type &&
          item.event_type === desired.event_type &&
          Date.parse(item.expiration_time) > Date.now()
        );
        if (known) return known;

        const created = parseSubscription(
          await subscriptionRequest(subscriptionPath, {
            method: "POST",
            body: JSON.stringify({
              ...desired,
              callback_url: callbackUrl,
              verification_token: requiredEnv(
                "OURA_WEBHOOK_VERIFICATION_TOKEN",
              ),
            }),
          }),
        );
        if (
          !created || created.callback_url !== callbackUrl ||
          created.data_type !== desired.data_type ||
          created.event_type !== desired.event_type ||
          Date.parse(created.expiration_time) <= Date.now()
        ) throw new Error("Invalid Oura subscription response.");
        return created;
      }),
    );

    const subscriptions = reconciled.map((result) => {
      if (result.status === "rejected") throw result.reason;
      return result.value;
    });

    await tx`
      insert into oura_private.webhook_subscriptions
      ${
      tx(
        subscriptions.map((entry) => ({
          collection: entry.data_type,
          event_type: entry.event_type,
          provider_id: entry.id,
          callback_url: entry.callback_url,
          expires_at: entry.expiration_time,
        })),
        "collection",
        "event_type",
        "provider_id",
        "callback_url",
        "expires_at",
      )
    }
      on conflict (collection, event_type) do update
      set provider_id = excluded.provider_id, callback_url = excluded.callback_url, expires_at = excluded.expires_at
    `;

    // Restart any previously started history once the missing coverage is in place.
    await tx`
      update oura_private.import_jobs
      set revision = gen_random_uuid(), next_token = null, status = 'pending', pages_imported = 0,
          end_day = greatest(end_day, current_date + 2), updated_at = now(), available_at = now()
      where owner_id = ${ownerId} and collection = any(${
      tx.array(
        [...new Set(subscriptions.map(({ data_type }) => data_type))],
      )
    }::text[])
    `;
  });
}

function webhookUrl(): string {
  const configured = Deno.env.get("OURA_WEBHOOK_URL");
  if (configured) return new URL(configured).href;
  const redirect = new URL(requiredEnv("OURA_REDIRECT_URI"));
  if (!redirect.pathname.endsWith("/callback")) {
    throw new Error("Set OURA_WEBHOOK_URL for a custom OAuth callback URL.");
  }
  return new URL("webhook", redirect).href;
}

async function subscriptionRequest(
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await ouraApiFetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-client-id": requiredEnv("OURA_CLIENT_ID"),
      "x-client-secret": requiredEnv("OURA_CLIENT_SECRET"),
    },
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("Oura subscription request failed.");
  }
  return await response.json();
}

function parseSubscription(value: unknown): Subscription | null {
  if (typeof value !== "object" || value === null) return null;
  const { id, callback_url, event_type, data_type, expiration_time } =
    value as Record<string, unknown>;
  if (
    typeof id !== "string" || !id || typeof callback_url !== "string" ||
    typeof event_type !== "string" || !Object.hasOwn(eventRanks, event_type) ||
    typeof data_type !== "string" || typeof expiration_time !== "string" ||
    !Number.isFinite(Date.parse(expiration_time))
  ) return null;
  return {
    id,
    callback_url,
    event_type: event_type as EventType,
    data_type,
    expiration_time,
  };
}
