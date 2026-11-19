type Subscription = {
  id: string;
  callback_url: string;
  event_type: "create" | "update" | "delete";
  data_type: string;
  expiration_time: string;
};

type SyntheticDocument = { id: string; day: string } & Record<string, unknown>;
type HistoryPage = { data: SyntheticDocument[]; next_token: string | null };

const userCollectionPath = /^\/v2\/usercollection\/([^/]+)(?:\/([^/]+))?$/;
const subscriptionPath = "/v2/webhook/subscription";
const subscriptions: Subscription[] = [];
let documentAttempts: string[] = [];
let documents = new Map<string, SyntheticDocument | null>();
const collections = new Map<string, HistoryPage[]>();
let failDocument: string | null = null;
let heldPage: number | null = null;
let releaseHistory: (() => void) | undefined;

export async function subscriptionFixture(
  req: Request,
): Promise<Response | undefined> {
  const { pathname } = new URL(req.url);
  if (!pathname.startsWith(subscriptionPath)) return;
  if (
    !req.headers.get("x-client-id") ||
    req.headers.get("x-client-secret") !== Deno.env.get("OURA_CLIENT_SECRET")
  ) return Response.json({ error: "invalid_client" }, { status: 401 });
  if (pathname === subscriptionPath && req.method === "GET") {
    return Response.json(subscriptions);
  }
  if (pathname === subscriptionPath && req.method === "POST") {
    const body = await req.json();
    const url = new URL(body.callback_url);
    const challenge = "synthetic-subscription-challenge";
    url.searchParams.set("challenge", challenge);
    url.searchParams.set("verification_token", body.verification_token);
    const verified = await fetch(url);
    if (!verified.ok || (await verified.json()).challenge !== challenge) {
      return Response.json({ error: "verification_failed" }, { status: 422 });
    }
    const subscription: Subscription = {
      id: crypto.randomUUID(),
      callback_url: body.callback_url,
      event_type: body.event_type,
      data_type: body.data_type,
      expiration_time: new Date(Date.now() + 86_400_000).toISOString(),
    };
    subscriptions.push(subscription);
    return Response.json(subscription, { status: 201 });
  }
  return Response.json({ error: "unknown_subscription_route" }, {
    status: 404,
  });
}

export function resetWebhookFixture() {
  subscriptions.length = 0;
  documentAttempts = [];
  documents.clear();
  collections.clear();
  failDocument = null;
  heldPage = null;
  releaseHistory?.();
}

export function configureWebhookFixture(config: Record<string, unknown>) {
  if ("documents" in config) {
    documents = new Map(
      Object.entries(
        config.documents as Record<string, SyntheticDocument | null>,
      ),
    );
  }
  if ("collections" in config) {
    for (
      const [collection, pages] of Object.entries(
        config.collections as Record<string, HistoryPage[]>,
      )
    ) {
      collections.set(collection, pages);
    }
  }
  if ("fail_document" in config) {
    failDocument = config.fail_document as string | null;
  }
  if ("hold_page" in config) heldPage = config.hold_page as number | null;
  if (config.release_history) releaseHistory?.();
}

export function webhookFixtureStats() {
  return {
    subscriptions,
    document_attempts: documentAttempts,
    history_held: releaseHistory !== undefined,
  };
}

export async function holdHistory(page: number) {
  if (heldPage !== page) return;
  heldPage = null;
  await new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  releaseHistory = undefined;
}

export function historyFixture(url: URL): Response | undefined {
  const match = userCollectionPath.exec(url.pathname);
  if (!match || match[2]) return;
  const pages = collections.get(match[1]);
  if (!pages) {
    if (["daily_readiness", "daily_spo2", "sleep"].includes(match[1])) {
      return Response.json({ data: [], next_token: null });
    }
    return;
  }
  const token = url.searchParams.get("next_token");
  const pageIndex = token === null
    ? 0
    : pages.findIndex((page) => page.next_token === token) + 1;
  const page = pages[pageIndex];
  if (!page || (pageIndex === 0 && token !== null)) {
    return Response.json({ error: "invalid_next_token" }, { status: 400 });
  }
  const start = url.searchParams.get("start_date") ?? "";
  const end = url.searchParams.get("end_date") ?? "9999-12-31";
  return Response.json({
    ...page,
    data: page.data.filter(({ day }) => day >= start && day <= end),
  });
}

export function documentFixture(
  pathname: string,
  sleepBaseline: SyntheticDocument[],
): Response | undefined {
  const match = userCollectionPath.exec(pathname);
  if (!match?.[2]) return;
  const collection = match[1];
  const id = decodeURIComponent(match[2]);
  const key = `${collection}/${id}`;
  documentAttempts.push(id);
  if (failDocument === id || failDocument === key) {
    return Response.json({ error: "temporary_failure" }, { status: 503 });
  }
  const baseline = collections.get(collection)?.flatMap((page) => page.data) ??
    (collection === "daily_sleep" ? sleepBaseline : []);
  const fixtureKey = documents.has(key) ? key : id;
  const document = documents.has(fixtureKey)
    ? documents.get(fixtureKey)
    : baseline.find((value) => value.id === id);
  if (document == null) {
    return Response.json({ error: "not_found" }, { status: 404 });
  }
  return Response.json(document);
}
