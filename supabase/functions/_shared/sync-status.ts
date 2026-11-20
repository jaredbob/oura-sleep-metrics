import { collections } from "./collections.ts";
import { sql } from "./db.ts";
import { repairStatus } from "./repair.ts";
import { getSubscriptionStatus } from "./webhook-subscriptions.ts";

type ImportJob = {
  collection: string;
  status: "complete" | "pending" | "retryable";
  pages_imported: number;
  updated_at: Date | null;
  retry_reason?: "consent_required";
};

type DeliveryCounts = {
  collection: string;
  pending: number;
  failed: number;
};

export async function getConnectionStatus(ownerId: string) {
  const [connection] = await sql()<{
    status: string;
    connected_at: Date;
    missing_scopes: string[];
  }[]>`
    select status, connected_at, missing_scopes
    from oura_private.connections where owner_id = ${ownerId}
  `;
  if (!connection) {
    return {
      connection: "disconnected",
      connected_at: null,
      history: null,
      webhooks: null,
      repair: null,
    };
  }

  const [jobs, subscriptions, deliveries, repair] = await Promise.all([
    sql()<ImportJob[]>`
      select expected.collection, coalesce(jobs.status, 'pending') as status,
             coalesce(jobs.pages_imported, 0) as pages_imported, jobs.updated_at
      from unnest(${
      sql().array(collections.map(({ name }) => name))
    }::text[]) as expected(collection)
      left join oura_private.import_jobs jobs
        on jobs.collection = expected.collection and jobs.owner_id = ${ownerId}
      order by expected.collection
    `,
    getSubscriptionStatus(),
    sql()<DeliveryCounts[]>`
      select collection,
             count(*) filter (where not failed)::integer as pending,
             count(*) filter (where failed)::integer as failed
      from (
        select collection, retry_reason is not null or
               (lease is not null and available_at <= now()) as failed
        from oura_private.webhook_deliveries
        where owner_id = ${ownerId} and processed_at is null
      ) outstanding
      group by collection
    `,
    repairStatus(ownerId),
  ]);

  const registrationFailures = new Set(
    subscriptions.filter(({ retry_reason }) => retry_reason !== null)
      .map(({ collection }) => collection),
  );
  const consentRequired = new Set(
    collections.filter(({ scope }) =>
      scope && connection.missing_scopes.includes(scope)
    ).map(({ name }) => name),
  );
  const imports: ImportJob[] = jobs.map((job) =>
    consentRequired.has(job.collection)
      ? { ...job, status: "retryable", retry_reason: "consent_required" }
      : registrationFailures.has(job.collection)
      ? { ...job, status: "retryable" }
      : job
  );
  const completed = imports.filter((job) => job.status === "complete").length;
  const retryable = imports.filter((job) => job.status === "retryable").length;
  const pending = imports.length - completed - retryable;
  const updated = Math.max(
    ...imports.map((job) => job.updated_at?.getTime() ?? -Infinity),
  );
  const byCollection = collections.map(({ name }) =>
    deliveries.find((delivery) => delivery.collection === name) ??
      { collection: name, pending: 0, failed: 0 }
  );

  return {
    connection: connection.status,
    connected_at: connection.connected_at,
    history: imports.length === 0 ? null : {
      status: retryable ? "retryable" : pending ? "pending" : "complete",
      pages_imported: imports.reduce(
        (total, job) => total + job.pages_imported,
        0,
      ),
      updated_at: Number.isFinite(updated) ? new Date(updated) : null,
      pending,
      retryable,
      complete: completed,
      collections: imports,
    },
    repair,
    webhooks: {
      subscriptions,
      deliveries: {
        pending: deliveries.reduce(
          (total, delivery) => total + delivery.pending,
          0,
        ),
        failed: deliveries.reduce(
          (total, delivery) => total + delivery.failed,
          0,
        ),
        collections: byCollection,
      },
    },
  };
}
