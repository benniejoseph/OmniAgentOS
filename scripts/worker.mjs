#!/usr/bin/env node

import { writeFile } from "node:fs/promises";
import { startOpenAIEgressGateway } from "./openai-egress-gateway.mjs";

const heartbeatFile = "/tmp/omniagent-worker-heartbeat";
const workerPidFile = "/tmp/asael-worker.pid";
const initialBaseUrl = normalizeBaseUrl(
  process.env.OMNIAGENT_WORKER_BASE_URL ||
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.BASE_URL,
);
const canonicalBaseUrl = normalizeBaseUrl(
  process.env.OMNIAGENT_WORKER_CANONICAL_BASE_URL,
);
let workerDestination = initialBaseUrl
  ? createWorkerDestination(initialBaseUrl, 0)
  : undefined;
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
  15_000,
);
const backgroundStartupDelayMs = normalizeNonNegativeInteger(
  process.env.OMNIAGENT_WORKER_BACKGROUND_STARTUP_DELAY_MS,
  Math.floor(backgroundIntervalMs / 2),
);
const maintenanceIntervalMs = Math.max(
  normalizePositiveInteger(
    process.env.OMNIAGENT_WORKER_MAINTENANCE_INTERVAL_MS,
    5 * 60 * 1_000,
  ),
  30_000,
);
const maintenanceStartupDelayMs = normalizeNonNegativeInteger(
  process.env.OMNIAGENT_WORKER_MAINTENANCE_STARTUP_DELAY_MS,
  60_000,
);
const maintenanceFirstRunDelayMs = normalizeNonNegativeInteger(
  process.env.OMNIAGENT_WORKER_MAINTENANCE_FIRST_RUN_DELAY_MS,
  15 * 60 * 1_000,
);
const requestTimeoutMs = Math.min(
  normalizePositiveInteger(process.env.OMNIAGENT_WORKER_REQUEST_TIMEOUT_MS, 300_000),
  300_000,
);
const targetSwitchTimeoutMs = Math.min(
  normalizePositiveInteger(
    process.env.OMNIAGENT_WORKER_TARGET_SWITCH_TIMEOUT_MS,
    10_000,
  ),
  30_000,
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
const retentionStartupDelayMs = normalizeNonNegativeInteger(
  process.env.OMNIAGENT_WORKER_RETENTION_STARTUP_DELAY_MS,
  10 * 60 * 1_000,
);
const openAIEgressGatewayToken =
  process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN?.trim();
const openAIEgressGatewayPreviousToken =
  process.env.OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN?.trim();
const laneHeartbeats = new Map();
let heartbeatWrite = Promise.resolve();
let heavyLaneQueue = Promise.resolve();

if (!initialBaseUrl) {
  fail("OMNIAGENT_WORKER_BASE_URL, NEXT_PUBLIC_APP_URL, or BASE_URL is required.");
}
if (
  process.env.OMNIAGENT_WORKER_CANONICAL_BASE_URL?.trim() &&
  !canonicalBaseUrl
) {
  fail("OMNIAGENT_WORKER_CANONICAL_BASE_URL must be a valid HTTP(S) URL.");
}
if (canonicalBaseUrl && !releaseRevision) {
  fail(
    "OMNIAGENT_RELEASE_SHA is required when a canonical worker target is configured.",
  );
}

if (!internalSecret) {
  fail("OMNIAGENT_INTERNAL_AUTH_SECRET is required so the worker can authenticate as system.");
}
if (openAIEgressGatewayPreviousToken && !openAIEgressGatewayToken) {
  fail(
    "OMNIAGENT_OPENAI_GATEWAY_PREVIOUS_TOKEN requires OMNIAGENT_OPENAI_GATEWAY_TOKEN.",
  );
}
await writeFile(workerPidFile, `${process.pid}\n`, { mode: 0o600 });
const openAIEgressGateway = openAIEgressGatewayToken
  ? await startOpenAIEgressGateway({
      token: openAIEgressGatewayToken,
      previousToken: openAIEgressGatewayPreviousToken,
    })
  : undefined;
let shuttingDown = false;
let gatewayShutdown = Promise.resolve();
const activeControllers = new Set();
const shutdownController = new AbortController();
let targetSwitchController = new AbortController();
let canonicalActivation;
function beginShutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const controller of activeControllers) {
    controller.abort(new Error("Worker is shutting down."));
  }
  shutdownController.abort();
  gatewayShutdown = openAIEgressGateway?.close() || Promise.resolve();
}
process.on("SIGINT", beginShutdown);
process.on("SIGTERM", beginShutdown);
process.on("SIGHUP", () => {
  void activateCanonicalWorkerTarget("promotion signal").catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      message: "Canonical worker target activation failed.",
      error: error instanceof Error ? error.message : "Unknown target activation error.",
      releaseRevision,
    }));
  });
});

