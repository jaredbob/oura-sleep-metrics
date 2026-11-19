import {
  authorize,
  command,
  equal,
  fixture,
  readSql,
  required,
  runWorker,
} from "./oura-test-support.ts";

const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
const other = required("TEST_OURA_OTHER_ACCESS_TOKEN");

async function status() {
  const response = await command(owner, "status");
  equal(response.ok, true);
  return JSON.parse(response.stdout);
}

async function worker() {
  equal((await runWorker()).status, 200);
}

type Subscription = {
  collection: string;
  event_type: string;
  status: string;
  expires_at: string;
  retry_at: string | null;
};

function sleepSubscription(
  sync: Awaited<ReturnType<typeof status>>,
  type: string,
): Subscription {
  const subscription = sync.webhooks.subscriptions.find(
    (entry: Subscription) =>
      entry.collection === "daily_sleep" && entry.event_type === type,
  );
  if (!subscription) {
    throw new Error(`Missing daily_sleep/${type} subscription`);
  }
  return subscription;
}

Deno.test("The scheduled worker renews Oura subscriptions, reports failures, and preserves webhook delivery", async (test) => {
  await fixture("configure", {
    subscription_lifetimes: {
      "daily_sleep/create": 3_600_000,
      "daily_sleep/update": 3_600_000,
      "daily_sleep/delete": 8_000,
    },
    renewal_failures: ["daily_sleep/update", "daily_sleep/delete"],
  });
  equal((await fetch(await authorize(owner))).status, 200);
  equal((await command(owner, "import")).ok, true);

  const before = await status();
  const original = sleepSubscription(before, "create");
  equal(original.status, "renewal_pending");
  equal((await command(other, "status")).ok, false);

  await test.step("Renewal stores Oura's expiration and a failed renewal retains its coverage", async () => {
    await Promise.all([worker(), worker()]);
    const after = await status();
    const renewed = sleepSubscription(after, "create");
    const failed = sleepSubscription(after, "update");
    equal(renewed.status, "active");
    equal(failed.status, "retryable");
    equal(failed.expires_at, sleepSubscription(before, "update").expires_at);
    equal(Number.isFinite(Date.parse(failed.retry_at ?? "")), true);
    const stats = await fixture("stats");
    equal(stats.renewals.sort(), [
      "daily_sleep/create",
      "daily_sleep/delete",
      "daily_sleep/update",
    ]);
    const provider = stats.subscriptions.find((
      entry: { data_type: string; event_type: string },
    ) => entry.data_type === "daily_sleep" && entry.event_type === "create");
    equal(new Date(renewed.expires_at).toISOString(), provider.expiration_time);
    equal(
      Date.parse(renewed.expires_at) > Date.parse(original.expires_at),
      true,
    );
    equal(after.history, before.history);
  });

  await test.step("Renewed delivery and transient failures recover independently", async () => {
    const id = "synthetic-sleep-renewal";
    const day = "2024-03-20";
    await fixture("configure", {
      documents: {
        [id]: { id, day, timestamp: "2024-03-20T07:20:00-04:00", score: 89 },
      },
      fail_document: id,
    });
    equal(
      await fixture("deliver", {
        data_type: "daily_sleep",
        event_type: "create",
        object_id: id,
        event_time: "2024-03-20T15:00:00Z",
        user_id: "synthetic-oura-account",
      }),
      { status: 200 },
    );
    let health = (await status()).webhooks.deliveries;
    equal([health.pending, health.failed], [1, 0]);
    await worker();
    health = (await status()).webhooks.deliveries;
    equal([health.pending, health.failed], [0, 1]);
    equal(
      health.collections.find((row: { collection: string }) =>
        row.collection === "daily_sleep"
      ),
      { collection: "daily_sleep", pending: 0, failed: 1 },
    );

    await fixture("configure", {
      renewal_failures: ["daily_sleep/delete"],
      fail_document: null,
    });
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      await worker();
      const latest = await status();
      if (
        latest.webhooks.deliveries.failed === 0 &&
        sleepSubscription(latest, "update").status === "active"
      ) break;
    }

    const recovered = await status();
    equal(sleepSubscription(recovered, "update").status, "active");
    equal(sleepSubscription(recovered, "update").retry_at, null);
    equal([
      recovered.webhooks.deliveries.pending,
      recovered.webhooks.deliveries.failed,
    ], [0, 0]);
    equal(recovered.history, before.history);
    const nightly = await readSql("oura_nightly", "day,sleep_score", owner);
    equal(nightly.status, 200);
    equal(nightly.rows.find((row: { day: string }) => row.day === day), {
      day,
      sleep_score: 89,
    });
    const stats = await fixture("stats");
    equal(
      stats.renewals.filter((key: string) => key === "daily_sleep/create")
        .length,
      1,
    );
    equal(
      stats.renewals.filter((key: string) => key === "daily_sleep/update")
        .length,
      2,
    );
  });

  await test.step("Expired coverage is visible until the worker replaces the subscription", async () => {
    const expiresAt = Date.parse(
      sleepSubscription(before, "delete").expires_at,
    );
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, expiresAt - Date.now() + 25))
    );
    equal(sleepSubscription(await status(), "delete").status, "expired");
    await fixture("configure", {
      subscription_lifetimes: {},
      renewal_failures: [],
    });
    await worker();
    const replacement = sleepSubscription(await status(), "delete");
    equal(replacement.status, "active");
    equal(Date.parse(replacement.expires_at) > expiresAt, true);
  });
});
