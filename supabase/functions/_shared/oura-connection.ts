import { requiredEnv, sql } from "./db.ts";
import { queueHistoryImport } from "./history.ts";
import { HttpError } from "./http.ts";
import { fetchWithAccessToken, requestTokenPair } from "./oura-auth.ts";

export async function beginConsent(ownerId: string): Promise<string> {
  const state = randomSecret();
  const codeVerifier = randomSecret();
  const [stateHash, codeChallenge] = await Promise.all([
    digest(state),
    digest(codeVerifier),
  ]);
  const authorizationUrl = new URL(
    Deno.env.get("OURA_AUTHORIZE_URL") ??
      "https://cloud.ouraring.com/oauth/authorize",
  );
  authorizationUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: requiredEnv("OURA_CLIENT_ID"),
    redirect_uri: requiredEnv("OURA_REDIRECT_URI"),
    scope: "daily personal",
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  }).toString();

  await sql()`
    insert into oura_private.oauth_states (owner_id, state_hash, code_verifier, expires_at)
    values (${ownerId}, ${stateHash}, ${codeVerifier}, now() + interval '10 minutes')
    on conflict (owner_id) do update
    set state_hash = excluded.state_hash, code_verifier = excluded.code_verifier,
        expires_at = excluded.expires_at, consumed_at = null
  `;
  return authorizationUrl.href;
}

export async function finishConsent(params: URLSearchParams): Promise<string> {
  const state = params.get("state");
  if (!state || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new HttpError(
      400,
      "Invalid or expired Oura authorization. Run the connect command again.",
    );
  }

  const stateHash = await digest(state);
  const ownerId = requiredEnv("OURA_OWNER_ID");
  const [attempt] = await sql()<{ code_verifier: string }[]>`
    update oura_private.oauth_states
    set consumed_at = now()
    where owner_id = ${ownerId} and state_hash = ${stateHash} and expires_at > now()
      and consumed_at is null
    returning code_verifier
  `;
  if (!attempt) {
    throw new HttpError(
      400,
      "Invalid or expired Oura authorization. Run the connect command again.",
    );
  }

  const code = params.get("code");
  if (params.has("error") || !code) {
    throw new HttpError(
      400,
      "Oura consent was not completed. Run the connect command again.",
    );
  }

  let pair: Awaited<ReturnType<typeof requestTokenPair>>;
  let ouraUserId: string;
  try {
    pair = await requestTokenPair({
      grant_type: "authorization_code",
      code,
      code_verifier: attempt.code_verifier,
      redirect_uri: requiredEnv("OURA_REDIRECT_URI"),
    });
    const response = await fetchWithAccessToken(
      "/v2/usercollection/personal_info",
      pair.accessToken,
    );
    if (!response.ok) throw new Error("Oura account request failed.");
    const { id } = await response.json();
    if (typeof id !== "string" || !id) {
      throw new Error("Invalid Oura account identity.");
    }
    ouraUserId = id;
  } catch {
    throw new HttpError(
      502,
      "Oura authorization failed. Run the connect command again.",
    );
  }

  await sql().begin(async (tx) => {
    const [current] = await tx`
      select state_hash from oura_private.oauth_states
      where owner_id = ${ownerId} for update
    `;
    if (current?.state_hash !== stateHash) {
      throw new HttpError(
        409,
        "A newer Oura authorization was started. Continue with that request.",
      );
    }

    const saved = await tx`
      insert into oura_private.connections (
        owner_id, oura_user_id, status, access_token, refresh_token, expires_at
      )
      values (
        ${ownerId}, ${ouraUserId}, 'connected', ${pair.accessToken}, ${pair.refreshToken}, ${pair.expiresAt}
      )
      on conflict (owner_id) do update
      set status = 'connected', access_token = excluded.access_token, refresh_token = excluded.refresh_token,
          expires_at = excluded.expires_at, connected_at = now(), generation = gen_random_uuid()
      where connections.oura_user_id = excluded.oura_user_id
    `;
    if (saved.count === 0) {
      throw new HttpError(
        409,
        "Use the Oura account already linked to this owner.",
      );
    }
    await queueHistoryImport(tx, ownerId);
    await tx`delete from oura_private.oauth_states where owner_id = ${ownerId}`;
  });
  return ownerId;
}

function randomSecret(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(secret: string): Promise<string> {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
    ),
  );
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll(
    "/",
    "_",
  ).replace(/=+$/, "");
}
