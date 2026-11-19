import {
  authorize,
  command,
  endpoint,
  equal,
  fixture,
  readSql,
  required,
  runWorker,
  signedNotification,
} from "./oura-test-support.ts";

Deno.test("The Oura receiver answers the verification challenge only with the valid token", async () => {
  const url = endpoint("webhook");
  url.searchParams.set("challenge", "synthetic-oura-challenge");
  url.searchParams.set("verification_token", "synthetic-incorrect-token");
  equal((await fetch(url)).status, 401);
  url.searchParams.set(
    "verification_token",
    required("OURA_WEBHOOK_VERIFICATION_TOKEN"),
  );
  const verified = await fetch(url);
  equal(verified.status, 200);
  equal(await verified.json(), { challenge: "synthetic-oura-challenge" });
});

Deno.test("Only authentic, related Oura notifications are accepted", async () => {
  equal(
    (await fetch(await authorize(required("TEST_OURA_OWNER_ACCESS_TOKEN"))))
      .status,
    200,
  );
  const document = {
    event_type: "update",
    data_type: "daily_sleep",
    object_id: "synthetic-sleep-a",
    event_time: "2024-03-21T12:00:00Z",
    user_id: "synthetic-oura-account",
  };
  const valid = await signedNotification(document);
  const forged = {
    ...valid,
    body: valid.body.replace("synthetic-sleep-a", "synthetic-forged-object"),
  };
  equal((await fetch(endpoint("webhook"), forged)).status, 401);
  const unrelated = await signedNotification({
    ...document,
    user_id: "synthetic-unrelated-account",
    object_id: "synthetic-unrelated-object",
  });
  equal((await fetch(endpoint("webhook"), unrelated)).status, 403);
  equal((await fetch(endpoint("webhook"), valid)).status, 200);
});

const syntheticDocument = "synthetic-sleep-webhook";
const sleepDay = "2024-03-20";
const sleepRecord = {
  id: syntheticDocument,
  day: sleepDay,
  timestamp: "2024-03-21T00:15:00+09:00",
  score: 91,
};

async function notify(
  event_type: string,
  event_time: string,
  object_id = syntheticDocument,
) {
  const request = await signedNotification({
    event_type,
    event_time,
    object_id,
    data_type: "daily_sleep",
    user_id: "synthetic-oura-account",
  });
  equal((await fetch(endpoint("webhook"), request)).status, 200);
}

async function nightly(day: string): Promise<unknown[]> {
  const { status, rows } = await readSql(
    "oura_nightly",
    "day,sleep_score",
    required("TEST_OURA_OWNER_ACCESS_TOKEN"),
  );
  equal(status, 200);
  return rows.filter((row: { day: string }) => row.day === day);
}

async function worker() {
  equal((await runWorker()).status, 200);
}

Deno.test("History already being fetched cannot restore a deleted or stale Sleep Score", async () => {
  const baselineId = "synthetic-sleep-a";
  const baselineDay = "2024-03-10";
  const correctionId = "synthetic-sleep-b";
  const correctionDay = "2024-03-11";
  await fixture("configure", { hold_page: 2 });
  const importing = command(required("TEST_OURA_OWNER_ACCESS_TOKEN"), "import");
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      if ((await fixture("stats")).history_held) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    equal((await fixture("stats")).history_held, true);
    const { subscriptions } = await fixture("stats");
    equal(
      subscriptions.filter((entry: { data_type: string }) =>
        entry.data_type === "daily_sleep"
      )
        .map((entry: { event_type: string }) => entry.event_type).sort(),
      ["create", "delete", "update"],
    );
    equal(await nightly(baselineDay), [{ day: baselineDay, sleep_score: 82 }]);
    // Any other snapshot request fails while this earlier response is in flight.
    await fixture("configure", {
      fail_page: 2,
      documents: {
        [correctionId]: {
          id: correctionId,
          day: correctionDay,
          timestamp: "2024-03-10T23:40:00-07:00",
          score: 67,
        },
      },
    });
    await notify("delete", "2024-03-22T12:40:00Z", baselineId);
    await notify("update", "2024-03-22T12:41:00Z", correctionId);
    await worker();
    equal(
      (await fixture("stats")).document_attempts,
      [baselineId, correctionId],
    );
  } finally {
    await fixture("configure", { release_history: true, fail_page: null });
  }
  equal((await importing).ok, true);
  equal(await nightly(baselineDay), []);
  equal(await nightly(correctionDay), [{
    day: correctionDay,
    sleep_score: 67,
  }]);
});

Deno.test("An accepted Sleep Score survives temporary provider failure and duplicate delivery", async () => {
  equal((await fetch(endpoint("work"), { method: "POST" })).status, 401);
  await fixture("configure", {
    documents: { [syntheticDocument]: sleepRecord },
    fail_document: syntheticDocument,
  });
  const eventTime = "2024-03-21T12:30:00Z";
  await notify("create", eventTime);
  await worker();
  equal(await nightly(sleepDay), []);
  equal(
    (await fixture("stats")).document_attempts.filter((id: string) =>
      id === syntheticDocument
    ),
    [syntheticDocument],
  );
  await fixture("configure", { fail_document: null });

  // The first failed attempt is eligible again after its retry delay.
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    await worker();
    if ((await nightly(sleepDay)).length) break;
  }
  equal(await nightly(sleepDay), [{ day: sleepDay, sleep_score: 91 }]);

  await notify("create", "2024-03-21T08:30:00-04:00");
  await worker();
  equal(
    (await fixture("stats")).document_attempts.filter((id: string) =>
      id === syntheticDocument
    ),
    [syntheticDocument, syntheticDocument],
  );

  await fixture("configure", {
    documents: { [syntheticDocument]: { ...sleepRecord, score: 74 } },
  });
  await notify("update", "2024-03-21T12:35:00Z");
  await worker();
  equal(await nightly(sleepDay), [{ day: sleepDay, sleep_score: 74 }]);

  await notify("delete", "2024-03-21T12:40:00Z");
  await worker();
  equal(await nightly(sleepDay), []);

  // Leave the source returning a document to prove delayed work cannot restore it.
  await notify("update", "2024-03-21T12:36:00Z");
  await notify("update", "2024-03-21T12:40:00Z");
  await worker();
  equal(await nightly(sleepDay), []);
  equal(
    (await fixture("stats")).document_attempts.filter((id: string) =>
      id === syntheticDocument
    ),
    [syntheticDocument, syntheticDocument, syntheticDocument],
  );
});
