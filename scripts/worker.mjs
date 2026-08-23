#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const heartbeatFile = "/tmp/omniagent-worker-heartbeat";
const baseUrl = normalizeBaseUrl(
  process.env.OMNIAGENT_WORKER_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.BASE_URL,
);
const internalSecret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
const vercelBypassSecret =
  process.env.VERCEL_AUTOMATION_BYPASS_SECRET?.trim();
const workerProtocol =
  process.env.OMNIAGENT_WORKER_PROTOCOL_VERSION?.trim() ||
  "1";
const releaseRevision =
  process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
  process.env.VERCEL_GIT_COMMIT_SHA?.trim();
const instanceId =
  process.env.FLY_MACHINE_ID?.trim() ||
  process.env.HOSTNAME?.trim() ||
  "dedicated-worker";
const tenantId = process.env.OMNIAGENT_DEFAULT_TENANT || "default";
const intervalMs = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKER_INTERVAL_MS,
  5_000,
);
const backgroundIntervalMs = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKER_BACKGROUND_INTERVAL_MS,
  5_000,
);
const maintenanceIntervalMs = Math.max(
  normalizePositiveInteger(
    process.env.OMNIAGENT_WORKER_MAINTENANCE_INTERVAL_MS,
    60_000,
  ),
  30_000,
);
const requestTimeoutMs = Math.min(
  normalizePositiveInteger(process.env.OMNIAGENT_WORKER_REQUEST_TIMEOUT_MS, 300_000),
  300_000,
);
const limit = Math.min(
  normalizePositiveInteger(process.env.OMNIAGENT_WORKER_LIMIT, 3),
  3,
);
const enableSlo = process.env.OMNIAGENT_WORKER_SLO !== "false";
const enableAlerts = process.env.OMNIAGENT_WORKER_ALERTS !== "false";
const enableRetention = process.env.OMNIAGENT_WORKER_RETENTION !== "false";
const retentionIntervalMs = Math.max(
  normalizePositiveInteger(process.env.OMNIAGENT_WORKER_RETENTION_INTERVAL_MS, 6 * 60 * 60 * 1_000),
  60 * 60 * 1_000,
);
const laneHeartbeats = new Map();
let heartbeatWrite = Promise.resolve();

if (!baseUrl) {
  fail("OMNIAGENT_WORKER_BASE_URL, NEXT_PUBLIC_APP_URL, or BASE_URL is required.");
}

if (!internalSecret) {
  fail("OMNIAGENT_INTERNAL_AUTH_SECRET is required so the worker can authenticate as system.");
}
let shuttingDown = false;
const activeControllers = new Set();
const shutdownController = new AbortController();
function beginShutdown() {
  shuttingDown = true;
  for (const controller of activeControllers) {
    controller.abort(new Error("Worker is shutting down."));
  }
  shutdownController.abort();
}
process.on("SIGINT", beginShutdown);
process.on("SIGTERM", beginShutdown);

console.log(JSON.stringify({
  level: "info",
  message: "OmniAgentOS worker started.",
  baseUrl,
  intervalMs,
  backgroundIntervalMs,
  maintenanceIntervalMs,
  limit,
  slo: enableSlo,
  alerts: enableAlerts,
  retention: enableRetention,
  retentionIntervalMs,
  workerProtocol,
  releaseRevision,
  instanceId,
}));

await Promise.all([
  runTickLane("fast", intervalMs, {
    limit,
    slo: false,
    alerts: false,
    timeBudgetMs: 45_000,
  }),
  runTickLane("background", backgroundIntervalMs, {
    limit: 1,
    slo: false,
    alerts: false,
    timeBudgetMs: 240_000,
  }),
  runTickLane("maintenance", maintenanceIntervalMs, {
    limit,
    slo: enableSlo,
    alerts: enableAlerts,
    maintenanceTenantLimit: limit,
    timeBudgetMs: 240_000,
  }),
  enableRetention ? runRetentionLoop() : Promise.resolve(),
]);

console.log(JSON.stringify({ level: "info", message: "OmniAgentOS worker stopped." }));

