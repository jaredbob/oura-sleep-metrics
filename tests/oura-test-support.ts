export function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function command(accessToken: string, ...args: string[]) {
  const process = new Deno.Command(Deno.execPath(), {
    args: ["run", "--allow-env", "--allow-net", "scripts/oura.ts", ...args],
    env: {
      OURA_FUNCTIONS_URL: required("TEST_OURA_FUNCTIONS_URL"),
      OURA_OWNER_ACCESS_TOKEN: accessToken,
    },
    stdout: "piped",
    stderr: "piped",
  });
  const result = await process.output();
  const decoder = new TextDecoder();
  return {
    ok: result.success,
    stdout: decoder.decode(result.stdout),
    stderr: decoder.decode(result.stderr),
  };
}

export function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

export async function fixture(path: string, config?: object) {
  const response = await fetch(
    new URL(`/fixture/${path}`, required("TEST_OURA_FIXTURE_URL")),
    {
      method: config ? "POST" : "GET",
      body: config ? JSON.stringify(config) : undefined,
    },
  );
  equal(response.status, 200);
  return await response.json();
}

export async function authorize(ownerToken: string, action = "connect") {
  const result = await command(ownerToken, action, "--no-open");
  equal(result.ok, true);
  const response = await fetch(JSON.parse(result.stdout).authorization_url, {
    redirect: "manual",
  });
  equal(response.status, 302);
  const callback = response.headers.get("location");
  if (!callback) {
    throw new Error("Expected the fixture to redirect to the OAuth callback.");
  }
  return callback;
}

export async function readSql(
  relation: string,
  select: string,
  token?: string,
  order = "day",
) {
  const headers = new Headers({
    apikey: required("TEST_OURA_SUPABASE_ANON_KEY"),
    prefer: "timezone=UTC",
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const url = new URL(
    `/rest/v1/${relation}`,
    required("TEST_OURA_SUPABASE_URL"),
  );
  url.search = new URLSearchParams({ select, order }).toString();
  const response = await fetch(url, { headers });
  return { status: response.status, rows: await response.json() };
}

export function endpoint(route: string): URL {
  return new URL(
    "oura-oauth/" + route,
    required("TEST_OURA_FUNCTIONS_URL").replace(/\/$/, "") + "/",
  );
}

export async function signedNotification(
  document: Record<string, unknown>,
): Promise<{ method: string; body: string; headers: Headers }> {
  const body = JSON.stringify(document, null, 2);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(required("OURA_CLIENT_SECRET")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(timestamp + body),
  );
  return {
    method: "POST",
    body,
    headers: new Headers({
      "content-type": "application/json",
      "x-oura-timestamp": timestamp,
      "x-oura-signature": Array.from(new Uint8Array(signature))
        .map((byte) => byte.toString(16).padStart(2, "0")).join("")
        .toUpperCase(),
    }),
  };
}

export function runWorker(): Promise<Response> {
  return fetch(endpoint("work"), {
    method: "POST",
    headers: { authorization: `Bearer ${required("OURA_WORKER_SECRET")}` },
  });
}
