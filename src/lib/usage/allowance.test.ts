import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(() => false),
  listFileAiUsageRecords: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: mocks.getSql,
  hasDatabaseUrl: mocks.hasDatabaseUrl,
}));
vi.mock("@/lib/usage/ledger", () => ({
  listFileAiUsageRecords: mocks.listFileAiUsageRecords,
}));

import { loadTenantAiUsageSince } from "@/lib/usage/allowance";

const since = new Date("2026-09-28T12:00:00.000Z");

beforeEach(() => {
  mocks.ensureDatabaseSchema.mockReset().mockResolvedValue(undefined);
  mocks.getSql.mockReset();
  mocks.hasDatabaseUrl.mockReset().mockReturnValue(false);
  mocks.listFileAiUsageRecords.mockReset().mockResolvedValue([]);
});

describe("a tenant's AI usage over a window", () => {
  it("sums the file ledger's records from the window's start", async () => {
    mocks.listFileAiUsageRecords.mockResolvedValue([
      usageRecord({
        recordedAt: since.toISOString(),
        usage: { totalTokens: 100 },
        estimatedCostMicrousd: 2_000,
      }),
      usageRecord({
        recordedAt: "2026-09-28T18:00:00.000Z",
        usage: { inputTokens: 300, outputTokens: 50, totalTokens: 200 },
        estimatedCostMicrousd: 1_500.2,
      }),
      usageRecord({
        recordedAt: "2026-09-28T19:00:00.000Z",
        usage: { inputTokens: Number.NaN, totalTokens: -5 },
        estimatedCostMicrousd: -3,
      }),
      usageRecord({
        recordedAt: "2026-09-28T11:59:59.999Z",
        usage: { totalTokens: 10_000 },
        estimatedCostMicrousd: 99,
      }),
      usageRecord({
        recordedAt: "not a date",
        usage: { totalTokens: 7 },
        estimatedCostMicrousd: 7,
      }),
    ]);

    await expect(loadTenantAiUsageSince({ tenantId: "tenant-a", since }))
      .resolves.toEqual({ tokens: 450, costMicrousd: 3_501 });
    expect(mocks.listFileAiUsageRecords).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 10_000,
    });
    expect(mocks.getSql).not.toHaveBeenCalled();
  });

  it("caps the file ledger's sums at the largest budget counter", async () => {
    mocks.listFileAiUsageRecords.mockResolvedValue([
      usageRecord({ usage: { totalTokens: 600_000_000_000 }, estimatedCostMicrousd: 7e11 }),
      usageRecord({ usage: { totalTokens: 600_000_000_000 }, estimatedCostMicrousd: 7e11 }),
    ]);

    await expect(loadTenantAiUsageSince({ tenantId: "tenant-a", since }))
      .resolves.toEqual({ tokens: 1e12, costMicrousd: 1e12 });
  });

  it("reads the database ledger's sums for the tenant from the window's start", async () => {
    const query = databaseQuery([{ tokens: "1234", cost_microusd: "56.4" }]);
    mocks.hasDatabaseUrl.mockReturnValue(true);
    mocks.getSql.mockReturnValue(query.sql);

    await expect(loadTenantAiUsageSince({ tenantId: "tenant-a", since }))
      .resolves.toEqual({ tokens: 1_234, costMicrousd: 57 });
    expect(mocks.ensureDatabaseSchema).toHaveBeenCalledOnce();
    expect(query.calls).toHaveLength(1);
    expect(query.calls[0]?.values).toEqual(["tenant-a", since.toISOString(), null, null]);
    expect(query.calls[0]?.text).toContain("FROM omni_ai_usage ledger");
    expect(query.calls[0]?.text).toContain("WHERE ledger.tenant_id = $1");
    expect(query.calls[0]?.text).toContain("AND ledger.recorded_at >= $2::timestamptz");
    expect(query.calls[0]?.text).toContain(
      "AND ($3::text IS NULL OR ledger.source_stream_id = $4)",
    );
    expect(mocks.listFileAiUsageRecords).not.toHaveBeenCalled();
  });

  it("reads only one source stream's usage when asked", async () => {
    mocks.listFileAiUsageRecords.mockResolvedValue([
      usageRecord({ sourceStreamId: "a2a-peer:one", usage: { totalTokens: 40 }, estimatedCostMicrousd: 4 }),
      usageRecord({ sourceStreamId: "a2a-peer:two", usage: { totalTokens: 500 }, estimatedCostMicrousd: 50 }),
      usageRecord({ sourceStreamId: "a2a-peer:one", usage: { totalTokens: 60 }, estimatedCostMicrousd: 6 }),
    ]);
    await expect(loadTenantAiUsageSince({
      tenantId: "tenant-a",
      since,
      sourceStreamId: "a2a-peer:one",
    })).resolves.toEqual({ tokens: 100, costMicrousd: 10 });
    await expect(loadTenantAiUsageSince({ tenantId: "tenant-a", since }))
      .resolves.toEqual({ tokens: 600, costMicrousd: 60 });

    const query = databaseQuery([{ tokens: "7", cost_microusd: "8" }]);
    mocks.hasDatabaseUrl.mockReturnValue(true);
    mocks.getSql.mockReturnValue(query.sql);
    await expect(loadTenantAiUsageSince({
      tenantId: "tenant-a",
      since,
      sourceStreamId: "a2a-peer:one",
    })).resolves.toEqual({ tokens: 7, costMicrousd: 8 });
    expect(query.calls[0]?.values).toEqual([
      "tenant-a",
      since.toISOString(),
      "a2a-peer:one",
      "a2a-peer:one",
    ]);
  });

  it.each([
    { name: "no row", rows: [], expected: { tokens: 0, costMicrousd: 0 } },
    {
      name: "null and negative sums",
      rows: [{ tokens: null, cost_microusd: "-1" }],
      expected: { tokens: 0, costMicrousd: 0 },
    },
    {
      name: "sums past the largest budget counter",
      rows: [{ tokens: "5000000000000", cost_microusd: "1e13" }],
      expected: { tokens: 1e12, costMicrousd: 1e12 },
    },
  ])("reads $name from the database ledger as bounded counters", async ({ rows, expected }) => {
    mocks.hasDatabaseUrl.mockReturnValue(true);
    mocks.getSql.mockReturnValue(databaseQuery(rows).sql);

    await expect(loadTenantAiUsageSince({ tenantId: "tenant-a", since }))
      .resolves.toEqual(expected);
  });
});

function databaseQuery(rows: unknown[]) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({
      text: strings.reduce(
        (text, part, index) => `${text}${index === 0 ? "" : `$${index}`}${part}`,
        "",
      ),
      values,
    });
    return Promise.resolve(rows);
  };
  return { sql, calls };
}

function usageRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "usage-1",
    tenantId: "tenant-a",
    actorId: "actor-a",
    sourceStreamId: "run-1",
    operation: "agent_turn",
    purpose: "agent",
    status: "completed",
    provider: "openai",
    model: "gpt-5.2",
    usage: {},
    providerCallCount: 1,
    attemptCount: 1,
    failedAttemptCount: 0,
    callReceipts: [],
    latencyMs: 10,
    recordedAt: "2026-09-28T13:00:00.000Z",
    ...overrides,
  };
}
