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

const sleepDay = "2024-03-10";
const mainSession = {
  id: "synthetic-main-session",
  day: sleepDay,
  type: "long_sleep",
  bedtime_start: "2024-03-09T23:45:00+13:00",
  bedtime_end: "2024-03-10T07:55:00+12:00",
  total_sleep_duration: 26_400,
  average_hrv: 57,
  hrv: {
    timestamp: "2024-03-09T23:55:00.123456+13:00",
    interval: 300,
    items: [57.5, null, 0],
  },
};
const nap = {
  ...mainSession,
  id: "synthetic-nap",
  type: "sleep",
  total_sleep_duration: 2_700,
  average_hrv: 99,
};
const alternate = {
  ...mainSession,
  id: "synthetic-other-long-session",
  bedtime_end: "2024-03-10T12:00:00+12:00",
  total_sleep_duration: 11_400,
  average_hrv: 38,
  hrv: { ...mainSession.hrv, items: [38] },
};
const missing = {
  ...mainSession,
  id: "synthetic-unavailable-hrv",
  day: "2024-03-20",
  bedtime_start: "2024-03-19T23:45:00+13:00",
  bedtime_end: "2024-03-20T07:55:00+13:00",
  average_hrv: null,
  hrv: null,
};

function nightly(token?: string) {
  return readSql(
    "oura_nightly",
    "day,sleep_score,sleep_session_document_id,average_hrv",
    token,
  );
}

function samples(token?: string) {
  return readSql(
    "oura_hrv_samples",
    "sleep_session_document_id,sample_index,sampled_at,hrv",
    token,
    "sleep_session_document_id,sample_index",
  );
}

Deno.test("History imports Main Sleep Session HRV by Oura day and timestamped sample slots", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  await fixture("configure", {
    collections: {
      sleep: [
        {
          data: [mainSession, nap],
          next_token: "synthetic-session-page-two",
        },
        { data: [alternate, missing], next_token: null },
      ],
    },
  });
  equal((await fetch(await authorize(owner))).status, 200);
  equal((await command(owner, "import")).ok, true);
  equal(await nightly(owner), {
    status: 200,
    rows: [
      {
        day: "2024-03-10",
        sleep_score: 82,
        sleep_session_document_id: mainSession.id,
        average_hrv: 57,
      },
      {
        day: "2024-03-11",
        sleep_score: null,
        sleep_session_document_id: null,
        average_hrv: null,
      },
      {
        day: "2024-03-20",
        sleep_score: null,
        sleep_session_document_id: missing.id,
        average_hrv: null,
      },
    ],
  });
  equal(await samples(owner), {
    status: 200,
    rows: [
      {
        sleep_session_document_id: mainSession.id,
        sample_index: 0,
        sampled_at: "2024-03-09T10:55:00.123456+00:00",
        hrv: 57.5,
      },
      {
        sleep_session_document_id: mainSession.id,
        sample_index: 1,
        sampled_at: "2024-03-09T11:00:00.123456+00:00",
        hrv: null,
      },
      {
        sleep_session_document_id: mainSession.id,
        sample_index: 2,
        sampled_at: "2024-03-09T11:05:00.123456+00:00",
        hrv: 0,
      },
    ],
  });
  const other = required("TEST_OURA_OTHER_ACCESS_TOKEN");
  equal(await nightly(other), { status: 200, rows: [] });
  equal(await samples(other), { status: 200, rows: [] });
  equal((await samples()).status, 401);
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
    data_type: "sleep",
    user_id: "synthetic-oura-account",
  });
  equal((await fetch(endpoint("webhook"), request)).status, 200);
  equal((await runWorker()).status, 200);
}

type NightlyRow = {
  day: string;
  sleep_score: number | null;
  sleep_session_document_id: string | null;
  average_hrv: number | null;
};

async function readNight(
  owner: string,
  day: string,
): Promise<NightlyRow | null> {
  const { status, rows } = await nightly(owner);
  equal(status, 200);
  return rows.find((row: NightlyRow) => row.day === day) ?? null;
}

type HrvSample = {
  sleep_session_document_id: string;
  sample_index: number;
  sampled_at: string;
  hrv: number | null;
};

async function readSessionSamples(
  owner: string,
  documentId: string,
): Promise<HrvSample[]> {
  const { status, rows } = await samples(owner);
  equal(status, 200);
  return rows.filter((row: HrvSample) =>
    row.sleep_session_document_id === documentId
  );
}

Deno.test("Signed Sleep Session deliveries create, replace, and delete the corresponding HRV samples", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const session = {
    ...mainSession,
    id: "synthetic-live-main-session",
    day: "2024-03-21",
    bedtime_start: "2024-03-20T23:45:00+13:00",
    bedtime_end: "2024-03-21T07:55:00+13:00",
    average_hrv: 63,
    hrv: {
      timestamp: "2024-03-20T23:55:00+13:00",
      interval: 300,
      items: [62, 64],
    },
  };
  await fixture("configure", { documents: { [session.id]: session } });
  await notify("create", session.id, "2024-03-22T01:00:00Z");
  equal(await readNight(owner, session.day), {
    day: session.day,
    sleep_score: null,
    sleep_session_document_id: session.id,
    average_hrv: 63,
  });
  equal(await readSessionSamples(owner, session.id), [
    {
      sleep_session_document_id: session.id,
      sample_index: 0,
      sampled_at: "2024-03-20T10:55:00+00:00",
      hrv: 62,
    },
    {
      sleep_session_document_id: session.id,
      sample_index: 1,
      sampled_at: "2024-03-20T11:00:00+00:00",
      hrv: 64,
    },
  ]);

  const corrected = {
    ...session,
    day: "2024-03-22",
    average_hrv: 42,
    hrv: { timestamp: "2024-03-21T00:15:00+13:00", interval: 300, items: [42] },
  };
  await fixture("configure", { documents: { [session.id]: corrected } });
  await notify("update", session.id, "2024-03-22T01:10:00Z");
  equal(await readNight(owner, session.day), null);
  equal(await readNight(owner, corrected.day), {
    day: corrected.day,
    sleep_score: null,
    sleep_session_document_id: session.id,
    average_hrv: 42,
  });
  equal(await readSessionSamples(owner, session.id), [
    {
      sleep_session_document_id: session.id,
      sample_index: 0,
      sampled_at: "2024-03-20T11:15:00+00:00",
      hrv: 42,
    },
  ]);

  await notify("delete", session.id, "2024-03-22T01:20:00Z");
  await notify("update", session.id, "2024-03-22T01:15:00Z");
  equal(await readNight(owner, corrected.day), null);
  equal(await readSessionSamples(owner, session.id), []);
});

Deno.test("A Sleep Session reclassified as a nap stops contributing HRV", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  await fixture("configure", {
    documents: { [mainSession.id]: { ...mainSession, type: "late_nap" } },
  });
  await notify("update", mainSession.id, "2024-03-22T02:00:00Z");
  equal(await readNight(owner, sleepDay), {
    day: sleepDay,
    sleep_score: 82,
    sleep_session_document_id: alternate.id,
    average_hrv: 38,
  });
  equal(await readSessionSamples(owner, mainSession.id), []);
  equal(
    (await readSessionSamples(owner, alternate.id)).map(({ hrv }) => hrv),
    [38],
  );
});
