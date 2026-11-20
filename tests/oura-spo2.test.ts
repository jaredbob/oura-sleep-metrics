import {
  authorize,
  command,
  endpoint,
  equal,
  fixture,
  readOuraRows,
  required,
  runWorker,
  signedNotification,
} from "./oura-test-support.ts";

const sleepDay = "2024-03-10";
const spo2Record = {
  id: "synthetic-spo2-a",
  day: sleepDay,
  spo2_percentage: { average: 97.125 },
};
const spo2Columns = "document_id,day,average_spo2";
const nightlyColumns = "day,sleep_score,average_spo2";

Deno.test("Reconnect grants Overnight SpO₂ and imports history alongside existing Sleep Scores", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  await fixture("configure", {
    decline_scope: "spo2",
    collections: {
      daily_spo2: [
        { data: [spo2Record], next_token: "synthetic-spo2-second-page" },
        {
          data: [
            {
              id: "synthetic-spo2-b",
              day: "2024-03-12",
              spo2_percentage: null,
            },
            {
              id: "synthetic-spo2-c",
              day: "2024-03-13",
              spo2_percentage: { average: 94.25 },
            },
          ],
          next_token: null,
        },
      ],
    },
  });
  equal((await fetch(await authorize(owner))).status, 200);
  const interrupted = await command(owner, "import");
  equal(interrupted.ok, false);
  const { history } = JSON.parse(interrupted.stdout);
  equal({
    status: history.status,
    pages_imported: history.pages_imported,
    pending: history.pending,
    retryable: history.retryable,
    complete: history.complete,
  }, {
    status: "retryable",
    pages_imported: 9,
    pending: 0,
    retryable: 1,
    complete: 8,
  });
  equal(
    history.collections.map((
      { collection, status }: { collection: string; status: string },
    ) => [collection, status]),
    [
      ["daily_cardiovascular_age", "complete"],
      ["daily_readiness", "complete"],
      ["daily_resilience", "complete"],
      ["daily_sleep", "complete"],
      ["daily_spo2", "retryable"],
      ["daily_stress", "complete"],
      ["enhanced_tag", "complete"],
      ["sleep", "complete"],
      ["vo2_max", "complete"],
    ],
  );
  const sleepBeforeReconnect = [
    { document_id: "synthetic-sleep-a", day: sleepDay, sleep_score: 82 },
    {
      document_id: "synthetic-sleep-b",
      day: "2024-03-11",
      sleep_score: null,
    },
  ];
  const sleepColumns = "document_id,day,sleep_score";
  equal(
    await readOuraRows("oura_daily_sleep", sleepColumns),
    sleepBeforeReconnect,
  );
  equal(await readOuraRows("oura_daily_spo2", spo2Columns), []);

  // Remove the synthetic Sleep Scores from the history response before reconnect.
  await fixture("configure", {
    decline_scope: null,
    collections: { daily_sleep: [{ data: [], next_token: null }] },
  });
  equal((await fetch(await authorize(owner, "reconnect"))).status, 200);
  equal((await command(owner, "import")).ok, true);
  equal(
    await readOuraRows("oura_daily_sleep", sleepColumns),
    sleepBeforeReconnect,
  );
  equal(await readOuraRows("oura_daily_spo2", spo2Columns), [
    { document_id: "synthetic-spo2-a", day: sleepDay, average_spo2: 97.125 },
    {
      document_id: "synthetic-spo2-b",
      day: "2024-03-12",
      average_spo2: null,
    },
    {
      document_id: "synthetic-spo2-c",
      day: "2024-03-13",
      average_spo2: 94.25,
    },
  ]);
  equal(await readOuraRows("oura_nightly", nightlyColumns), [
    { day: sleepDay, sleep_score: 82, average_spo2: 97.125 },
    { day: "2024-03-11", sleep_score: null, average_spo2: null },
    { day: "2024-03-12", sleep_score: null, average_spo2: null },
    { day: "2024-03-13", sleep_score: null, average_spo2: 94.25 },
  ]);
});

Deno.test("Signed Overnight SpO₂ changes preserve a Sleep Score with the same document ID", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const day = "2024-03-20";
  const id = "synthetic-overnight-webhook";
  const sleepKey = `daily_sleep/${id}`;
  const spo2Key = `daily_spo2/${id}`;
  const baseline = {
    id,
    day,
    timestamp: "2024-03-21T00:15:00+09:00",
    score: 85,
  };
  await fixture("configure", { documents: { [sleepKey]: baseline } });
  equal((await fetch(await authorize(owner))).status, 200);

  async function deliver(
    data_type: string,
    event_type: string,
    event_time: string,
  ) {
    const request = await signedNotification({
      data_type,
      event_type,
      event_time,
      object_id: id,
      user_id: "synthetic-oura-account",
    });
    equal((await fetch(endpoint("webhook"), request)).status, 200);
    equal((await runWorker()).status, 200);
  }

  async function nightly(average: number | null) {
    const rows = await readOuraRows(
      "oura_nightly",
      nightlyColumns,
    );
    equal(rows.filter((row) => row.day === day), [
      { day, sleep_score: 85, average_spo2: average },
    ]);
  }

  await deliver("daily_sleep", "create", "2024-03-21T12:00:00Z");
  await nightly(null);

  await fixture("configure", {
    documents: { [spo2Key]: { id, day, spo2_percentage: { average: 96.5 } } },
  });
  await deliver("daily_spo2", "create", "2024-03-21T12:00:00Z");
  await nightly(96.5);

  await fixture("configure", {
    documents: { [spo2Key]: { id, day, spo2_percentage: { average: 97.25 } } },
  });
  await deliver("daily_spo2", "update", "2024-03-21T12:05:00Z");
  await nightly(97.25);

  await fixture("configure", { documents: { [spo2Key]: null } });
  await deliver("daily_spo2", "delete", "2024-03-21T12:10:00Z");
  await nightly(null);
  const rows = await readOuraRows("oura_daily_spo2", spo2Columns);
  equal(
    rows.some((row) => row.document_id === id),
    false,
  );
});
