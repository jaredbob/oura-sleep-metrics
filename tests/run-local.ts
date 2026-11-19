// Run against a disposable local Supabase stack after applying the migrations.
import { sql } from "../supabase/functions/_shared/db.ts";
import { handleOuraOAuth } from "../supabase/functions/oura-oauth/handler.ts";
import { ouraFixture } from "./oura-fixture.ts";

const required = (name: string) => {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Set ${name} from the disposable Supabase stack.`);
  }
  return value;
};

const supabaseUrl = new URL(required("TEST_OURA_SUPABASE_URL"));
const dbUrl = new URL(required("TEST_OURA_DB_URL"));
const anonKey = required("TEST_OURA_SUPABASE_ANON_KEY");
for (const url of [supabaseUrl, dbUrl]) {
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Error("Integration tests require a loopback Supabase stack.");
  }
}

const [testFile, extra] = Deno.args;
if (!testFile || extra) throw new Error("Pass one integration test file.");

const fixture = Deno.serve({ hostname: "127.0.0.1", port: 0 }, ouraFixture);
const functions = Deno.serve(
  { hostname: "127.0.0.1", port: 0 },
  handleOuraOAuth,
);
try {
  const fixtureUrl = `http://127.0.0.1:${fixture.addr.port}`;
  const functionsUrl = `http://127.0.0.1:${functions.addr.port}/functions/v1`;
  const webhookUrl = `${functionsUrl}/oura-oauth/webhook`;
  const clientSecret = "synthetic-oura-client-secret";
  const verificationToken = "synthetic-local-verification-token";
  const workerSecret = "synthetic-local-worker-credential-only";
  const testSettings = {
    SUPABASE_URL: supabaseUrl.href,
    SUPABASE_DB_URL: dbUrl.href,
    OURA_CLIENT_ID: "synthetic-oura-client-id",
    OURA_CLIENT_SECRET: clientSecret,
    OURA_API_BASE_URL: fixtureUrl,
    OURA_AUTHORIZE_URL: `${fixtureUrl}/oauth/authorize`,
    OURA_REDIRECT_URI: `${functionsUrl}/oura-oauth/callback`,
    OURA_WEBHOOK_URL: webhookUrl,
    OURA_WEBHOOK_VERIFICATION_TOKEN: verificationToken,
    OURA_WORKER_SECRET: workerSecret,
    TEST_OURA_FIXTURE_URL: fixtureUrl,
    TEST_OURA_FUNCTIONS_URL: functionsUrl,
  };
  for (const [key, value] of Object.entries(testSettings)) {
    Deno.env.set(key, value);
  }
  Deno.env.set(
    "SUPABASE_PUBLISHABLE_KEYS",
    JSON.stringify({ default: anonKey }),
  );

  const [owner, other] = await Promise.all([signUp(), signUp()]);
  Deno.env.set("OURA_OWNER_ID", owner.user.id);
  const result = await new Deno.Command(Deno.execPath(), {
    args: ["test", "--allow-env", "--allow-net", "--allow-run", testFile],
    env: {
      TEST_OURA_OWNER_ACCESS_TOKEN: owner.access_token,
      TEST_OURA_OTHER_ACCESS_TOKEN: other.access_token,
    },
  }).spawn().status;
  Deno.exitCode = result.code;
} finally {
  await Promise.all([functions.shutdown(), fixture.shutdown()]);
  await sql().end();
}

async function signUp(): Promise<
  { access_token: string; user: { id: string } }
> {
  const response = await fetch(new URL("/auth/v1/signup", supabaseUrl), {
    method: "POST",
    headers: { apikey: anonKey, "content-type": "application/json" },
    body: JSON.stringify({
      email: `oura-test-${crypto.randomUUID()}@example.invalid`,
      password: crypto.randomUUID(),
    }),
  });
  const result = await response.json();
  if (!response.ok || !result?.access_token || !result.user?.id) {
    throw new Error(
      "Synthetic signup requires local Auth with email confirmation disabled.",
    );
  }
  return result;
}
