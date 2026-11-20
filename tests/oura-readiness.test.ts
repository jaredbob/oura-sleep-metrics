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

const overlapDay = "2024-03-10";
const readinessOnlyDay = "2024-03-12";
const recordedReadiness = {
  id: "synthetic-readiness-a",
  day: overlapDay,
  timestamp: "2024-03-11T00:30:00+09:00",
  score: 76,
  temperature_deviation: -0.4,
};
const partialReadiness = {
  id: "synthetic-readiness-b",
  day: readinessOnlyDay,
  timestamp: "2024-03-11T23:55:00-07:00",
  score: null,
  temperature_deviation: 0,
};

const nightlyColumns =
  "day,sleep_score,readiness_score,temperature_deviation_c";

Deno.test("Readiness history and signed notifications keep nightly data current", async (test) => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  await fixture("configure", {
    collections: {
      daily_readiness: [
        { data: [recordedReadiness], next_token: "synthetic-readiness-page-2" },
        { data: [partialReadiness], next_token: null },
      ],
    },
  });
  equal((await fetch(await authorize(owner))).status, 200);
  equal((await command(owner, "import")).ok, true);

  equal(await readOuraRows("oura_nightly", nightlyColumns), [
    {
      day: overlapDay,
      sleep_score: 82,
      readiness_score: 76,
      temperature_deviation_c: -0.4,
    },
    {
      day: "2024-03-11",
      sleep_score: null,
      readiness_score: null,
      temperature_deviation_c: null,
    },
    {
      day: readinessOnlyDay,
      sleep_score: null,
      readiness_score: null,
      temperature_deviation_c: 0,
    },
  ]);
  const documentColumns = "document_id,day,reported_at";
  const documents = await readOuraRows(
    "oura_daily_readiness",
    documentColumns,
  );
  equal(
    documents.map(({ document_id, day, reported_at }) => ({
      document_id,
      day,
      reported_at: new Date(reported_at).toISOString(),
    })),
    [
      {
        document_id: "synthetic-readiness-a",
        day: overlapDay,
        reported_at: "2024-03-10T15:30:00.000Z",
      },
      {
        document_id: "synthetic-readiness-b",
        day: readinessOnlyDay,
        reported_at: "2024-03-12T06:55:00.000Z",
      },
    ],
  );

  await test.step("Signed create, update, and delete preserve available nightly metrics", async () => {
    const { subscriptions } = await fixture("stats");
    equal(
      subscriptions.filter(({ data_type }: { data_type: string }) =>
        data_type === "daily_readiness"
      ).map(({ event_type }: { event_type: string }) => event_type).sort(),
      ["create", "delete", "update"],
    );

    const liveDay = "2024-03-13";
    const liveDocument = "synthetic-readiness-live";
    await fixture("configure", {
      documents: {
        [liveDocument]: {
          id: liveDocument,
          day: liveDay,
          timestamp: "2024-03-13T14:50:00+04:00",
          score: 89,
          temperature_deviation: 0.2,
        },
        [recordedReadiness.id]: {
          id: recordedReadiness.id,
          day: overlapDay,
          timestamp: recordedReadiness.timestamp,
          score: 73,
        },
      },
    });
    await notify("create", liveDocument, "2024-03-13T15:00:00Z");
    equal(await nightlyDay(liveDay), [{
      day: liveDay,
      sleep_score: null,
      readiness_score: 89,
      temperature_deviation_c: 0.2,
    }]);

    await notify("update", recordedReadiness.id, "2024-03-13T15:01:00Z");
    equal(await nightlyDay(overlapDay), [{
      day: overlapDay,
      sleep_score: 82,
      readiness_score: 73,
      temperature_deviation_c: null,
    }]);

    await notify("delete", recordedReadiness.id, "2024-03-13T15:02:00Z");
    equal(await nightlyDay(overlapDay), [{
      day: overlapDay,
      sleep_score: 82,
      readiness_score: null,
      temperature_deviation_c: null,
    }]);

    await notify("delete", liveDocument, "2024-03-13T15:03:00Z");
    equal(await nightlyDay(liveDay), []);
  });
});

async function notify(
  event_type: "create" | "update" | "delete",
  object_id: string,
  event_time: string,
) {
  const request = await signedNotification({
    event_type,
    event_time,
    object_id,
    data_type: "daily_readiness",
    user_id: "synthetic-oura-account",
  });
  equal((await fetch(endpoint("webhook"), request)).status, 200);
  equal((await runWorker()).status, 200);
}

async function nightlyDay(day: string): Promise<unknown[]> {
  const rows = await readOuraRows("oura_nightly", nightlyColumns);
  return rows.filter((row) => row.day === day);
}
