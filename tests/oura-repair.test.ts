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

const day = "2024-03-10";
const nextDay = "2024-03-11";
const sleep = {
  id: "synthetic-repair-sleep",
  day,
  timestamp: "2024-03-11T00:30:00Z",
  score: 86,
};
const readiness = {
  id: "synthetic-repair-readiness",
  day,
  timestamp: "2024-03-11T00:30:00Z",
  score: 72,
  temperature_deviation: -0.4,
};
const spo2 = {
  id: "synthetic-repair-spo2",
  day,
  spo2_percentage: { average: 97.5 },
};
const session = {
  id: "synthetic-repair-session",
  day,
  type: "long_sleep",
  bedtime_start: "2024-03-09T21:00:00-04:00",
  bedtime_end: "2024-03-10T06:00:00-04:00",
  total_sleep_duration: 28_000,
  average_hrv: 54,
  hrv: {
    timestamp: "2024-03-09T22:00:00-04:00",
    interval: 300,
    items: [54, 60],
  },
};

const onePage = (
  ...data: Record<string, unknown>[]
) => [{ data, next_token: null }];

function nightly(owner: string) {
  return readSql(
    "oura_nightly",
    "day,sleep_score,readiness_score,temperature_deviation_c,average_spo2,sleep_session_document_id,average_hrv",
    owner,
  );
}

function samples(owner: string) {
  return readSql(
    "oura_hrv_samples",
    "sleep_session_document_id,sampled_at,hrv",
    owner,
    "sleep_session_document_id,sample_index",
  );
}

function repairRequest(token: string, start_day: string, end_day: string) {
  return fetch(endpoint("repair"), {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ start_day, end_day }),
  });
}

Deno.test("Only the owner can repair an inclusive range across all four Oura collections", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const other = required("TEST_OURA_OTHER_ACCESS_TOKEN");
  equal((await fetch(endpoint("repair"), { method: "POST" })).status, 401);
  equal((await repairRequest(other, day, day)).status, 403);
  equal((await repairRequest(owner, day, day)).status, 409);
  equal((await repairRequest(owner, "2024-02-30", day)).status, 400);
  equal((await repairRequest(owner, nextDay, day)).status, 400);
  equal((await fetch(await authorize(owner))).status, 200);
  equal((await command(owner, "import")).ok, true);
  const corrected = { ...sleep, id: "synthetic-sleep-a" };
  await fixture("configure", {
    collections: {
      daily_sleep: onePage(corrected, { ...sleep, day: nextDay }),
      daily_readiness: onePage(readiness),
      daily_spo2: onePage(spo2),
      sleep: onePage(session),
    },
  });
  const repaired = await command(owner, "repair", day, day);
  equal(repaired.ok, true);
  const { repair } = JSON.parse(repaired.stdout);
  equal([repair.start_day, repair.end_day, repair.status], [
    day,
    day,
    "complete",
  ]);
  equal(Object.keys(repair.collections).sort(), [
    "daily_readiness",
    "daily_sleep",
    "daily_spo2",
    "sleep",
  ]);
  equal(await nightly(owner), {
    status: 200,
    rows: [
      {
        day,
        sleep_score: 86,
        readiness_score: 72,
        temperature_deviation_c: -0.4,
        average_spo2: 97.5,
        sleep_session_document_id: session.id,
        average_hrv: 54,
      },
      {
        day: nextDay,
        sleep_score: null,
        readiness_score: null,
        temperature_deviation_c: null,
        average_spo2: null,
        sleep_session_document_id: null,
        average_hrv: null,
      },
    ],
  });
  equal(await samples(owner), {
    status: 200,
    rows: [
      {
        sleep_session_document_id: session.id,
        sampled_at: "2024-03-10T02:00:00+00:00",
        hrv: 54,
      },
      {
        sleep_session_document_id: session.id,
        sampled_at: "2024-03-10T02:05:00+00:00",
        hrv: 60,
      },
    ],
  });
  equal(await nightly(other), { status: 200, rows: [] });
  const status = await command(owner, "status");
  equal(JSON.parse(status.stdout).repair.status, "complete");
});

Deno.test("An incomplete listing or failed document check preserves HRV until Oura confirms deletion", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const firstPage = { data: [], next_token: "synthetic-repair-page-two" };
  const movedSpo2 = { ...spo2, day: nextDay };
  const revisedReadiness = { ...readiness, temperature_deviation: 0.5 };
  const priorAttempts = (await fixture("stats")).document_attempts.length;
  await fixture("configure", {
    collections: {
      daily_readiness: onePage(revisedReadiness),
      daily_spo2: onePage(),
      sleep: [firstPage, { data: [] }],
    },
    documents: { [session.id]: null, [spo2.id]: movedSpo2 },
  });

  const interrupted = await command(owner, "repair", day, day);
  equal(interrupted.ok, false);
  const interruption = JSON.parse(interrupted.stdout).repair;
  equal(interruption.status, "retryable");
  equal(interruption.collections.sleep.pages_imported, 1);
  equal(interruption.collections.sleep.retry_reason, "list_request_failed");
  equal(interruption.collections.daily_readiness.status, "complete");
  equal((await fixture("stats")).document_attempts.slice(priorAttempts), [
    spo2.id,
  ]);
  equal((await samples(owner)).rows.length, 2);

  await fixture("configure", {
    collections: { sleep: [firstPage, { data: [], next_token: null }] },
    fail_document: session.id,
  });
  const failedCheck = await command(owner, "repair", day, day);
  equal(failedCheck.ok, false);
  const failure = JSON.parse(failedCheck.stdout).repair.collections.sleep;
  equal(failure.pages_imported, 2);
  equal(failure.phase, "checking");
  equal(failure.retry_reason, "document_check_failed");
  equal((await samples(owner)).rows.length, 2);

  await fixture("configure", { fail_document: null });
  const recovered = await command(owner, "repair", day, day);
  equal(recovered.ok, true);
  equal(JSON.parse(recovered.stdout).repair.status, "complete");
  equal(await samples(owner), { status: 200, rows: [] });
  const expected = {
    status: 200,
    rows: [
      {
        day,
        sleep_score: 86,
        readiness_score: 72,
        temperature_deviation_c: 0.5,
        average_spo2: null,
        sleep_session_document_id: null,
        average_hrv: null,
      },
      {
        day: nextDay,
        sleep_score: null,
        readiness_score: null,
        temperature_deviation_c: null,
        average_spo2: 97.5,
        sleep_session_document_id: null,
        average_hrv: null,
      },
    ],
  };
  equal(await nightly(owner), expected);
  equal((await command(owner, "repair", day, day)).ok, true);
  equal(await nightly(owner), expected);
});

