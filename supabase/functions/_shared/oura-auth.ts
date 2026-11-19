import { requiredEnv, sql } from "./db.ts";
import { ouraApiFetch } from "./oura-api.ts";

export class ReconnectRequired extends Error {}

class InvalidGrant extends Error {}

type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
};

export async function requestTokenPair(
  grant: Record<string, string>,
): Promise<TokenPair> {
  const response = await ouraApiFetch("/oauth/token", {
    method: "POST",
    body: new URLSearchParams({
      ...grant,
      client_id: requiredEnv("OURA_CLIENT_ID"),
      client_secret: requiredEnv("OURA_CLIENT_SECRET"),
    }),
  });
  const payload = await response.json().catch(() => null);
  if (
    (response.status === 400 || response.status === 401) &&
    payload?.error === "invalid_grant"
  ) {
    throw new InvalidGrant();
  }
  if (
    !response.ok || typeof payload?.access_token !== "string" ||
    !payload.access_token ||
    typeof payload.refresh_token !== "string" || !payload.refresh_token ||
    !Number.isSafeInteger(payload.expires_in) || payload.expires_in <= 0
  ) {
    throw new Error("Oura token request failed.");
  }
  const expiresAt = new Date(Date.now() + payload.expires_in * 1000);
  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("Invalid Oura token expiry.");
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt,
  };
}

export async function getAccessToken(
  ownerId: string,
  rejectedToken?: string,
): Promise<string> {
  const token = await sql().begin(async (tx) => {
    const [connection] = await tx<{
      status: string;
      access_token: string;
      refresh_token: string;
      usable: boolean;
    }[]>`
      select status, access_token, refresh_token, expires_at > clock_timestamp() as usable
      from oura_private.connections
      where owner_id = ${ownerId}
      for no key update
    `;
    if (connection?.status !== "connected") return null;
    if (connection.usable && connection.access_token !== rejectedToken) {
      return connection.access_token;
    }

    try {
      const pair = await requestTokenPair({
        grant_type: "refresh_token",
        refresh_token: connection.refresh_token,
      });
      await tx`
        update oura_private.connections
        set access_token = ${pair.accessToken}, refresh_token = ${pair.refreshToken},
            expires_at = ${pair.expiresAt}
        where owner_id = ${ownerId}
      `;
      return pair.accessToken;
    } catch (error) {
      if (!(error instanceof InvalidGrant)) throw error;
      await tx`
        update oura_private.connections
        set status = 'reconnect_required', access_token = null, refresh_token = null, expires_at = null
        where owner_id = ${ownerId}
      `;
      return null;
    }
  });
  if (token === null) throw new ReconnectRequired();
  return token;
}

export async function ouraUserFetch(
  ownerId: string,
  path: string,
): Promise<Response> {
  const accessToken = await getAccessToken(ownerId);
  const response = await fetchWithAccessToken(path, accessToken);
  if (response.status !== 401) return response;
  await response.body?.cancel();

  const freshToken = await getAccessToken(ownerId, accessToken);
  const retry = await fetchWithAccessToken(path, freshToken);
  if (retry.status !== 401) return retry;
  await retry.body?.cancel();
  const updated = await sql()`
    update oura_private.connections
    set status = 'reconnect_required', access_token = null, refresh_token = null, expires_at = null
    where owner_id = ${ownerId} and access_token = ${freshToken}
  `;
  if (updated.count > 0) throw new ReconnectRequired();
  throw new Error("The Oura connection changed during a request.");
}

export function fetchWithAccessToken(
  path: string,
  accessToken: string,
): Promise<Response> {
  return ouraApiFetch(path, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
}
