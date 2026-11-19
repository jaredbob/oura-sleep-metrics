import { collections } from "./collections.ts";

import { requiredEnv, sql } from "./db.ts";
import { HttpError, json } from "./http.ts";

const encoder = new TextEncoder();

export async function sameSecret(
  candidate: string,
  secret: string,
): Promise<boolean> {
  const [left, right] = await Promise.all(
    [candidate, secret].map(async (value) =>
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", encoder.encode(value)),
      )
    ),
  );
  let difference = 0;
  for (let offset = 0; offset < left.length; offset++) {
    difference |= left[offset] ^ right[offset];
  }
  return difference === 0;
}

export async function verifyWebhook(
  params: URLSearchParams,
): Promise<Response> {
  const token = params.get("verification_token");
  if (
    !token ||
    !await sameSecret(token, requiredEnv("OURA_WEBHOOK_VERIFICATION_TOKEN"))
  ) {
    throw new HttpError(401, "Invalid Oura verification token.");
  }
  const challenge = params.get("challenge");
  if (!challenge || challenge.length > 4096) {
    throw new HttpError(400, "Invalid Oura challenge.");
  }
  return json({ challenge });
}

export const eventRanks = { create: 1, update: 2, delete: 3 } as const;

const eventTimePattern =
  /^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:0\d|1[0-5]):[0-5]\d)$/;
const identityPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;
const bodyLimit = 16 * 1024;

export async function acceptNotification(req: Request): Promise<boolean> {
  const signature = req.headers.get("x-oura-signature");
  const timestamp = req.headers.get("x-oura-timestamp");
  if (
    !signature || !/^[0-9a-f]{64}$/i.test(signature) ||
    !timestamp || !/^\d{1,16}$/.test(timestamp)
  ) throw new HttpError(401, "Invalid Oura signature.");

  const raw = await readNotificationBody(req);
  const prefix = encoder.encode(timestamp);
  const message = new Uint8Array(prefix.length + raw.length);
  message.set(prefix);
  message.set(raw, prefix.length);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(requiredEnv("OURA_CLIENT_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const supplied = Uint8Array.from(
    signature.match(/../g)!,
    (byte) => parseInt(byte, 16),
  );
  if (!await crypto.subtle.verify("HMAC", key, supplied, message)) {
    throw new HttpError(401, "Invalid Oura signature.");
  }

  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    throw new HttpError(400, "Invalid Oura notification.");
  }
  const event = parseNotification(value);

  const [result] = await sql()<
    { connection_matches: boolean; inserted: boolean }[]
  >`
    with connection as (
      select owner_id from oura_private.connections
      where owner_id = ${
    requiredEnv("OURA_OWNER_ID")
  } and oura_user_id = ${event.user_id}
    ), inserted as (
      insert into oura_private.webhook_deliveries (owner_id, collection, document_id, event_time, event_rank)
      select owner_id, ${event.data_type}, ${event.object_id}, ${event.event_time}::timestamptz, ${event.rank}
      from connection
      on conflict (owner_id, collection, document_id, event_time, event_rank) do nothing
      returning id
    )
    select exists(select 1 from connection) as connection_matches, exists(select 1 from inserted) as inserted
  `;
  if (!result.connection_matches) {
    throw new HttpError(
      403,
      "Oura notification does not match the connection.",
    );
  }
  return result.inserted;
}

async function readNotificationBody(
  req: Request,
) {
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "Missing Oura notification.");
  try {
    const raw = new Uint8Array(bodyLimit);
    let size = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) return raw.subarray(0, size);
      if (size + value.length > bodyLimit) {
        await reader.cancel();
        throw new HttpError(413, "Oura notification is too large.");
      }
      raw.set(value, size);
      size += value.length;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseNotification(value: unknown) {
  if (typeof value !== "object" || value === null) {
    throw new HttpError(400, "Invalid Oura notification.");
  }
  const { event_type, data_type, object_id, event_time, user_id } =
    value as Record<string, unknown>;
  if (
    typeof event_type !== "string" || !Object.hasOwn(eventRanks, event_type) ||
    typeof data_type !== "string" ||
    !collections.some(({ name }) => name === data_type) ||
    typeof object_id !== "string" || !identityPattern.test(object_id) ||
    typeof user_id !== "string" || !identityPattern.test(user_id) ||
    typeof event_time !== "string" || !eventTimePattern.test(event_time) ||
    !validEventDate(event_time)
  ) throw new HttpError(400, "Invalid Oura notification.");

  return {
    data_type,
    object_id,
    event_time,
    user_id,
    rank: eventRanks[event_type as keyof typeof eventRanks],
  };
}

function validEventDate(eventTime: string): boolean {
  const day = eventTime.slice(0, 10);
  const date = new Date(day);
  return Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === day && !day.startsWith("0000");
}
