import "server-only";

import { createHash } from "node:crypto";

import {
  marketEventBackfillRequestSchema,
  type MarketEventBackfillRequest,
} from "@/lib/market-research/contracts";
import {
  selectedHighImpactEvents,
} from "@/lib/market-research/event-catalog";
import { saveFredMarketEvents } from "@/lib/market-research/event-store";
import { fetchFredReleaseDates } from "@/lib/market-research/fred";
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

export async function enqueueMarketEventBackfillJob(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
  request: MarketEventBackfillRequest;
}) {
  const request = marketEventBackfillRequestSchema.parse(input.request);
  if (
    input.executionScope.tenantId !== input.tenantId ||
    input.executionScope.initiatingActorId !== input.actorId
  ) {
    throw new Error("Market event backfill queue scope is invalid.");
  }
  const workerScope = deriveExecutionScope(input.executionScope, {
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    causationId: input.idempotencyKey,
    purpose: "market.events.backfill.worker",
  });
  const requestHash = canonicalJsonSha256({
    tenantId: input.tenantId,
    actorId: input.actorId,
    request,
  });
  const dedupeKey = `market.events.backfill:${digest(
    `${input.tenantId}:${input.actorId}:${input.idempotencyKey}`,
  )}`;
  const job = await enqueueOperationJob({
    tenantId: input.tenantId,
    type: "market.events.backfill",
    dedupeKey,
    dedupeMode: "idempotent",
    payload: {
      actorId: input.actorId,
      executionScope: workerScope,
      request,
      requestHash,
      progress: {
        stage: "queued",
        completedSources: 0,
        totalSources: selectedHighImpactEvents(request.eventKeys).length,
        importedEvents: 0,
      },
    },
    priority: 1,
    maxAttempts: 3,
  });
  if (
    job.payload.actorId !== input.actorId ||
    job.payload.requestHash !== requestHash
  ) {
    throw new Error(
      "The idempotency key is already bound to a different market event backfill.",
    );
  }
  return job;
}

export async function executeMarketEventBackfillJob(input: {
  job: OperationJobRecord;
  abortSignal: AbortSignal;
  onProgress: (progress: Record<string, unknown>) => Promise<void>;
}) {
  const request = marketEventBackfillRequestSchema.parse(
    input.job.payload.request,
  );
  const actorId = typeof input.job.payload.actorId === "string"
    ? input.job.payload.actorId.trim()
    : "";
  const executionScope = parsePersistedExecutionScope(
    input.job.payload.executionScope,
  );
  if (
    !actorId ||
    !executionScope ||
    executionScope.tenantId !== input.job.tenantId ||
    executionScope.initiatingActorId !== actorId ||
    executionScope.executingPrincipalType !== "system" ||
    executionScope.executingPrincipalId !== "background-operations-worker" ||
    executionScope.purpose !== "market.events.backfill.worker"
  ) {
    throw new Error("Market event backfill worker scope is invalid.");
  }

  const definitions = selectedHighImpactEvents(request.eventKeys);
  let importedEvents = 0;
  let discoveredDates = 0;
  for (const [index, definition] of definitions.entries()) {
    input.abortSignal.throwIfAborted();
    await input.onProgress({
      stage: "fetching_release_history",
      currentEventKey: definition.eventKey,
      completedSources: index,
      totalSources: definitions.length,
      importedEvents,
      discoveredDates,
    });
    const dates = await fetchFredReleaseDates({
      event: definition,
      startDate: request.startDate,
      endDate: request.endDate,
      signal: input.abortSignal,
    });
    discoveredDates += dates.length;
    const saved = await saveFredMarketEvents({
      tenantId: input.job.tenantId,
      actorId,
      executionScope,
      dates,
      importId: input.job.id,
    });
    importedEvents += saved.inserted;
    await input.onProgress({
      stage: "saving_release_history",
      currentEventKey: definition.eventKey,
      completedSources: index + 1,
      totalSources: definitions.length,
      importedEvents,
      discoveredDates,
    });
  }
  return {
    resourceId: "market_event_history",
    importedEvents,
    discoveredDates,
    sourcesProcessed: definitions.length,
    startDate: request.startDate,
    endDate: request.endDate,
    timestampPrecision: "date",
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}
