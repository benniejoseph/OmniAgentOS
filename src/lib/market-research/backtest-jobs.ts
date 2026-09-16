import "server-only";

import { createHash } from "node:crypto";

import { buildDeterministicMarketBacktest } from "@/lib/market-research/backtest-engine";
import {
  marketBacktestRequestSchema,
  type MarketBacktestRequest,
} from "@/lib/market-research/contracts";
import { saveMarketBacktest } from "@/lib/market-research/backtest-store";
import { readMarketPriceSnapshot } from "@/lib/market-research/price-snapshot-store";
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

export async function enqueueMarketBacktestJob(input: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  idempotencyKey: string;
  request: MarketBacktestRequest;
}) {
  const request = marketBacktestRequestSchema.parse(input.request);
  if (
    input.executionScope.tenantId !== input.tenantId ||
    input.executionScope.initiatingActorId !== input.actorId
  ) {
    throw new Error("Market backtest queue scope is invalid.");
  }
  const workerScope = deriveExecutionScope(input.executionScope, {
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    causationId: input.idempotencyKey,
    purpose: "market.backtest.run.worker",
  });
  const requestHash = canonicalJsonSha256({
    tenantId: input.tenantId,
    actorId: input.actorId,
    request,
  });
  const job = await enqueueOperationJob({
    tenantId: input.tenantId,
    type: "market.backtest.run",
    dedupeKey: `market.backtest.run:${digest(
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
        completedBars: 0,
        totalBars: 0,
      },
    },
    priority: 1,
    maxAttempts: 3,
  });
  if (job.payload.actorId !== input.actorId || job.payload.requestHash !== requestHash) {
    throw new Error("The idempotency key is bound to another market backtest.");
  }
  return job;
}

export async function executeMarketBacktestJob(input: {
  job: OperationJobRecord;
  abortSignal: AbortSignal;
  onProgress: (progress: Record<string, unknown>) => Promise<void>;
}) {
  const request = marketBacktestRequestSchema.parse(input.job.payload.request);
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
    executionScope.purpose !== "market.backtest.run.worker"
  ) {
    throw new Error("Market backtest worker scope is invalid.");
  }
  input.abortSignal.throwIfAborted();
  await input.onProgress({
    stage: "reading_snapshot",
    completedBars: 0,
    totalBars: 0,
  });
  const snapshot = await readMarketPriceSnapshot({
    tenantId: input.job.tenantId,
    actorId,
    snapshotId: request.snapshotId,
  });
  input.abortSignal.throwIfAborted();
  await input.onProgress({
    stage: "running_strategy",
    completedBars: 0,
    totalBars: snapshot.bars.length,
  });
  const backtest = buildDeterministicMarketBacktest({
    tenantId: input.job.tenantId,
    actorId,
    snapshot,
    request,
  });
  input.abortSignal.throwIfAborted();
  await input.onProgress({
    stage: "saving_result",
    completedBars: snapshot.bars.length,
    totalBars: snapshot.bars.length,
    tradeCount: backtest.metrics.overall.trades,
  });
  const saved = await saveMarketBacktest({
    tenantId: input.job.tenantId,
    actorId,
    executionScope,
    operationJobId: input.job.id,
    backtest,
  });
  return {
    resourceId: saved.backtest.id,
    backtestId: saved.backtest.id,
    reused: !saved.inserted,
    instrumentId: saved.backtest.instrumentId,
    snapshotId: saved.backtest.snapshotId,
    resultSha256: saved.backtest.resultSha256,
    tradeCount: saved.backtest.metrics.overall.trades,
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 48);
}
