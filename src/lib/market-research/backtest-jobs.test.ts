import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueOperationJob: vi.fn(),
  readMarketPriceSnapshot: vi.fn(),
  buildDeterministicMarketBacktest: vi.fn(),
  saveMarketBacktest: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", () => ({
  enqueueOperationJob: mocks.enqueueOperationJob,
}));
vi.mock("@/lib/market-research/price-snapshot-store", () => ({
  readMarketPriceSnapshot: mocks.readMarketPriceSnapshot,
}));
vi.mock("@/lib/market-research/backtest-engine", () => ({
  buildDeterministicMarketBacktest: mocks.buildDeterministicMarketBacktest,
}));
vi.mock("@/lib/market-research/backtest-store", () => ({
  saveMarketBacktest: mocks.saveMarketBacktest,
}));

import {
  enqueueMarketBacktestJob,
  executeMarketBacktestJob,
} from "@/lib/market-research/backtest-jobs";
import { createExecutionScope } from "@/lib/security/execution-scope";

const request = {
  snapshotId: `market_snapshot_${"a".repeat(48)}`,
  strategy: {
    strategyId: "foundation.liquidity_sweep_reversal.v1" as const,
    direction: "both" as const,
    session: "all" as const,
    rewardRiskRatio: 2,
    maxHoldingBars: 24,
    stopBufferRangeMultiplier: 0.1,
  },
  costs: { spreadBps: 2, slippageBps: 1, commissionBps: 0 },
  initialEquity: 10_000,
  riskPerTradeBps: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.enqueueOperationJob.mockImplementation(async (input) => ({
    id: "job-backtest",
    tenantId: input.tenantId,
    type: input.type,
    status: "queued",
    payload: input.payload,
    priority: input.priority,
    attempt: 0,
    maxAttempts: input.maxAttempts,
    runAt: "2026-09-16T10:00:00.000Z",
    createdAt: "2026-09-16T10:00:00.000Z",
    updatedAt: "2026-09-16T10:00:00.000Z",
  }));
});

describe("market backtest jobs", () => {
  it("binds an idempotent actor-private request to a narrowed worker scope", async () => {
    const job = await enqueueMarketBacktestJob({
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope: requestScope(),
      idempotencyKey: "backtest-once",
      request,
    });

    expect(job.type).toBe("market.backtest.run");
    expect(mocks.enqueueOperationJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      type: "market.backtest.run",
      dedupeMode: "idempotent",
      payload: expect.objectContaining({
        actorId: "actor-a",
        request,
        executionScope: expect.objectContaining({
          initiatingActorId: "actor-a",
          executingPrincipalType: "system",
          executingPrincipalId: "background-operations-worker",
          purpose: "market.backtest.run.worker",
        }),
      }),
    }));
  });

  it("reads, computes, and persists in the exact queued actor scope", async () => {
    const queued = await enqueueMarketBacktestJob({
      tenantId: "tenant-a",
      actorId: "actor-a",
      executionScope: requestScope(),
      idempotencyKey: "backtest-once",
      request,
    });
    const snapshot = { bars: Array.from({ length: 120 }) };
    const backtest = {
      id: `market_backtest_${"b".repeat(48)}`,
      instrumentId: "xauusd.spot",
      snapshotId: request.snapshotId,
      snapshotSha256: "c".repeat(64),
      resultSha256: "d".repeat(64),
      metrics: { overall: { trades: 8 } },
    };
    mocks.readMarketPriceSnapshot.mockResolvedValue(snapshot);
    mocks.buildDeterministicMarketBacktest.mockReturnValue(backtest);
    mocks.saveMarketBacktest.mockResolvedValue({ inserted: true, backtest });
    const onProgress = vi.fn();

    const result = await executeMarketBacktestJob({
      job: { ...queued, leaseOwner: "worker-a" },
      abortSignal: new AbortController().signal,
      onProgress,
    });

    expect(mocks.readMarketPriceSnapshot).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "actor-a",
      snapshotId: request.snapshotId,
    });
    expect(mocks.buildDeterministicMarketBacktest).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "actor-a",
      snapshot,
      request,
    });
    expect(mocks.saveMarketBacktest).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "actor-a",
      operationJobId: "job-backtest",
      backtest,
    }));
    expect(onProgress).toHaveBeenLastCalledWith({
      stage: "saving_result",
      completedBars: 120,
      totalBars: 120,
      tradeCount: 8,
    });
    expect(result).toMatchObject({
      backtestId: backtest.id,
      reused: false,
      tradeCount: 8,
    });
  });
});

function requestScope() {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "user",
    executingPrincipalId: "actor-a",
    correlationId: "request-a",
    purpose: "market.backtest.run.queue",
  });
}
