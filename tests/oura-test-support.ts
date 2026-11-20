import postgres from "npm:postgres@3.4.9";

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

async function readDataApi(
  relation: string,
  select: string,
  token?: string,
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
  url.search = new URLSearchParams({ select }).toString();
  const response = await fetch(url, { headers });
  await response.body?.cancel();
  return response.status;
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

export async function readOuraRows<Row extends object = postgres.Row>(
  relation: string,
  columns: string,
  order = "day",
) {
  const database = postgres(required("TEST_OURA_DB_URL"), {
    max: 1,
    connection: { TimeZone: "UTC" },
  });
  try {
    const fields = columns === "*" ? database`*` : database(columns.split(","));
    const rows = await database<{ reading: Row }[]>`
      select row_to_json(reading) as reading
      from (
        select ${fields} from ${database(`public.${relation}`)}
        order by ${database(order.split(","))}
      ) reading
    `;
    return rows.map(({ reading }) => reading);
  } finally {
    await database.end();
  }
}

export async function assertOuraDataApiDenied() {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const other = required("TEST_OURA_OTHER_ACCESS_TOKEN");
  for (
    const relation of [
      "oura_daily_sleep",
      "oura_daily_readiness",
      "oura_daily_spo2",
      "oura_hrv_samples",
      "oura_nightly",
      "oura_enhanced_tag",
      "oura_daily_cardiovascular_age",
      "oura_vo2_max",
      "oura_daily_stress",
      "oura_daily_resilience",
    ]
  ) {
    for (const token of [owner, other, undefined]) {
      const status = await readDataApi(relation, "owner_id", token);
      if (![401, 403, 404].includes(status)) {
        throw new Error(
          `Expected Data API denial for ${relation}, received HTTP ${status}.`,
        );
      }
    }
  }
}