async function runTickLane(lane, cadenceMs, laneOptions) {
  let tenantCursor;
  while (!shuttingDown) {
    const startedAt = Date.now();
    try {
      await recordLaneState(lane, "running", startedAt);
      const { response, body } = await requestWorkerEndpoint(
        "/api/workflows/tick",
        {
          ...laneOptions,
          scope: "all_tenants",
          lane,
          ...(lane === "maintenance" ? { tenantCursor } : {}),
        },
        1_000_000,
      );
      if (response.ok) {
        if (lane === "maintenance") {
          tenantCursor =
            typeof body?.nextTenantCursor === "string"
              ? body.nextTenantCursor
              : undefined;
        }
        await recordLaneState(lane, "succeeded", startedAt);
      } else {
        await recordLaneState(lane, "failed", startedAt);
      }
      console.log(JSON.stringify({
        level: response.ok ? "info" : "error",
        message: response.ok
          ? `Worker ${lane} lane completed.`
          : `Worker ${lane} lane failed.`,
        lane,
        status: response.status,
        durationMs: Date.now() - startedAt,
        leased:
          body?.queue?.leased ?? body?.backgroundJobs?.leased,
        completed:
          body?.queue?.completed ?? body?.backgroundJobs?.completed,
        failed:
          body?.queue?.failed ?? body?.backgroundJobs?.failed,
        requeued: body?.queue?.requeued,
        maintenanceTenants: body?.maintenanceTenantIds?.length,
        nextTenantCursor: body?.nextTenantCursor,
        workerHeartbeatAt: body?.workerHeartbeat?.recordedAt,
        workerProtocol,
        releaseRevision,
        error: body?.error,
      }));
    } catch (error) {
      await recordLaneState(lane, "failed", startedAt).catch(() => undefined);
      console.error(JSON.stringify({
        level: "error",
        message: `Worker ${lane} lane threw.`,
        lane,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : "Unknown worker error.",
      }));
    }
    const remainingMs = Math.max(0, cadenceMs - (Date.now() - startedAt));
    await sleep(remainingMs, shutdownController.signal);
  }
}

async function recordLaneState(lane, status, startedAt) {
  const now = Date.now();
  const previous = laneHeartbeats.get(lane) || {};
  laneHeartbeats.set(lane, {
    ...previous,
    inFlight: status === "running",
    startedAt,
    ...(status === "succeeded" ? { lastSuccessAt: now } : {}),
    ...(status === "failed" ? { lastFailureAt: now } : {}),
  });
  heartbeatWrite = heartbeatWrite
    .catch(() => undefined)
    .then(() =>
      writeFile(
        heartbeatFile,
        `${JSON.stringify(Object.fromEntries(laneHeartbeats))}\n`,
        { mode: 0o600 },
      ),
    );
  await heartbeatWrite;
}

async function runRetentionLoop() {
  let delayMs = 0;
  while (!shuttingDown) {
    await sleep(delayMs, shutdownController.signal);
    if (shuttingDown) {
      break;
    }
    const retention = await runRetentionSweep();
    delayMs = !retention.succeeded
      ? Math.min(retentionIntervalMs, 5 * 60 * 1_000)
      : retention.moreAvailable
        ? 60 * 1_000
        : retentionIntervalMs;
  }
}

async function requestWorkerEndpoint(pathname, payload, maxBytes) {
  const controller = new AbortController();
  activeControllers.add(controller);
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error(`Worker request timed out after ${requestTimeoutMs}ms.`),
      ),
    requestTimeoutMs,
  );
  try {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: workerHeaders(),
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    return {
      response,
      body: await readJsonResponseLimited(response, maxBytes),
    };
  } finally {
    clearTimeout(timeout);
    activeControllers.delete(controller);
  }
}

function workerHeaders() {
  return {
    "content-type": "application/json",
    "x-omni-internal-auth": internalSecret,
    "x-omni-tenant-id": tenantId,
    "x-omni-user-id": "dedicated-worker",
    "x-omni-user-role": "system",
    "x-omni-worker-instance": instanceId,
    "x-omni-worker-protocol": workerProtocol,
    ...(vercelBypassSecret
      ? { "x-vercel-protection-bypass": vercelBypassSecret }
      : {}),
    ...(releaseRevision
      ? { "x-omni-worker-revision": releaseRevision }
      : {}),
  };
}

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

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function runRetentionSweep() {
  const startedAt = Date.now();
  try {
    const { response, body } = await requestWorkerEndpoint(
      "/api/security/retention",
      { scope: "all_tenants" },
      100_000,
    );
    console.log(JSON.stringify({
      level: response.ok ? "info" : "error",
      message: response.ok ? "Retention sweep completed." : "Retention sweep failed.",
      status: response.status,
      durationMs: Date.now() - startedAt,
      deleted: body?.result?.deleted,
      moreAvailable: body?.result?.moreAvailable,
      error: body?.error,
    }));
    return {
      succeeded: response.ok,
      moreAvailable: response.ok && body?.result?.moreAvailable === true,
    };
  } catch (error) {
    console.error(JSON.stringify({
      level: "error",
      message: "Retention sweep threw.",
      durationMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : "Unknown retention error.",
    }));
    return { succeeded: false, moreAvailable: false };
  }
}

async function readJsonResponseLimited(response, maxBytes) {
  if (!response.body) {
    return {};
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        throw new Error(`Worker response exceeded ${maxBytes} bytes.`);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text ? JSON.parse(text) : {};
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function fail(message) {
  console.error(JSON.stringify({ level: "error", message }));
  process.exit(1);
}
