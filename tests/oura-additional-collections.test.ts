import {
  assertOuraDataApiDenied,
  authorize,
  command,
  equal,
  fixture,
  readOuraRows,
  required,
  runWorker,
} from "./oura-test-support.ts";

const day = "2024-03-10";
const nextDay = "2024-03-11";
const lastDay = "2024-03-12";
const tag = {
  id: "synthetic-span-tag",
  tag_type_code: "custom",
  custom_name: "Synthetic custom tag",
  comment: "synthetic-comment-that-must-not-be-stored",
  start_day: day,
  end_day: lastDay,
  start_time: `${day}T21:00:00-05:00`,
  end_time: `${lastDay}T09:00:00-05:00`,
};
const pointTag = {
  id: "synthetic-point-tag",
  tag_type_code: "tag_generic_caffeine",
  start_day: day,
  start_time: `${day}T07:15:00`,
};
const vo2Max = {
  id: "synthetic-vo2-estimate",
  day,
  timestamp: `${nextDay}T00:30:00+09:00`,
  vo2_max: 42,
};
const stress = {
  id: "synthetic-stress-day",
  day,
  day_summary: "normal",
  stress_high: 3_600,
  recovery_high: 1_200,
};

function page(...data: object[]) {
  return [{ data, next_token: null }];
}

type History = {
  history: {
    collections: {
      collection: string;
      status: string;
      retry_reason?: string;
    }[];
  };
};

function consentRequired(status: History) {
  return status.history.collections.filter(({ retry_reason }) =>
    retry_reason === "consent_required"
  ).map(({ collection }) => collection);
}

