import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";

type StageTiming = {
  durationMs: number;
  count: number;
};

type RequestTimingState = {
  startedAt: number;
  stages: Map<string, StageTiming>;
  databaseDurationMs: number;
  databaseQueryCount: number;
  databaseWriteCount: number;
  route?: string;
  method?: string;
};

export type RequestTimingSnapshot = {
  totalMs: number;
  authMs: number;
  auditMs: number;
  processingMs: number;
  databaseMs: number;
  databaseQueryCount: number;
  databaseWriteCount: number;
};

const requestTiming = new AsyncLocalStorage<RequestTimingState>();

export function runWithRequestTiming<T>(
  operation: () => T | Promise<T>,
  request?: Request,
): Promise<T> {
  return Promise.resolve(
    requestTiming.run(
      {
        startedAt: performance.now(),
        stages: new Map(),
        databaseDurationMs: 0,
        databaseQueryCount: 0,
        databaseWriteCount: 0,
        route: request ? new URL(request.url).pathname : undefined,
        method: request?.method,
      },
      operation,
    ),
  );
}

export async function measureRequestStage<T>(
  stage: "auth" | "audit" | "processing",
  operation: () => T | Promise<T>,
): Promise<T> {
  const state = requestTiming.getStore();
  if (!state) {
    return operation();
  }
  const startedAt = performance.now();
  try {
    return await operation();
  } finally {
    const current = state.stages.get(stage) || { durationMs: 0, count: 0 };
    current.durationMs += performance.now() - startedAt;
    current.count += 1;
    state.stages.set(stage, current);
  }
}

export function recordDatabaseTiming(durationMs: number, mutation = false) {
  const state = requestTiming.getStore();
  if (!state || !Number.isFinite(durationMs) || durationMs < 0) {
    return;
  }
  state.databaseDurationMs += durationMs;
  state.databaseQueryCount += 1;
  if (mutation) {
    state.databaseWriteCount += 1;
  }
}

export function appendServerTiming(response: Response, request?: Request) {
  const snapshot = snapshotRequestTiming();
  if (!snapshot) {
    return response;
  }
  response.headers.set(
    "server-timing",
    formatServerTimingHeader(snapshot),
  );
  response.headers.set(
    "x-omni-db-queries",
    String(snapshot.databaseQueryCount),
  );
  response.headers.set(
    "x-omni-db-writes",
    String(snapshot.databaseWriteCount),
  );
  scheduleRequestTimingTelemetry(snapshot, response.status, request);
  return response;
}

export function formatServerTimingHeader(snapshot: RequestTimingSnapshot) {
  return [
    timingEntry("total", snapshot.totalMs),
    timingEntry("auth", snapshot.authMs),
    timingEntry(
      "db",
      snapshot.databaseMs,
      `${snapshot.databaseQueryCount} ${
        snapshot.databaseQueryCount === 1 ? "query" : "queries"
      }; ${snapshot.databaseWriteCount} ${
        snapshot.databaseWriteCount === 1 ? "write" : "writes"
      }`,
    ),
    timingEntry("audit", snapshot.auditMs),
    timingEntry("processing", snapshot.processingMs),
  ].join(", ");
}

function snapshotRequestTiming(): RequestTimingSnapshot | undefined {
  const state = requestTiming.getStore();
  if (!state) {
    return undefined;
  }
  const totalMs = performance.now() - state.startedAt;
  const authMs = state.stages.get("auth")?.durationMs || 0;
  const auditMs = state.stages.get("audit")?.durationMs || 0;
  const explicitlyMeasuredProcessing =
    state.stages.get("processing")?.durationMs;
  return {
    totalMs,
    authMs,
    auditMs,
    processingMs:
      explicitlyMeasuredProcessing ??
      Math.max(0, totalMs - authMs - auditMs),
    databaseMs: state.databaseDurationMs,
    databaseQueryCount: state.databaseQueryCount,
    databaseWriteCount: state.databaseWriteCount,
  };
}

function scheduleRequestTimingTelemetry(
  snapshot: RequestTimingSnapshot,
  statusCode: number,
  request?: Request,
) {
  if (!request || Math.random() >= requestTimingSampleRate()) {
    return;
  }
  try {
    after(async () => {
      const { createRequestTelemetry, recordRuntimeEventSafely } = await import(
        "@/lib/observability/store"
      );
      const telemetry = createRequestTelemetry(request, "request-performance");
      await recordRuntimeEventSafely({
        category: "api",
        action: "request.performance",
        route: new URL(request.url).pathname,
        method: request.method,
        statusCode,
        durationMs: Math.round(snapshot.totalMs),
        requestId: telemetry.requestId,
        correlationId: telemetry.correlationId,
        message: "Sampled request-stage performance.",
        metadata: {
          authMs: Math.round(snapshot.authMs),
          databaseMs: Math.round(snapshot.databaseMs),
          databaseQueryCount: snapshot.databaseQueryCount,
          databaseWriteCount: snapshot.databaseWriteCount,
          auditMs: Math.round(snapshot.auditMs),
          processingMs: Math.round(snapshot.processingMs),
          sampleRate: requestTimingSampleRate(),
          ...telemetry.syntheticMetadata,
        },
      });
    });
  } catch {
    // Unit calls and non-Next runtimes have no request lifecycle for `after`.
  }
}

function requestTimingSampleRate() {
  const configured = Number(process.env.OMNIAGENT_REQUEST_TIMING_SAMPLE_RATE);
  if (Number.isFinite(configured)) {
    return Math.min(Math.max(configured, 0), 1);
  }
  return process.env.NODE_ENV === "production" ? 0.05 : 0;
}

function timingEntry(name: string, durationMs: number, description?: string) {
  const duration = Math.max(0, durationMs).toFixed(1);
  return `${name};dur=${duration}${
    description ? `;desc="${description.replaceAll('"', "")}"` : ""
  }`;
}