if (
  canonicalBaseUrl &&
  canonicalBaseUrl !== workerDestination.baseUrl
) {
  // A process or machine restart after promotion must not fall back to the
  // immutable staged URL. Revision-matched canonical health is the authority.
  await activateCanonicalWorkerTarget("restart recovery").catch((error) => {
    console.log(JSON.stringify({
      level: "info",
      message: "Canonical worker target is not active yet; retaining staged target.",
      error: error instanceof Error ? error.message : "Canonical target unavailable.",
      releaseRevision,
    }));
  });
}

console.log(JSON.stringify({
  level: "info",
  message: "Asael worker started.",
  baseUrl: workerDestination.baseUrl,
  canonicalBaseUrl,
  intervalMs,
  backgroundIntervalMs,
  backgroundStartupDelayMs,
  maintenanceIntervalMs,
  maintenanceStartupDelayMs,
  maintenanceFirstRunDelayMs,
  limit,
  slo: enableSlo,
  alerts: enableAlerts,
  retention: enableRetention,
  retentionIntervalMs,
  retentionStartupDelayMs,
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
  }, 0),
  runTickLane("background", backgroundIntervalMs, {
    limit: 1,
    slo: false,
    alerts: false,
    timeBudgetMs: 240_000,
  }, backgroundStartupDelayMs),
  runTickLane("maintenance", maintenanceIntervalMs, {
    limit,
    slo: enableSlo,
    alerts: enableAlerts,
    maintenanceTenantLimit: limit,
    timeBudgetMs: 240_000,
  }, maintenanceStartupDelayMs, maintenanceFirstRunDelayMs),
  enableRetention
    ? runRetentionLoop(retentionStartupDelayMs)
    : Promise.resolve(),
]);
await gatewayShutdown;

console.log(JSON.stringify({ level: "info", message: "Asael worker stopped." }));

