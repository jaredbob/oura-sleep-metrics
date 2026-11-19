import { getConnectionStatus, runHistoryImport } from "../_shared/history.ts";
import { HttpError, json } from "../_shared/http.ts";
import { beginConsent, finishConsent } from "../_shared/oura-connection.ts";
import { requireOwner } from "../_shared/owner.ts";

const routePrefix = /^\/(?:functions\/v1\/)?oura-oauth(?=\/|$)/;

export async function handleOuraOAuth(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const route = url.pathname.replace(routePrefix, "");
  try {
    if (route === "/callback" && req.method === "GET") {
      const ownerId = await finishConsent(url.searchParams);
      const runtime = (globalThis as {
        EdgeRuntime?: { waitUntil(work: Promise<unknown>): void };
      })
        .EdgeRuntime;
      runtime?.waitUntil(runHistoryImport(ownerId).catch(() => {}));
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
    if (route === "/import" && req.method === "POST") {
      return json(await runHistoryImport(await requireOwner(req)));
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
