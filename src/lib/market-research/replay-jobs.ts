import "server-only";

import { createHash } from "node:crypto";

import {
  marketEventReplayRequestSchema,
  type MarketEventReplayRequest,
} from "@/lib/market-research/contracts";
import {
  listPendingMarketReplayEvents,
  MarketReplayInsufficientDataError,
  saveMarketEventReplay,
} from "@/lib/market-research/event-replay-store";
import { fetchTwelveDataBarRangeSnapshot } from "@/lib/market-research/twelve-data";
import {
  enqueueOperationJob,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const providerThrottleMs = process.env.NODE_ENV === "test" ? 0 : 8_000;

export async function enqueueMarketEventReplayBackfillJob(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
  request: MarketEventReplayRequest;
}) {
  const request = marketEventReplayRequestSchema.parse(input.request);
  if (
    input.executionScope.tenantId !== input.tenantId ||
    input.executionScope.initiatingActorId !== input.actorId
  ) {
    throw new Error("Market replay backfill queue scope is invalid.");
  }
  const workerScope = deriveExecutionScope(input.executionScope, {
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    causationId: input.idempotencyKey,
    purpose: "market.replays.backfill.worker",
  });
  const requestHash = canonicalJsonSha256({
    tenantId: input.tenantId,
    actorId: input.actorId,
    request,
  });
  const job = await enqueueOperationJob({
    tenantId: input.tenantId,
    type: "market.replays.backfill",
    dedupeKey: `market.replays.backfill:${digest(
      `${input.tenantId}:${input.actorId}:${input.idempotencyKey}`,
    )}`,
    dedupeMode: "idempotent",
    payload: {
      actorId: input.actorId,
      executionScope: workerScope,
      request,
      requestHash,
      progress: {
        stage: "queued",
        completedEvents: 0,
        totalEvents: request.maxEvents,
        importedReplays: 0,
        skippedEvents: 0,
      },
    },
    priority: 1,
    maxAttempts: 3,
  });
  if (job.payload.actorId !== input.actorId || job.payload.requestHash !== requestHash) {
    throw new Error("The idempotency key is bound to another market replay backfill.");
  }
  return job;
}

export async function executeMarketEventReplayBackfillJob(input: {
  job: OperationJobRecord;
  abortSignal: AbortSignal;
  onProgress: (progress: Record<string, unknown>) => Promise<void>;
}) {
  const request = marketEventReplayRequestSchema.parse(input.job.payload.request);
  const actorId = typeof input.job.payload.actorId === "string"
    ? input.job.payload.actorId.trim()
    : "";
  const executionScope = parsePersistedExecutionScope(input.job.payload.executionScope);
  if (
    !actorId ||
    !executionScope ||
    executionScope.tenantId !== input.job.tenantId ||
    executionScope.initiatingActorId !== actorId ||
    executionScope.executingPrincipalType !== "system" ||
    executionScope.executingPrincipalId !== "background-operations-worker" ||
    executionScope.purpose !== "market.replays.backfill.worker"
  ) {
    throw new Error("Market replay backfill worker scope is invalid.");
  }
  const events = await listPendingMarketReplayEvents({
    tenantId: input.job.tenantId,
    actorId,
    instrumentId: request.instrumentId,
    interval: request.interval,
    startDate: request.startDate,
    endDate: request.endDate,
    limit: request.maxEvents,
  });
  let importedReplays = 0;
  let skippedEvents = 0;
  for (const [index, event] of events.entries()) {
    input.abortSignal.throwIfAborted();
    await input.onProgress({
      stage: "fetching_price_window",
      completedEvents: index,
      totalEvents: events.length,
      importedReplays,
      skippedEvents,
      currentEventKey: event.eventKey,
      currentOccurredAt: event.occurredAt,
    });
    const occurredAt = Date.parse(event.occurredAt);
    const windowStart = new Date(occurredAt - 90 * 60_000).toISOString();
    const windowEnd = new Date(occurredAt + 270 * 60_000).toISOString();
    try {
      const snapshot = await fetchTwelveDataBarRangeSnapshot({
        instrumentId: request.instrumentId,
        interval: request.interval,
        startAt: windowStart,
        endAt: windowEnd,
      });
      const saved = await saveMarketEventReplay({
        tenantId: input.job.tenantId,
        actorId,
        executionScope,
        event,
        windowStart,
        windowEnd,
        result: snapshot.result,
        sourcePayload: snapshot.sourcePayload,
        importId: input.job.id,
      });
      if (saved.inserted) importedReplays += 1;
    } catch (error) {
      if (!(error instanceof MarketReplayInsufficientDataError)) throw error;
      skippedEvents += 1;
    }
    await input.onProgress({
      stage: "saving_price_window",
      completedEvents: index + 1,
      totalEvents: events.length,
      importedReplays,
      skippedEvents,
      currentEventKey: event.eventKey,
      currentOccurredAt: event.occurredAt,
    });
    if (providerThrottleMs && index < events.length - 1) {
      await abortableDelay(providerThrottleMs, input.abortSignal);
    }
  }
  return {
    resourceId: "market_event_replays",
    instrumentId: request.instrumentId,
    interval: request.interval,
    consideredEvents: events.length,
    importedReplays,
    skippedEvents,
    startDate: request.startDate,
    endDate: request.endDate,
  };
}

function abortableDelay(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}
