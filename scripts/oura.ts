type HistoryStatus = {
  connection: "disconnected" | "connected" | "reconnect_required";
  history: {
    status: "pending" | "complete" | "retryable";
    pages_imported: number;
  } | null;
};

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Set ${name} before using the Oura owner command.`);
  }
  return value;
}

async function api<T>(path: string, method = "GET"): Promise<T> {
  const functionsUrl = env("OURA_FUNCTIONS_URL").replace(/\/+$/, "");
  const response = await fetch(`${functionsUrl}/oura-oauth/${path}`, {
    method,
    headers: { authorization: `Bearer ${env("OURA_OWNER_ACCESS_TOKEN")}` },
    redirect: "error",
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      result.error ?? `Oura owner request failed (${response.status}).`,
    );
  }
  return result;
}

async function openBrowser(url: string) {
  const os = Deno.build.os;
  const executable = os === "darwin"
    ? "open"
    : os === "windows"
    ? "rundll32.exe"
    : "xdg-open";
  const args = os === "windows" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = new Deno.Command(executable, {
      args,
      stdout: "null",
      stderr: "null",
    }).spawn();
    if ((await child.status).success) return;
  } catch {
    // Print the consent URL so the owner can open it when a browser is unavailable.
  }
  console.log(url);
}

async function main() {
  const [command, option, ...remaining] = Deno.args;
  const isConnect = command === "connect" || command === "reconnect";
  if (
    remaining.length ||
    (option !== undefined && (!isConnect || option !== "--no-open")) ||
    (!isConnect && command !== "status" && command !== "import")
  ) {
    throw new Error(
      "Usage: oura.ts connect|reconnect [--no-open] | status | import",
    );
  }

  if (isConnect) {
    const consent = await api<{ authorization_url: string }>("connect", "POST");
    if (option === "--no-open") {
      console.log(JSON.stringify(consent));
    } else {
      await openBrowser(consent.authorization_url);
      console.log("Complete Oura consent in the browser, then run status.");
    }
    return;
  }

  if (command === "status") {
    console.log(JSON.stringify(await api<HistoryStatus>("status")));
    return;
  }

  let previous = -1;
  while (true) {
    const status = await api<HistoryStatus>("import", "POST");
    const progress = status.history;
    if (status.connection !== "connected" || progress?.status !== "pending") {
      console.log(JSON.stringify(status));
      if (
        status.connection !== "connected" || progress?.status === "retryable"
      ) Deno.exitCode = 1;
      return;
    }
    if (progress.pages_imported <= previous) {
      throw new Error("Oura history import made no progress.");
    }
    previous = progress.pages_imported;
  }
}

try {
  await main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Oura owner command failed.",
  );
  Deno.exitCode = 1;
}
