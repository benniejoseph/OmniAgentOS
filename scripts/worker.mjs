#!/usr/bin/env node

import { writeFile } from "node:fs/promises";

const heartbeatFile = "/tmp/omniagent-worker-heartbeat";
const baseUrl = normalizeBaseUrl(
  process.env.OMNIAGENT_WORKER_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.BASE_URL,
);
const internalSecret = process.env.OMNIAGENT_INTERNAL_AUTH_SECRET?.trim();
const releaseRevision =
  process.env.OMNIAGENT_RELEASE_SHA?.trim() ||
  process.env.VERCEL_GIT_COMMIT_SHA?.trim();
const instanceId =
  process.env.FLY_MACHINE_ID?.trim() ||
  process.env.HOSTNAME?.trim() ||
  "dedicated-worker";
const tenantId = process.env.OMNIAGENT_DEFAULT_TENANT || "default";
const intervalMs = normalizePositiveInteger(process.env.OMNIAGENT_WORKER_INTERVAL_MS, 5_000);
const requestTimeoutMs = Math.min(
  normalizePositiveInteger(process.env.OMNIAGENT_WORKER_REQUEST_TIMEOUT_MS, 300_000),
  300_000,
);
const limit = Math.min(normalizePositiveInteger(process.env.OMNIAGENT_WORKER_LIMIT, 1), 10);
const enableSlo = process.env.OMNIAGENT_WORKER_SLO !== "false";
const enableAlerts = process.env.OMNIAGENT_WORKER_ALERTS !== "false";
const enableRetention = process.env.OMNIAGENT_WORKER_RETENTION !== "false";
const retentionIntervalMs = Math.max(
  normalizePositiveInteger(process.env.OMNIAGENT_WORKER_RETENTION_INTERVAL_MS, 6 * 60 * 60 * 1_000),
  60 * 60 * 1_000,
);

if (!baseUrl) {
  fail("OMNIAGENT_WORKER_BASE_URL, NEXT_PUBLIC_APP_URL, or BASE_URL is required.");
}

if (!internalSecret) {
  fail("OMNIAGENT_INTERNAL_AUTH_SECRET is required so the worker can authenticate as system.");
}
if (process.env.NODE_ENV === "production" && !releaseRevision) {
  fail("OMNIAGENT_RELEASE_SHA is required for production worker revision fencing.");
}

let shuttingDown = false;
let activeController;
const shutdownController = new AbortController();
function beginShutdown() {
  shuttingDown = true;
  activeController?.abort(new Error("Worker is shutting down."));
  shutdownController.abort();
}
process.on("SIGINT", beginShutdown);
process.on("SIGTERM", beginShutdown);

console.log(JSON.stringify({
  level: "info",
  message: "OmniAgentOS worker started.",
  baseUrl,
  intervalMs,
  limit,
  slo: enableSlo,
  alerts: enableAlerts,
  retention: enableRetention,
  retentionIntervalMs,
  releaseRevision,
  instanceId,
}));

let nextRetentionAt = 0;
let tenantCursor;
while (!shuttingDown) {
  const startedAt = Date.now();
  try {
    const controller = new AbortController();
    activeController = controller;
    const timeout = setTimeout(
      () => controller.abort(new Error(`Worker tick timed out after ${requestTimeoutMs}ms.`)),
      requestTimeoutMs,
    );
    let response;
    let body;
    try {
      response = await fetch(`${baseUrl}/api/workflows/tick`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-omni-internal-auth": internalSecret,
          "x-omni-tenant-id": tenantId,
          "x-omni-user-id": "dedicated-worker",
          "x-omni-user-role": "system",
          "x-omni-worker-instance": instanceId,
          ...(releaseRevision
            ? { "x-omni-worker-revision": releaseRevision }
            : {}),
        },
        body: JSON.stringify({
          limit,
          slo: enableSlo,
          alerts: enableAlerts,
          scope: "all_tenants",
          tenantCursor,
          maintenanceTenantLimit: limit,
        }),
        redirect: "error",
        signal: controller.signal,
      });
      body = await readJsonResponseLimited(response, 1_000_000);
      if (response.ok) {
        tenantCursor =
          typeof body?.nextTenantCursor === "string"
            ? body.nextTenantCursor
            : undefined;
        await writeFile(heartbeatFile, `${Date.now()}\n`, { mode: 0o600 });
      }
    } finally {
      clearTimeout(timeout);
      if (activeController === controller) {
        activeController = undefined;
      }
    }
    console.log(JSON.stringify({
      level: response.ok ? "info" : "error",
      message: response.ok ? "Worker tick completed." : "Worker tick failed.",
      status: response.status,
      durationMs: Date.now() - startedAt,
      leased: body?.queue?.leased,
      completed: body?.queue?.completed,
      failed: body?.queue?.failed,
      requeued: body?.queue?.requeued,
      maintenanceTenants: body?.maintenanceTenantIds?.length,
      nextTenantCursor: body?.nextTenantCursor,
      workerHeartbeatAt: body?.workerHeartbeat?.recordedAt,
      releaseRevision,
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

  if (!shuttingDown && enableRetention && Date.now() >= nextRetentionAt) {
    const retention = await runRetentionSweep();
    nextRetentionAt =
      Date.now() +
      (!retention.succeeded
        ? Math.min(retentionIntervalMs, 5 * 60 * 1_000)
        : retention.moreAvailable
          ? 60 * 1_000
          : retentionIntervalMs);
  }

  await sleep(intervalMs, shutdownController.signal);
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
  const controller = new AbortController();
  activeController = controller;
  const timeout = setTimeout(
    () => controller.abort(new Error(`Retention sweep timed out after ${requestTimeoutMs}ms.`)),
    requestTimeoutMs,
  );
  try {
    const response = await fetch(`${baseUrl}/api/security/retention`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-omni-internal-auth": internalSecret,
        "x-omni-tenant-id": tenantId,
        "x-omni-user-id": "dedicated-worker",
        "x-omni-user-role": "system",
        "x-omni-worker-instance": instanceId,
        ...(releaseRevision
          ? { "x-omni-worker-revision": releaseRevision }
          : {}),
      },
      body: JSON.stringify({ scope: "all_tenants" }),
      redirect: "error",
      signal: controller.signal,
    });
    const body = await readJsonResponseLimited(response, 100_000);
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
  } finally {
    clearTimeout(timeout);
    if (activeController === controller) {
      activeController = undefined;
    }
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
