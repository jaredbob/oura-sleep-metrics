export function ouraApiFetch(
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers);
  headers.set("User-Agent", "oura-sleep-metrics/1.0");
  return fetch(
    new URL(
      path,
      Deno.env.get("OURA_API_BASE_URL") ?? "https://api.ouraring.com",
    ),
    {
      ...init,
      headers,
      redirect: "error",
      signal: AbortSignal.timeout(8_000),
    },
  );
}
