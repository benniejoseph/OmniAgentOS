#!/usr/bin/env node

const baseUrl = normalizeBaseUrl(
  process.env.OMNIAGENT_WORKER_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.BASE_URL,
);
const internalSecret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
const tenantId = process.env.OMNIAGENT_DEFAULT_TENANT || "default";
const intervalMs = normalizePositiveInteger(process.env.OMNIAGENT_WORKER_INTERVAL_MS, 5_000);
const limit = Math.min(normalizePositiveInteger(process.env.OMNIAGENT_WORKER_LIMIT, 5), 10);
const enableSlo = process.env.OMNIAGENT_WORKER_SLO !== "false";
const enableAlerts = process.env.OMNIAGENT_WORKER_ALERTS !== "false";

if (!baseUrl) {
  fail("OMNIAGENT_WORKER_BASE_URL, NEXT_PUBLIC_APP_URL, or BASE_URL is required.");
}

if (!internalSecret) {
  fail("OMNIAGENT_INTERNAL_AUTH_SECRET is required so the worker can authenticate as system.");
}

let shuttingDown = false;
process.on("SIGINT", () => {
  shuttingDown = true;
});
process.on("SIGTERM", () => {
  shuttingDown = true;
});

console.log(JSON.stringify({
  level: "info",
  message: "OmniAgentOS worker started.",
  baseUrl,
  intervalMs,
  limit,
  slo: enableSlo,
  alerts: enableAlerts,
}));

while (!shuttingDown) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl}/api/workflows/tick`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-omni-internal-auth": internalSecret,
        "x-omni-tenant-id": tenantId,
        "x-omni-user-id": "dedicated-worker",
        "x-omni-user-role": "system",
      },
      body: JSON.stringify({
        limit,
        slo: enableSlo,
        alerts: enableAlerts,
      }),
    });
    const body = await response.json().catch(() => ({}));
    console.log(JSON.stringify({
      level: response.ok ? "info" : "error",
      message: response.ok ? "Worker tick completed." : "Worker tick failed.",
      status: response.status,
      durationMs: Date.now() - startedAt,
      leased: body?.queue?.leased,
      completed: body?.queue?.completed,
      failed: body?.queue?.failed,
      requeued: body?.queue?.requeued,
      error: body?.error,
    }));
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "Worker tick threw.",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown worker error.",
    }));
  }

  await sleep(intervalMs);
}

console.log(JSON.stringify({ level: "info", message: "OmniAgentOS worker stopped." }));

function normalizeBaseUrl(value) {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fail(message) {
  console.error(JSON.stringify({ level: "error", message }));
  process.exit(1);
}
