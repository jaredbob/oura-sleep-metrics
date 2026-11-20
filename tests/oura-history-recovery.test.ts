import {
  authorize,
  command,
  endpoint,
  equal,
  fixture,
  readOuraRows,
  required,
} from "./oura-test-support.ts";

const owner = required("TEST_OURA_OWNER_ACCESS_TOKEN");

type ImportStatus = {
  collection: string;
  status: string;
  pages_imported: number;
};

async function advanceHistory() {
  const response = await fetch(endpoint("import"), {
    method: "POST",
    headers: { authorization: `Bearer ${owner}` },
  });
  equal(response.status, 200);
  return (await response.json()).history.collections as ImportStatus[];
}

function collectionStatus(jobs: ImportStatus[], name: string) {
  const job = jobs.find((entry) => entry.collection === name)!;
  return [job.status, job.pages_imported];
}

Deno.test("History resumes after the provider rejects a saved cursor or returns a cursor cycle", async () => {
  const score = {
    id: "synthetic-cursor-sleep",
    day: "2024-03-10",
    timestamp: "2024-03-10T08:00:00Z",
    score: 82,
  };
  const readiness = { ...score, id: "synthetic-cursor-readiness", score: 91 };
  await fixture("configure", {
    collections: {
      daily_sleep: [{ data: [score], next_token: "synthetic-invalid-cursor" }],
      daily_readiness: [
        { data: [readiness], next_token: "synthetic-cycle-a" },
        { data: [], next_token: "synthetic-cycle-b" },
        { data: [], next_token: "synthetic-cycle-a" },
      ],
    },
  });
  equal((await fetch(await authorize(owner))).status, 200);
  const interrupted = await advanceHistory();
  equal(collectionStatus(interrupted, "daily_sleep"), ["retryable", 0]);
  equal(collectionStatus(interrupted, "daily_readiness"), ["retryable", 0]);
  equal(collectionStatus(interrupted, "daily_spo2"), ["complete", 1]);
  equal(
    await readOuraRows("oura_nightly", "sleep_score,readiness_score"),
    [
      { sleep_score: 82, readiness_score: 91 },
    ],
  );

  await fixture("configure", {
    collections: {
      daily_sleep: [{ data: [{ ...score, score: 93 }], next_token: null }],
      daily_readiness: [{
        data: [{ ...readiness, score: 88 }],
        next_token: null,
      }],
    },
  });
  const recovered = await command(owner, "import");
  equal(recovered.ok, true);
  const jobs = JSON.parse(recovered.stdout).history.collections;
  equal(collectionStatus(jobs, "daily_sleep"), ["complete", 1]);
  equal(collectionStatus(jobs, "daily_readiness"), ["complete", 1]);
  equal(collectionStatus(jobs, "daily_spo2"), ["complete", 1]);
  equal(
    await readOuraRows("oura_nightly", "sleep_score,readiness_score"),
    [
      { sleep_score: 93, readiness_score: 88 },
    ],
  );
});
