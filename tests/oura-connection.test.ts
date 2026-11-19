function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function command(accessToken: string, ...args: string[]) {
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

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, received ${
        JSON.stringify(actual)
      }`,
    );
  }
}

Deno.test("Only the Supabase owner can start Oura consent", async () => {
  const other = await command(
    required("TEST_OURA_OTHER_ACCESS_TOKEN"),
    "connect",
    "--no-open",
  );
  equal(other.ok, false);
  equal(other.stderr.trim(), "Owner access required.");
  const owner = await command(
    required("TEST_OURA_OWNER_ACCESS_TOKEN"),
    "connect",
    "--no-open",
  );
  equal(owner.ok, true);
  const consent = new URL(JSON.parse(owner.stdout).authorization_url);
  equal(consent.searchParams.get("scope"), "daily personal");
  equal(consent.searchParams.get("code_challenge_method"), "S256");
  equal(Boolean(consent.searchParams.get("state")), true);
});

async function fixture(path: string, config?: object) {
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

async function authorize(ownerToken: string, action = "connect") {
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

async function readSql(relation: string, select: string, token?: string) {
  const headers = new Headers({
    apikey: required("TEST_OURA_SUPABASE_ANON_KEY"),
  });
  if (token) headers.set("authorization", `Bearer ${token}`);
  const url = new URL(
    `/rest/v1/${relation}`,
    required("TEST_OURA_SUPABASE_URL"),
  );
  url.search = new URLSearchParams({ select, order: "day" }).toString();
  const response = await fetch(url, { headers });
  return { status: response.status, rows: await response.json() };
}

Deno.test("Consent binds the owner, serializes refresh, and resumes paginated Sleep Scores", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const other = required("TEST_OURA_OTHER_ACCESS_TOKEN");
  await fixture("reset", {});

  const callback = await authorize(owner);
  const tampered = new URL(callback);
  tampered.searchParams.set("state", "a".repeat(43));
  equal((await fetch(tampered)).status, 400);
  equal((await fixture("stats")).exchanges, 0);

  const complete = await fetch(callback);
  if (!complete.ok) {
    throw new Error(
      `OAuth callback returned ${complete.status}: ${await complete.text()}`,
    );
  }
  equal((await fetch(callback)).status, 400);
  let status = JSON.parse((await command(owner, "status")).stdout);
  equal(status.connection, "connected");
  equal(status.history.status, "pending");

  await fixture("configure", { fail_page: 2, reject_access: true });
  const interrupted = await Promise.all([
    command(owner, "import"),
    command(owner, "import"),
  ]);
  for (const result of interrupted) equal(result.ok, false);
  status = JSON.parse((await command(owner, "status")).stdout);
  equal(status.history.status, "retryable");
  equal(status.history.pages_imported, 1);
  equal((await fixture("stats")).refreshes, 1);
  equal((await readSql("oura_nightly", "day,sleep_score", owner)).rows, [
    { day: "2024-03-10", sleep_score: 82 },
  ]);

  await fixture("configure", {
    fail_page: null,
    reject_access: true,
    reject_refresh: true,
  });
  equal((await command(owner, "import")).ok, false);
  status = JSON.parse((await command(owner, "status")).stdout);
  equal(status.connection, "reconnect_required");

  await fixture("configure", {
    account_id: "synthetic-other-account",
    reject_refresh: false,
  });
  equal((await fetch(await authorize(owner, "reconnect"))).status, 409);
  equal(
    JSON.parse((await command(owner, "status")).stdout).connection,
    "reconnect_required",
  );

  await fixture("configure", { account_id: "synthetic-oura-account" });
  equal((await fetch(await authorize(owner, "reconnect"))).status, 200);
  equal((await command(owner, "import")).ok, true);
  equal((await command(owner, "import")).ok, true);
  status = JSON.parse((await command(owner, "status")).stdout);
  equal(status.history.status, "complete");
  equal(status.history.pages_imported, 2);
  const nightly = await readSql("oura_nightly", "day,sleep_score", owner);
  equal(nightly, {
    status: 200,
    rows: [{ day: "2024-03-10", sleep_score: 82 }, {
      day: "2024-03-11",
      sleep_score: null,
    }],
  });
  const { rows } = await readSql(
    "oura_daily_sleep",
    "document_id,day,reported_at",
    owner,
  );
  equal(rows.map((row: { document_id: string }) => row.document_id), [
    "synthetic-sleep-a",
    "synthetic-sleep-b",
  ]);
  equal(
    new Date(rows[0].reported_at).toISOString(),
    "2024-03-10T15:15:00.000Z",
  );
  equal(await readSql("oura_nightly", "day,sleep_score", other), {
    status: 200,
    rows: [],
  });
  equal(await readSql("oura_daily_sleep", "document_id,day", other), {
    status: 200,
    rows: [],
  });
  const denied = await readSql("oura_nightly", "day,sleep_score");
  equal([401, 403].includes(denied.status), true);
});