async function notify(
  event_type: string,
  data_type: string,
  object_id: string,
) {
  const request = await signedNotification({
    event_type,
    data_type,
    object_id,
    event_time: "2024-03-22T12:00:00Z",
    user_id: "synthetic-oura-account",
  });
  equal((await fetch(endpoint("webhook"), request)).status, 200);
  equal((await runWorker()).status, 200);
}

async function waitForFixture(flag: string) {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await fixture("stats"))[flag]) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Expected fixture state ${flag}.`);
}

Deno.test("Newer webhook reads win over a stale repair page and a stale direct lookup", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const scoreId = "synthetic-sleep-a";
  const liveSession = { ...session, id: "synthetic-ongoing-session" };
  await fixture("configure", {
    collections: {
      daily_sleep: onePage({ ...sleep, id: scoreId, score: 71 }),
      sleep: onePage(liveSession),
    },
    hold_page: 1,
  });
  const oldPage = command(owner, "repair", day, day);
  try {
    await waitForFixture("history_held");
    await fixture("configure", {
      documents: { [scoreId]: { ...sleep, id: scoreId, score: 98 } },
    });
    await notify("update", "daily_sleep", scoreId);
  } finally {
    await fixture("configure", { release_history: true });
  }
  equal((await oldPage).ok, true);
  equal((await nightly(owner)).rows[0].sleep_score, 98);
  equal((await samples(owner)).rows.length, 2);

  await fixture("configure", {
    collections: {
      daily_sleep: onePage({ ...sleep, id: scoreId, score: 98 }),
      sleep: onePage(),
    },
    documents: { [liveSession.id]: null },
    hold_document: liveSession.id,
  });
  const oldAbsence = command(owner, "repair", day, day);
  try {
    await waitForFixture("document_held");
    await fixture("configure", {
      documents: {
        [liveSession.id]: {
          ...liveSession,
          average_hrv: 78,
          hrv: { ...liveSession.hrv, items: [78] },
        },
      },
    });
    await notify("update", "sleep", liveSession.id);
    equal((await nightly(owner)).rows[0].average_hrv, 78);
  } finally {
    await fixture("configure", { release_document: true });
  }
  equal((await oldAbsence).ok, true);
  equal((await nightly(owner)).rows[0].average_hrv, 78);
  equal((await samples(owner)).rows, [
    {
      sleep_session_document_id: liveSession.id,
      sampled_at: "2024-03-10T02:00:00+00:00",
      hrv: 78,
    },
  ]);
});

Deno.test("A scheduled worker finishes repair pages after the owner request returns", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const last = {
    ...readiness,
    id: "synthetic-late-repair-document",
    day: "2024-03-20",
  };
  await fixture("configure", {
    collections: {
      daily_readiness: Array.from(
        { length: 15 },
        (_, page) =>
          page < 14
            ? { data: [], next_token: `synthetic-repair-page-${page}` }
            : { data: [last], next_token: null },
      ),
    },
  });
  const queued = await command(owner, "repair", last.day, last.day);
  equal(queued.ok, true);
  equal(JSON.parse(queued.stdout).repair.status, "pending");
  equal(
    (await nightly(owner)).rows.some((row: { day: string }) =>
      row.day === last.day
    ),
    false,
  );
  equal((await runWorker()).status, 200);
  const status = await command(owner, "status");
  const repaired = JSON.parse(status.stdout).repair;
  equal(repaired.status, "complete");
  equal(repaired.collections.daily_readiness.pages_imported, 15);
  equal(
    (await nightly(owner)).rows.find((row: { day: string }) =>
      row.day === last.day
    )?.readiness_score,
    72,
  );
});

Deno.test("A stale webhook fetch cannot resurrect an HRV session deleted by repair", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  const local = { ...session, id: "synthetic-stale-webhook-session" };
  await fixture("configure", { collections: { sleep: onePage(local) } });
  equal((await command(owner, "repair", day, day)).ok, true);

  await fixture("configure", {
    collections: { sleep: onePage() },
    documents: { [local.id]: local },
    hold_document: local.id,
  });
  const staleDelivery = notify("update", "sleep", local.id);
  try {
    await waitForFixture("document_held");
    await fixture("configure", { documents: { [local.id]: null } });
    equal((await command(owner, "repair", day, day)).ok, true);
    equal(
      (await samples(owner)).rows.some((
        row: { sleep_session_document_id: string },
      ) => row.sleep_session_document_id === local.id),
      false,
    );
  } finally {
    await fixture("configure", { release_document: true });
  }
  await staleDelivery;
  equal(await samples(owner), { status: 200, rows: [] });
  equal((await nightly(owner)).rows[0].average_hrv, null);
});