Deno.test("Additional Oura collections isolate missing consent and preserve document history", async () => {
  const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");
  await fixture("configure", {
    decline_scope: "stress",
    collections: {
      enhanced_tag: [
        { data: [tag], next_token: "synthetic-next-tag-page" },
        { data: [pointTag], next_token: null },
      ],
      daily_cardiovascular_age: page(
        {
          id: "synthetic-age",
          day,
          vascular_age: 42,
          pulse_wave_velocity: 7.3,
        },
        { id: "synthetic-age-empty", day: nextDay, pulse_wave_velocity: null },
      ),
      vO2_max: page(vo2Max),
      daily_stress: page(stress, {
        id: "synthetic-stress-empty",
        day: nextDay,
      }),
      daily_resilience: page({
        id: "synthetic-resilience",
        day,
        level: "strong",
        contributors: {
          sleep_recovery: 71.5,
          daytime_recovery: 43,
          stress: 25.5,
        },
      }),
    },
  });

  equal((await fetch(await authorize(owner))).status, 200);
  const partial = await command(owner, "import");
  equal(partial.ok, false);
  const status = JSON.parse(partial.stdout);
  equal(status.connection, "connected");
  equal(consentRequired(status), ["daily_resilience", "daily_stress"]);
  equal(status.history.complete, 7);
  equal((await fixture("stats")).refreshes, 0);

  const tags = await readOuraRows("oura_enhanced_tag", "*", "day,document_id");
  equal(
    tags.map((row: Record<string, unknown>) => [
      row.document_id,
      row.day,
      row.end_day,
      row.start_time,
      row.end_time,
      row.tag_type_code,
      row.custom_name,
    ]),
    [
      [
        pointTag.id,
        day,
        null,
        pointTag.start_time,
        null,
        pointTag.tag_type_code,
        null,
      ],
      [
        tag.id,
        day,
        lastDay,
        tag.start_time,
        tag.end_time,
        tag.tag_type_code,
        tag.custom_name,
      ],
    ],
  );
  equal(tags.some((row: object) => "comment" in row), false);
  equal(
    await readOuraRows(
      "oura_daily_cardiovascular_age",
      "day,vascular_age,pulse_wave_velocity_m_per_s",
    ),
    [
      { day, vascular_age: 42, pulse_wave_velocity_m_per_s: 7.3 },
      { day: nextDay, vascular_age: null, pulse_wave_velocity_m_per_s: null },
    ],
  );
  const vo2 = (await readOuraRows(
    "oura_vo2_max",
    "day,reported_at,vo2_max_ml_per_kg_min",
  ))[0];
  equal([
    vo2.day,
    Date.parse(String(vo2.reported_at)),
    vo2.vo2_max_ml_per_kg_min,
  ], [
    day,
    Date.parse(vo2Max.timestamp),
    42,
  ]);
  equal(await readOuraRows("oura_daily_stress", "day"), []);
  equal(await readOuraRows("oura_nightly", "day"), [{ day }, {
    day: nextDay,
  }]);

  const blocked = await command(owner, "repair", day, day);
  equal(blocked.ok, false);
  const repair = JSON.parse(blocked.stdout).repair;
  equal(repair.collections.daily_stress.retry_reason, "consent_required");
  equal(repair.collections.enhanced_tag.status, "complete");

  await fixture("configure", { decline_scope: null });
  equal((await fetch(await authorize(owner, "reconnect"))).status, 200);
  equal((await command(owner, "import")).ok, true);
  equal((await runWorker()).status, 200);
  const restored = JSON.parse((await command(owner, "status")).stdout);
  equal(restored.repair.status, "complete");
  equal(consentRequired(restored), []);
  equal(
    await readOuraRows(
      "oura_daily_stress",
      "day,day_summary,stress_high_seconds,recovery_high_seconds",
    ),
    [
      {
        day,
        day_summary: "normal",
        stress_high_seconds: 3_600,
        recovery_high_seconds: 1_200,
      },
      {
        day: nextDay,
        day_summary: null,
        stress_high_seconds: null,
        recovery_high_seconds: null,
      },
    ],
  );
  equal(
    await readOuraRows(
      "oura_daily_resilience",
      "day,level,sleep_recovery,daytime_recovery,stress",
    ),
    [
      {
        day,
        level: "strong",
        sleep_recovery: 71.5,
        daytime_recovery: 43,
        stress: 25.5,
      },
    ],
  );

  for (
    const collection of [
      "enhanced_tag",
      "daily_cardiovascular_age",
      "vo2_max",
      "daily_stress",
      "daily_resilience",
    ]
  ) {
    equal(
      restored.webhooks.subscriptions.filter((
        entry: { collection: string; status: string },
      ) => entry.collection === collection && entry.status === "active").length,
      3,
    );
  }

  await assertOuraDataApiDenied();

  await fixture("configure", {
    documents: {
      [`vO2_max/${vo2Max.id}`]: { ...vo2Max, vo2_max: 46 },
    },
  });
  equal(
    await fixture("deliver", {
      event_type: "update",
      data_type: "vo2_max",
      object_id: vo2Max.id,
      user_id: "synthetic-oura-account",
      event_time: `${nextDay}T13:00:00Z`,
    }),
    { status: 200 },
  );
  equal((await runWorker()).status, 200);
  equal(await readOuraRows("oura_vo2_max", "vo2_max_ml_per_kg_min"), [
    { vo2_max_ml_per_kg_min: 46 },
  ]);
  equal(
    await fixture("deliver", {
      event_type: "delete",
      data_type: "vo2_max",
      object_id: vo2Max.id,
      user_id: "synthetic-oura-account",
      event_time: `${nextDay}T14:00:00Z`,
    }),
    { status: 200 },
  );
  equal((await runWorker()).status, 200);
  equal(await readOuraRows("oura_vo2_max", "day"), []);

  await fixture("configure", {
    collections: {
      enhanced_tag: page({
        ...tag,
        start_day: nextDay,
        start_time: `${nextDay}T20:00:00-05:00`,
      }),
    },
  });
  const moved = await command(owner, "repair", day, day);
  equal(moved.ok, true);
  equal(
    JSON.parse(moved.stdout).repair.collections.enhanced_tag.documents_checked,
    2,
  );
  equal(
    await readOuraRows("oura_enhanced_tag", "document_id,day,end_day"),
    [
      { document_id: tag.id, day: nextDay, end_day: lastDay },
    ],
  );

  await fixture("configure", { report_scopes: true, decline_scope: "tag" });
  equal((await fetch(await authorize(owner, "reconnect"))).status, 200);
  equal(consentRequired(JSON.parse((await command(owner, "status")).stdout)), [
    "enhanced_tag",
  ]);
});
