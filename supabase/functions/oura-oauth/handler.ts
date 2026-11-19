import { requiredEnv } from "../_shared/db.ts";
import {
  ensureSubscriptions,
  renewSubscriptions,
} from "../_shared/webhook-subscriptions.ts";
import { runWebhookWork } from "../_shared/webhook-work.ts";
import { runHistoryImport } from "../_shared/history.ts";
import { requestRepair, runRepairWork } from "../_shared/repair.ts";
import { getConnectionStatus } from "../_shared/sync-status.ts";
import { HttpError, json } from "../_shared/http.ts";
import { beginConsent, finishConsent } from "../_shared/oura-connection.ts";
import { requireOwner } from "../_shared/owner.ts";

import {
  acceptNotification,
  sameSecret,
  verifyWebhook,
} from "../_shared/webhook.ts";

const routePrefix = /^\/(?:functions\/v1\/)?oura-oauth(?=\/|$)/;

export async function handleOuraOAuth(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const route = url.pathname.replace(routePrefix, "");
  try {
    if (route === "/webhook" && req.method === "GET") {
      return await verifyWebhook(url.searchParams);
    }
    if (route === "/webhook" && req.method === "POST") {
      const inserted = await acceptNotification(req);
      if (inserted) {
        background(() => runWebhookWork(requiredEnv("OURA_OWNER_ID")));
      }
      return json({ accepted: true });
    }
    if (route === "/work" && req.method === "POST") {
      const given = req.headers.get("authorization")?.match(/^Bearer (.+)$/i)
        ?.[1];
      if (
        !given || !await sameSecret(given, requiredEnv("OURA_WORKER_SECRET"))
      ) {
        throw new HttpError(401, "Oura worker access required.");
      }
      const ownerId = requiredEnv("OURA_OWNER_ID");
      const completed = await Promise.allSettled([
        runWebhookWork(ownerId),
        runRepairWork(ownerId),
        renewSubscriptions(),
        syncInitialHistory(ownerId, 1, true),
      ]);
      if (completed.some((result) => result.status === "rejected")) {
        throw new Error("Scheduled Oura work failed.");
      }
      return json({ processed: true });
    }
    if (route === "/callback" && req.method === "GET") {
      const ownerId = await finishConsent(url.searchParams);
      background(() => syncInitialHistory(ownerId));
      return new Response(
        "Oura is connected. Use the owner command to check import status.",
        {
          headers: {
            "cache-control": "no-store",
            "content-type": "text/plain; charset=utf-8",
            "referrer-policy": "no-referrer",
          },
        },
      );
    }
    if (route === "/connect" && req.method === "POST") {
      const ownerId = await requireOwner(req);
      return json({ authorization_url: await beginConsent(ownerId) });
    }
    if (route === "/status" && req.method === "GET") {
      return json(await getConnectionStatus(await requireOwner(req)));
    }
    if (route === "/repair" && req.method === "POST") {
      return json(await requestRepair(await requireOwner(req), req));
    }
    if (route === "/import" && req.method === "POST") {
      const ownerId = await requireOwner(req);
      await syncInitialHistory(ownerId);
      return json(await getConnectionStatus(ownerId));
    }
    return json({ error: "Oura route not found." }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 503;
    const message = error instanceof HttpError
      ? error.message
      : "Oura integration is temporarily unavailable.";
    if (route === "/callback") {
      return new Response(message, {
        status,
        headers: {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
          "referrer-policy": "no-referrer",
        },
      });
    }
    return json({ error: message }, status);
  }
}

async function syncInitialHistory(
  ownerId: string,
  pageLimit = 5,
  scheduled = false,
) {
  await ensureSubscriptions(ownerId);
  await runHistoryImport(ownerId, pageLimit, scheduled);
}

function background(work: () => Promise<unknown>) {
  const runtime = (globalThis as {
    EdgeRuntime?: { waitUntil(work: Promise<unknown>): void };
  }).EdgeRuntime;
  runtime?.waitUntil(work().catch(() => {}));
}
