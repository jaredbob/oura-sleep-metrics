import { requiredEnv } from "./db.ts";
import { HttpError } from "./http.ts";

export async function requireOwner(req: Request): Promise<string> {
  const authorization = req.headers.get("authorization");
  if (!authorization || !/^Bearer \S+$/i.test(authorization)) {
    throw new HttpError(401, "Owner access required.");
  }

  const response = await fetch(
    new URL("/auth/v1/user", requiredEnv("SUPABASE_URL")),
    {
      headers: { authorization, apikey: supabasePublishableKey() },
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    },
  );
  if (response.status === 401 || response.status === 403) {
    throw new HttpError(401, "Owner access required.");
  }
  if (!response.ok) throw new HttpError(503, "Supabase Auth is unavailable.");

  const { id, is_anonymous } = await response.json();
  const ownerId = requiredEnv("OURA_OWNER_ID");
  if (id !== ownerId || is_anonymous === true) {
    throw new HttpError(403, "Owner access required.");
  }
  return ownerId;
}

function supabasePublishableKey(): string {
  const keys = Deno.env.get("SUPABASE_PUBLISHABLE_KEYS");
  const publishable = keys ? JSON.parse(keys).default : undefined;
  if (typeof publishable === "string" && publishable) return publishable;
  return Deno.env.get("SUPABASE_PUBLISHABLE_KEY") ??
    requiredEnv("SUPABASE_ANON_KEY");
}
