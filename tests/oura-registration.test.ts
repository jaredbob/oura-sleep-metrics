import {
  authorize,
  command,
  endpoint,
  equal,
  fixture,
  readOuraRows,
  required,
} from "./oura-test-support.ts";

async function importStatus(owner: string) {
  const response = await fetch(endpoint("import"), {
    method: "POST",
    headers: { authorization: `Bearer ${owner}` },
  });
  equal(response.status, 200);
  return await response.json();
}

Deno.test("Healthy Oura collections import history while missing webhook coverage retries", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const day = "2024-03-10";
  await fixture("configure", {
    fail_subscription_list: true,
    registration_failures: ["daily_readiness/delete"],
    collections: {
      daily_readiness: [{
        data: [{
          id: "synthetic-readiness-registration",
          day,
          timestamp: "2024-03-10T08:00:00Z",
          score: 79,
        }],
        next_token: null,
      }],
    },
  });
  equal((await fetch(await authorize(owner))).status, 200);

  const listed = await importStatus(owner);
  equal(listed.history.status, "retryable");
  equal(
    listed.webhooks.subscriptions.every(
      (row: { retry_reason: string }) => row.retry_reason === "listing_failed",
    ),
    true,
  );
  equal(await readOuraRows("oura_nightly", "day"), []);

  await fixture("configure", { fail_subscription_list: false });
  const partial = await importStatus(owner);
  equal(partial.history.status, "retryable");
  equal(
    partial.webhooks.subscriptions.filter(
      (row: { status: string }) => row.status === "active",
    ).length,
    26,
  );
  const failure = partial.webhooks.subscriptions.find(
    (row: { status: string }) => row.status === "retryable",
  );
  equal([
    failure.collection,
    failure.event_type,
    failure.retry_reason,
    Number.isFinite(Date.parse(failure.retry_at)),
  ], ["daily_readiness", "delete", "registration_failed", true]);
  equal(
    (await readOuraRows("oura_nightly", "day,sleep_score,readiness_score"))[0],
    { day, sleep_score: 82, readiness_score: null },
  );

  await fixture("configure", { registration_failures: [] });
  const recovered = await command(owner, "import");
  equal(recovered.ok, true);
  const status = JSON.parse(recovered.stdout);
  equal(status.history.status, "complete");
  equal(status.history.pages_imported, 10);
  equal(
    status.webhooks.subscriptions.every(
      (row: { status: string }) => row.status === "active",
    ),
    true,
  );
  equal(
    (await readOuraRows("oura_nightly", "day,sleep_score,readiness_score"))[0],
    { day, sleep_score: 82, readiness_score: 79 },
  );
});