async function activateCanonicalWorkerTarget(reason) {
  if (!canonicalBaseUrl) {
    throw new Error("No canonical worker target is configured.");
  }
  if (workerDestination.baseUrl === canonicalBaseUrl) {
    return workerDestination;
  }
  if (canonicalActivation) return canonicalActivation;
  canonicalActivation = (async () => {
    let response;
    try {
      response = await fetch(`${canonicalBaseUrl}/api/health`, {
        cache: "no-store",
        headers: {
          accept: "application/json",
          ...(vercelBypassSecret
            ? { "x-vercel-protection-bypass": vercelBypassSecret }
            : {}),
        },
        redirect: "manual",
        signal: AbortSignal.any([
          shutdownController.signal,
          AbortSignal.timeout(targetSwitchTimeoutMs),
        ]),
      });
    } catch (error) {
      throw new Error(
        `Canonical health request failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
    const body = await readJsonResponseLimited(response, 16_384);
    if (
      response.status !== 200 ||
      body?.status !== "healthy" ||
      body?.revision !== releaseRevision
    ) {
      throw new Error(
        `Canonical health does not match release ${releaseRevision}.`,
      );
    }

    const previous = workerDestination;
    workerDestination = createWorkerDestination(
      canonicalBaseUrl,
      previous.generation + 1,
    );
    const sleepingOnPreviousTarget = targetSwitchController;
    targetSwitchController = new AbortController();
    sleepingOnPreviousTarget.abort(
      new Error("Worker target changed."),
    );
    console.log(JSON.stringify({
      level: "info",
      message: "Canonical worker target activated without process restart.",
      reason,
      target: workerDestination.target,
      generation: workerDestination.generation,
      releaseRevision,
    }));
    return workerDestination;
  })();
  try {
    return await canonicalActivation;
  } finally {
    canonicalActivation = undefined;
  }
}

function createWorkerDestination(baseUrl, generation) {
  return {
    baseUrl,
    target: new URL(baseUrl).origin,
    generation,
  };
}

async function runTickLane(
  lane,
  cadenceMs,
  laneOptions,
  startupDelayMs,
  firstWorkDelayMs = cadenceMs,
) {
  if (startupDelayMs > 0) {
    await sleepForWorkerEvent(
      startupDelayMs,
      workerDestination.generation,
    );
  }
  let startup = true;
  let tenantCursor;
  let targetGeneration = workerDestination.generation;
  while (!shuttingDown) {
    if (targetGeneration !== workerDestination.generation) {
      targetGeneration = workerDestination.generation;
      startup = true;
      tenantCursor = undefined;
    }
    const startupAttempt = startup;
    let nextDelayMs = startupAttempt
      ? Math.min(cadenceMs, intervalMs)
      : cadenceMs;
    let startedAt = Date.now();
    try {
      const executeTick = async () => {
        startedAt = Date.now();
        await recordLaneState(lane, "running", startedAt);
        return requestWorkerEndpoint(
          "/api/workflows/tick",
          {
            ...laneOptions,
            scope: "all_tenants",
            lane,
            ...(startupAttempt ? { startup: true } : {}),
            ...(lane === "maintenance" ? { tenantCursor } : {}),
          },
          1_000_000,
        );
      };
      const result = lane === "fast" || startupAttempt
        ? await executeTick()
        : await runHeavyLane(executeTick);
      if (!result) {
        break;
      }
      const { response, body, destinationGeneration } = result;
      if (destinationGeneration !== workerDestination.generation) {
        startup = true;
        tenantCursor = undefined;
        continue;
      }
      if (response.ok) {
        startup = false;
        if (startupAttempt) {
          nextDelayMs = firstWorkDelayMs;
        }
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
        startup: startupAttempt,
        status: response.status,
        durationMs: Date.now() - startedAt,
        nextDelayMs,
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
    if (!shuttingDown) {
      await sleepForWorkerEvent(nextDelayMs, targetGeneration);
    }
  }
}

async function runHeavyLane(operation) {
  const previous = heavyLaneQueue;
  let release = () => undefined;
  heavyLaneQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (shuttingDown) {
      return undefined;
    }
    return await operation();
  } finally {
    release();
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

async function runRetentionLoop(startupDelayMs) {
  let delayMs = startupDelayMs;
  let targetGeneration = workerDestination.generation;
  while (!shuttingDown) {
    await sleepForWorkerEvent(delayMs, targetGeneration);
    if (shuttingDown) {
      break;
    }
    targetGeneration = workerDestination.generation;
    const retention = await runHeavyLane(runRetentionSweep);
    if (!retention) {
      break;
    }
    delayMs = !retention.succeeded
      ? Math.min(retentionIntervalMs, 5 * 60 * 1_000)
      : retention.moreAvailable
        ? 60 * 1_000
        : retentionIntervalMs;
  }
}

async function requestWorkerEndpoint(pathname, payload, maxBytes) {
  const destination = workerDestination;
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
    const response = await fetch(`${destination.baseUrl}${pathname}`, {
      method: "POST",
      headers: workerHeaders(destination.target),
      body: JSON.stringify(payload),
      redirect: "error",
      signal: controller.signal,
    });
    return {
      response,
      body: await readJsonResponseLimited(response, maxBytes),
      destinationGeneration: destination.generation,
    };
  } finally {
    clearTimeout(timeout);
    activeControllers.delete(controller);
  }
}

function workerHeaders(workerTarget) {
  return {
    "content-type": "application/json",
    "x-omni-internal-auth": internalSecret,
    "x-omni-tenant-id": tenantId,
    "x-omni-user-id": "dedicated-worker",
    "x-omni-user-role": "system",
    "x-omni-worker-instance": instanceId,
    "x-omni-worker-protocol": workerProtocol,
    ...(workerTarget
      ? { "x-omni-worker-target": workerTarget }
      : {}),
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

function normalizeNonNegativeInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sleepForWorkerEvent(ms, expectedTargetGeneration) {
  if (expectedTargetGeneration !== workerDestination.generation) {
    return Promise.resolve();
  }
  const targetSignal = targetSwitchController.signal;
  if (expectedTargetGeneration !== workerDestination.generation) {
    return Promise.resolve();
  }
  return sleep(
    ms,
    AbortSignal.any([
      shutdownController.signal,
      targetSignal,
    ]),
  );
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
