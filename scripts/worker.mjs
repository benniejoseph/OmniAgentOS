#!/usr/bin/env node

import { readFile, rename, writeFile } from "node:fs/promises";
import { startOpenAIEgressGateway } from "./openai-egress-gateway.mjs";

const heartbeatFile = "/tmp/omniagent-worker-heartbeat";
const workerPidFile = "/tmp/asael-worker.pid";
const releaseActivationFile = "/tmp/asael-worker-release-activated";
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
const idleMaxIntervalMs = Math.max(
  intervalMs,
  normalizePositiveInteger(
    process.env.OMNIAGENT_WORKER_IDLE_MAX_INTERVAL_MS,
    30_000,
  ),
);
const backgroundIdleMaxIntervalMs = Math.max(
  backgroundIntervalMs,
  normalizePositiveInteger(
    process.env.OMNIAGENT_WORKER_BACKGROUND_IDLE_MAX_INTERVAL_MS,
    5 * 60 * 1_000,
  ),
);
const remoteHeartbeatIntervalMs = Math.max(
  normalizePositiveInteger(
    process.env.OMNIAGENT_WORKER_REMOTE_HEARTBEAT_INTERVAL_MS,
    5 * 60 * 1_000,
  ),
  30_000,
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
const releaseHoldValue =
  process.env.OMNIAGENT_WORKER_RELEASE_HOLD?.trim() || "false";
const releaseHoldRequested = releaseHoldValue === "true";
const canonicalRetryIntervalMs = 30_000;
const canonicalPromotionRetryIntervalMs = 2_000;
const canonicalPromotionRetryWindowMs = 70_000;
const laneHeartbeats = new Map();
const remoteHeartbeatTimes = new Map();
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
if (!["true", "false"].includes(releaseHoldValue)) {
  fail("OMNIAGENT_WORKER_RELEASE_HOLD must be true or false.");
}
if (releaseHoldRequested && (!canonicalBaseUrl || !releaseRevision)) {
  fail(
    "OMNIAGENT_WORKER_RELEASE_HOLD=true requires a canonical worker target and release revision.",
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
let releaseHeld =
  releaseHoldRequested && !(await hasExactReleaseActivationMarker());
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
let releaseHoldController = new AbortController();
let releaseWorkGeneration = 0;
let lastAutomaticCanonicalRetryAt = 0;
let canonicalActivation;
let canonicalPromotionActivation;
let releaseActivation;
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
  void activateCanonicalWorkerTargetWithRetry("promotion signal").catch((error) => {
    if (shuttingDown) return;
    console.error(JSON.stringify({
      level: "error",
      message: "Canonical worker target activation failed.",
      error: error instanceof Error ? error.message : "Unknown target activation error.",
      releaseRevision,
    }));
  });
});
process.on("SIGUSR1", () => {
  void activateReleaseWork("release activation signal").catch((error) => {
    console.error(JSON.stringify({
      level: "error",
      message: "Release work activation failed.",
      error: error instanceof Error ? error.message : "Unknown release activation error.",
      releaseRevision,
    }));
  });
});

if (
  canonicalBaseUrl &&
  canonicalBaseUrl !== workerDestination.baseUrl &&
  (!releaseHoldRequested || !releaseHeld)
) {
  // A process or machine restart after promotion must not fall back to the
  // immutable staged URL. Revision-matched canonical health is the authority.
  lastAutomaticCanonicalRetryAt = Date.now();
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
  idleMaxIntervalMs,
  backgroundIdleMaxIntervalMs,
  remoteHeartbeatIntervalMs,
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
  releaseHoldRequested,
  releaseHeld,
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

async function activateCanonicalWorkerTarget(
  reason,
  deadline = Number.POSITIVE_INFINITY,
) {
  if (!canonicalBaseUrl) {
    throw new Error("No canonical worker target is configured.");
  }
  if (workerDestination.baseUrl === canonicalBaseUrl) {
    return workerDestination;
  }
  if (canonicalActivation) return canonicalActivation;
  canonicalActivation = (async () => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Canonical target activation retry window elapsed.");
    }
    const attemptTimeoutMs = Number.isFinite(remainingMs)
      ? Math.max(1, Math.min(targetSwitchTimeoutMs, remainingMs))
      : targetSwitchTimeoutMs;
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
          AbortSignal.timeout(attemptTimeoutMs),
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

async function activateCanonicalWorkerTargetWithRetry(reason) {
  if (!canonicalBaseUrl) {
    return activateCanonicalWorkerTarget(reason);
  }
  if (workerDestination.baseUrl === canonicalBaseUrl) {
    return workerDestination;
  }
  if (canonicalPromotionActivation) return canonicalPromotionActivation;
  canonicalPromotionActivation = (async () => {
    const deadline = Date.now() + canonicalPromotionRetryWindowMs;
    let attempts = 0;
    let lastError;
    while (!shuttingDown && Date.now() < deadline) {
      attempts += 1;
      try {
        return await activateCanonicalWorkerTarget(reason, deadline);
      } catch (error) {
        lastError = error;
      }
      if (shuttingDown || workerDestination.baseUrl === canonicalBaseUrl) {
        break;
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      console.log(JSON.stringify({
        level: "info",
        message: "Canonical worker target is not ready; retrying promotion signal.",
        attempt: attempts,
        retryInMs: Math.min(canonicalPromotionRetryIntervalMs, remainingMs),
        releaseRevision,
      }));
      await sleep(
        Math.min(canonicalPromotionRetryIntervalMs, remainingMs),
        shutdownController.signal,
      );
    }
    if (shuttingDown) {
      throw new Error("Worker shut down during canonical target activation.");
    }
    throw new Error(
      `Canonical target activation did not succeed after ${attempts} attempt(s): ${
        lastError instanceof Error ? lastError.message : "unknown error"
      }`,
    );
  })();
  try {
    return await canonicalPromotionActivation;
  } finally {
    canonicalPromotionActivation = undefined;
  }
}

async function activateReleaseWork(reason) {
  if (!releaseHoldRequested) {
    throw new Error("This worker was not started with a release hold.");
  }
  if (
    !canonicalBaseUrl ||
    workerDestination.baseUrl !== canonicalBaseUrl
  ) {
    throw new Error("Release work can only activate on the canonical target.");
  }
  if (releaseActivation) return releaseActivation;
  releaseActivation = (async () => {
    if (releaseHeld) {
      const temporaryMarker = `${releaseActivationFile}.${process.pid}.tmp`;
      await writeFile(temporaryMarker, `${releaseRevision}\n`, { mode: 0o600 });
      await rename(temporaryMarker, releaseActivationFile);
      releaseHeld = false;
      releaseWorkGeneration += 1;
      const sleepingOnReleaseHold = releaseHoldController;
      releaseHoldController = new AbortController();
      sleepingOnReleaseHold.abort(new Error("Release work activated."));
    }
    console.log(JSON.stringify({
      level: "info",
      message: "Canonical release work activated.",
      reason,
      target: workerDestination.target,
      releaseRevision,
    }));
  })();
  try {
    return await releaseActivation;
  } finally {
    releaseActivation = undefined;
  }
}

async function retryActivatedCanonicalTarget() {
  if (
    !releaseHoldRequested ||
    releaseHeld ||
    !canonicalBaseUrl ||
    workerDestination.baseUrl === canonicalBaseUrl
  ) {
    return;
  }
  const now = Date.now();
  if (
    now - lastAutomaticCanonicalRetryAt < canonicalRetryIntervalMs
  ) {
    return;
  }
  lastAutomaticCanonicalRetryAt = now;
  await activateCanonicalWorkerTarget("activated restart recovery retry").catch(
    (error) => {
      console.log(JSON.stringify({
        level: "info",
        message: "Canonical worker target retry is not ready; retaining staged target.",
        error: error instanceof Error ? error.message : "Canonical target unavailable.",
        releaseRevision,
      }));
    },
  );
}

async function hasExactReleaseActivationMarker() {
  try {
    return (await readFile(releaseActivationFile, "utf8")).trim() === releaseRevision;
  } catch {
    return false;
  }
}

function releaseWorkIsEnabled() {
  if (!releaseHoldRequested) return true;
  return !releaseHeld && workerDestination.baseUrl === canonicalBaseUrl;
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
  let idleAttempts = 0;
  let tenantCursor;
  let targetGeneration = workerDestination.generation;
  while (!shuttingDown) {
    if (lane === "fast") {
      await retryActivatedCanonicalTarget();
    }
    if (targetGeneration !== workerDestination.generation) {
      targetGeneration = workerDestination.generation;
      startup = true;
      idleAttempts = 0;
      tenantCursor = undefined;
    }
    const releaseGeneration = releaseWorkGeneration;
    const startupAttempt = startup || !releaseWorkIsEnabled();
    let nextDelayMs = startupAttempt
      ? Math.min(cadenceMs, intervalMs)
      : cadenceMs;
    let waitForHeldWorkerEvent = false;
    let startedAt = Date.now();
    try {
      const executeTick = async () => {
        startedAt = Date.now();
        await recordLaneState(lane, "running", startedAt);
        const sendRemoteHeartbeat =
          startupAttempt || shouldSendRemoteHeartbeat(lane, startedAt);
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
          {
            "x-omni-worker-heartbeat": sendRemoteHeartbeat
              ? "active"
              : "skip",
          },
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
      if (releaseGeneration !== releaseWorkGeneration) {
        // A held registration that completes across SIGUSR1 must not make the
        // next canonical tick another registration. The release gate requires
        // a post-activation active heartbeat, and startup heartbeats also
        // advance the remote-heartbeat throttle.
        startup = !releaseWorkIsEnabled();
        tenantCursor = undefined;
        continue;
      }
      if (response.ok) {
        if (releaseWorkIsEnabled()) {
          startup = false;
        }
        if (body?.workerHeartbeat?.recordedAt) {
          remoteHeartbeatTimes.set(lane, Date.now());
        }
        if (startupAttempt) {
          if (releaseWorkIsEnabled()) {
            nextDelayMs = firstWorkDelayMs;
          } else if (releaseHeld) {
            // A successful release-hold registration is valid until the
            // target changes or work is explicitly activated. Repeating it
            // creates avoidable serverless/database pressure during the most
            // demanding release checks.
            waitForHeldWorkerEvent = true;
            nextDelayMs = null;
          } else {
            // An activated process that restarted on its immutable staged
            // URL must keep retrying the exact-revision canonical target.
            nextDelayMs = canonicalRetryIntervalMs;
          }
        }
        if (lane === "maintenance") {
          tenantCursor =
            typeof body?.nextTenantCursor === "string"
              ? body.nextTenantCursor
              : undefined;
        }
        if (!startupAttempt) {
          if (workerTickHasActivity(body)) {
            idleAttempts = 0;
          } else {
            idleAttempts += 1;
            nextDelayMs = idleDelayForLane(
              lane,
              cadenceMs,
              idleAttempts,
            );
          }
        }
        await recordLaneState(lane, "succeeded", startedAt);
      } else {
        idleAttempts = 0;
        if (!releaseWorkIsEnabled()) {
          nextDelayMs = canonicalRetryIntervalMs;
        }
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
      idleAttempts = 0;
      waitForHeldWorkerEvent = false;
      if (!releaseWorkIsEnabled()) {
        nextDelayMs = canonicalRetryIntervalMs;
      }
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
      if (releaseGeneration !== releaseWorkGeneration) {
        startup = !releaseWorkIsEnabled();
        tenantCursor = undefined;
        continue;
      }
      if (waitForHeldWorkerEvent) {
        await waitForWorkerEvent(targetGeneration, releaseGeneration);
      } else {
        await sleepForWorkerEvent(
          nextDelayMs,
          targetGeneration,
          releaseGeneration,
        );
      }
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
  let nextRunAt = Date.now() + startupDelayMs;
  let targetGeneration = workerDestination.generation;
  while (!shuttingDown) {
    await sleepForWorkerEvent(
      Math.max(0, nextRunAt - Date.now()),
      targetGeneration,
      releaseWorkGeneration,
      false,
    );
    if (shuttingDown) {
      break;
    }
    if (targetGeneration !== workerDestination.generation) {
      targetGeneration = workerDestination.generation;
      continue;
    }
    if (Date.now() < nextRunAt) {
      continue;
    }
    targetGeneration = workerDestination.generation;
    if (!releaseWorkIsEnabled()) {
      nextRunAt = Date.now() + Math.max(intervalMs, 30_000);
      continue;
    }
    const retention = await runHeavyLane(runRetentionSweep);
    if (!retention) {
      break;
    }
    const delayMs = !retention.succeeded
      ? Math.min(retentionIntervalMs, 5 * 60 * 1_000)
      : retention.moreAvailable
        ? 60 * 1_000
        : retentionIntervalMs;
    nextRunAt = Date.now() + delayMs;
  }
}

async function requestWorkerEndpoint(
  pathname,
  payload,
  maxBytes,
  additionalHeaders = {},
) {
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
      headers: {
        ...workerHeaders(destination.target),
        ...additionalHeaders,
      },
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

function shouldSendRemoteHeartbeat(lane, now = Date.now()) {
  const previous = remoteHeartbeatTimes.get(lane) || 0;
  return now - previous >= remoteHeartbeatIntervalMs;
}

function idleDelayForLane(lane, cadenceMs, idleAttempts) {
  const maximum = lane === "fast"
    ? idleMaxIntervalMs
    : lane === "background"
      ? backgroundIdleMaxIntervalMs
      : cadenceMs;
  return Math.min(
    maximum,
    cadenceMs * (2 ** Math.min(Math.max(idleAttempts, 0), 10)),
  );
}

function workerTickHasActivity(body) {
  if (typeof body?.idle === "boolean") {
    return !body.idle;
  }
  const counts = [
    body?.count,
    body?.queue?.leased,
    body?.queue?.completed,
    body?.queue?.failed,
    body?.queue?.requeued,
    body?.agentResumes?.leased,
    body?.durableSpecialists?.leased,
    body?.backgroundJobs?.leased,
    body?.activityCount,
  ];
  return counts.some((value) => Number.isFinite(Number(value)) && Number(value) > 0) ||
    Boolean(body?.nextTenantCursor) ||
    (Array.isArray(body?.maintenanceTenantIds) && body.maintenanceTenantIds.length > 0);
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

function sleepForWorkerEvent(
  ms,
  expectedTargetGeneration,
  expectedReleaseGeneration = releaseWorkGeneration,
  wakeForRelease = true,
) {
  if (
    expectedTargetGeneration !== workerDestination.generation ||
    expectedReleaseGeneration !== releaseWorkGeneration
  ) {
    return Promise.resolve();
  }
  const targetSignal = targetSwitchController.signal;
  const releaseSignal = releaseHoldController.signal;
  if (
    expectedTargetGeneration !== workerDestination.generation ||
    expectedReleaseGeneration !== releaseWorkGeneration
  ) {
    return Promise.resolve();
  }
  return sleep(
    ms,
    AbortSignal.any([
      shutdownController.signal,
      targetSignal,
      ...(wakeForRelease ? [releaseSignal] : []),
    ]),
  );
}

function waitForWorkerEvent(
  expectedTargetGeneration,
  expectedReleaseGeneration = releaseWorkGeneration,
) {
  if (
    expectedTargetGeneration !== workerDestination.generation ||
    expectedReleaseGeneration !== releaseWorkGeneration
  ) {
    return Promise.resolve();
  }
  const signal = AbortSignal.any([
    shutdownController.signal,
    targetSwitchController.signal,
    releaseHoldController.signal,
  ]);
  if (
    signal.aborted ||
    expectedTargetGeneration !== workerDestination.generation ||
    expectedReleaseGeneration !== releaseWorkGeneration
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal.addEventListener("abort", resolve, { once: true });
  });
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
