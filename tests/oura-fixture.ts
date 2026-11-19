type Consent = { challenge: string; uri: string; account: string };
type Token = { account: string; active: boolean };

const consents = new Map<string, Consent>();
const accessTokens = new Map<string, Token>();
const refreshTokens = new Map<string, string>();

let sequence = 0;
let account = "synthetic-oura-account";
let failPage: number | null = null;
let rejectRefresh = false;
let exchanges = 0;
let refreshes = 0;
let historyAttempts: number[] = [];

function issueTokens(accountId: string): Response {
  sequence++;
  const access = `synthetic-access-${sequence}`;
  const refresh = `synthetic-refresh-${sequence}`;
  accessTokens.set(access, { account: accountId, active: true });
  refreshTokens.set(refresh, accountId);
  return Response.json({
    token_type: "bearer",
    access_token: access,
    refresh_token: refresh,
    expires_in: 3_600,
  });
}

const sleepHistory = [
  {
    data: [{
      id: "synthetic-sleep-a",
      day: "2024-03-10",
      timestamp: "2024-03-11T00:15:00+09:00",
      score: 82,
    }],
    next_token: "synthetic-second-page",
  },
  {
    data: [{
      id: "synthetic-sleep-b",
      day: "2024-03-11",
      timestamp: "2024-03-10T23:40:00-07:00",
      score: null,
    }],
    next_token: null,
  },
];

export async function ouraFixture(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const { pathname, searchParams } = url;
  if (pathname === "/fixture/reset" && req.method === "POST") {
    consents.clear();
    accessTokens.clear();
    refreshTokens.clear();
    account = "synthetic-oura-account";
    failPage = null;
    rejectRefresh = false;
    exchanges = 0;
    refreshes = 0;
    historyAttempts = [];
    return Response.json({});
  }
  if (pathname === "/fixture/configure" && req.method === "POST") {
    const config = await req.json();
    if ("fail_page" in config) failPage = config.fail_page;
    if ("account_id" in config) account = config.account_id;
    if ("reject_refresh" in config) rejectRefresh = config.reject_refresh;
    if (config.reject_access) {
      for (const token of accessTokens.values()) token.active = false;
    }
    return Response.json({});
  }
  if (pathname === "/fixture/stats") {
    return Response.json({
      exchanges,
      refreshes,
      history_attempts: historyAttempts,
    });
  }

  if (pathname === "/oauth/authorize" && req.method === "GET") {
    const challenge = searchParams.get("code_challenge");
    const uri = searchParams.get("redirect_uri");
    const state = searchParams.get("state");
    if (
      !challenge || !uri || !state ||
      searchParams.get("response_type") !== "code" ||
      searchParams.get("code_challenge_method") !== "S256"
    ) return Response.json({ error: "invalid_request" }, { status: 400 });
    const code = `synthetic-code-${++sequence}`;
    consents.set(code, { challenge, uri, account });
    const callback = new URL(uri);
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", state);
    return Response.redirect(callback, 302);
  }
  if (!req.headers.get("user-agent")?.startsWith("oura-sleep-metrics/")) {
    return Response.json({ error: "Missing fixture user agent" }, {
      status: 403,
    });
  }
  if (pathname === "/oauth/token" && req.method === "POST") {
    const parameters = new URLSearchParams(await req.text());
    if (!parameters.get("client_id") || !parameters.get("client_secret")) {
      return Response.json({ error: "invalid_client" }, { status: 401 });
    }
    const grant = parameters.get("grant_type");
    if (grant === "authorization_code") {
      exchanges++;
      const code = parameters.get("code") ?? "";
      const consent = consents.get(code);
      const verifier = parameters.get("code_verifier") ?? "";
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(verifier),
      );
      const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
        .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
      if (
        !consent || consent.uri !== parameters.get("redirect_uri") ||
        consent.challenge !== challenge
      ) return Response.json({ error: "invalid_grant" }, { status: 400 });
      consents.delete(code);
      return issueTokens(consent.account);
    }
    if (grant === "refresh_token") {
      refreshes++;
      const refresh = parameters.get("refresh_token") ?? "";
      const refreshAccount = refreshTokens.get(refresh);
      if (rejectRefresh || !refreshAccount) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      refreshTokens.delete(refresh);
      return issueTokens(refreshAccount);
    }
    return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
  }

  const authorization = req.headers.get("authorization");
  const token = accessTokens.get(authorization?.replace(/^Bearer /, "") ?? "");
  if (!token?.active) {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }

  if (pathname === "/v2/usercollection/personal_info") {
    return Response.json({ id: token.account });
  }
  if (pathname === "/v2/usercollection/daily_sleep") {
    const start = searchParams.get("start_date");
    const end = searchParams.get("end_date");
    if (!start || start > "2024-03-10" || !end || end < "2024-03-11") {
      return Response.json({ data: [], next_token: null });
    }
    const page = searchParams.has("next_token") ? 2 : 1;
    historyAttempts.push(page);
    if (failPage === page) {
      return Response.json({ error: "temporary_failure" }, { status: 503 });
    }
    return Response.json(sleepHistory[page - 1]);
  }
  return new Response("Fixture route missing.", { status: 404 });
}

if (import.meta.main) {
  Deno.serve(
    {
      hostname: Deno.env.get("TEST_OURA_FIXTURE_HOST") ?? "127.0.0.1",
      port: Number(Deno.env.get("TEST_OURA_FIXTURE_PORT") ?? 8788),
    },
    ouraFixture,
  );
}
