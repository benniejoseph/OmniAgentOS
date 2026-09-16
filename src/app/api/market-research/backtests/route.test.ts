import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listMarketBacktestsService: vi.fn(),
  runMarketBacktestService: vi.fn(),
  createAppServiceCaller: vi.fn((input) => input),
  createRequestMutationAppServiceCaller: vi.fn((_request, context, options) => ({
    context,
    options,
  })),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/app-services/contracts", () => ({
  createAppServiceCaller: mocks.createAppServiceCaller,
  createRequestMutationAppServiceCaller: mocks.createRequestMutationAppServiceCaller,
}));
vi.mock("@/lib/app-services/market-research", () => ({
  listMarketBacktestsService: mocks.listMarketBacktestsService,
  runMarketBacktestService: mocks.runMarketBacktestService,
}));

import { GET, POST } from "@/app/api/market-research/backtests/route";

const context = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "admin" as const,
  source: "session" as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(context);
});

describe("market backtests route", () => {
  it("lists only an authenticated instrument's private immutable results", async () => {
    mocks.listMarketBacktestsService.mockResolvedValue({
      data: {
        contractVersion: "market-research-foundation:6",
        instrumentId: "xauusd.spot",
        backtests: [],
        total: 0,
      },
      receipt: { operation: "app.market_research.backtests.list" },
    });

    const response = await GET(new Request(
      "http://localhost/api/market-research/backtests?instrumentId=xauusd.spot&limit=12",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listMarketBacktestsService).toHaveBeenCalledWith(
      expect.anything(),
      { instrumentId: "xauusd.spot", limit: 12 },
    );
  });

  it("queues a governed asynchronous run and returns its progress location", async () => {
    mocks.runMarketBacktestService.mockResolvedValue({
      data: { job: { id: "job-a", status: "queued" } },
      receipt: { operation: "app.market_research.backtests.run" },
    });
    const snapshotId = `market_snapshot_${"a".repeat(48)}`;
    const response = await POST(new Request(
      "http://localhost/api/market-research/backtests",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "backtest-a",
        },
        body: JSON.stringify({ snapshotId }),
      },
    ));

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe("/api/operations/jobs/job-a");
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "manage.workflow",
      resourceType: "market_backtest",
      nativeMutationCapability: "markets.update",
      metadata: {
        operation: "run",
        snapshotId,
        strategyId: "foundation.liquidity_sweep_reversal.v1",
      },
    }));
    expect(mocks.runMarketBacktestService).toHaveBeenCalledWith(
      expect.objectContaining({
        context,
        options: { purpose: "market.backtest.run.queue" },
      }),
      expect.objectContaining({
        snapshotId,
        strategy: expect.objectContaining({
          strategyId: "foundation.liquidity_sweep_reversal.v1",
        }),
      }),
    );
  });

  it("rejects an unbound or malformed snapshot before authorization", async () => {
    const response = await POST(new Request(
      "http://localhost/api/market-research/backtests",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ snapshotId: "not-a-snapshot" }),
      },
    ));

    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.runMarketBacktestService).not.toHaveBeenCalled();
  });
});
