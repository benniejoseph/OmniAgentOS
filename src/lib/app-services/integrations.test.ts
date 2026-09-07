import { describe, expect, it, vi } from "vitest";

import { showTruthfulIntegrationsService } from "@/lib/app-services/integrations";

const caller = {
  context: {
    tenantId: "tenant:test",
    actorId: "owner@example.test",
    role: "admin" as const,
    source: "session" as const,
    auth: {
      userId: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      sessionId: "session:test",
      tenantName: "Test",
    },
  },
};

describe("truthful Integrations application service", () => {
  it("installs canonical/current actor scope and returns a governed read receipt", async () => {
    const listOAuth = vi.fn().mockResolvedValue([]);
    const loadMcp = vi.fn().mockResolvedValue({ connectors: [], tools: [] });
    const loadOpenApi = vi.fn().mockResolvedValue({ connectors: [], operations: [] });
    const result = await showTruthfulIntegrationsService(caller, {}, {
      listOAuth,
      loadMcp,
      loadOpenApi,
      loadSalesforce: vi.fn().mockResolvedValue({
        health: disconnectedSalesforceHealth(),
        writesConfigured: false,
      }),
      loadUsage: vi.fn().mockResolvedValue(emptyUsage()),
      oauthConfigured: vi.fn().mockReturnValue(false),
      catalog: [],
      now: () => new Date("2026-09-07T12:00:00.000Z"),
    });

    expect(listOAuth).toHaveBeenCalledWith({
      tenantId: "tenant:test",
      actorId: "owner@example.test",
      requestActorBinding: expect.objectContaining({
        canonicalActorId: "actor:00000000-0000-4000-8000-000000000001",
        readableOwnerActorIds: [
          "actor:00000000-0000-4000-8000-000000000001",
          "owner@example.test",
        ],
      }),
    });
    expect(loadMcp).toHaveBeenCalledWith("tenant:test");
    expect(loadOpenApi).toHaveBeenCalledWith("tenant:test");
    expect(result.receipt.operation).toBe("app.integrations.overview.show");
    expect(result.data.overview.version).toBe("p11.7-truthful-integrations:1");
  });

  it("keeps one failed inventory explicit while returning the other sources", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await showTruthfulIntegrationsService(caller, {}, {
      listOAuth: vi.fn().mockResolvedValue([]),
      loadMcp: vi.fn().mockRejectedValue(Object.assign(new Error("secret detail"), { code: "POOL_TIMEOUT" })),
      loadOpenApi: vi.fn().mockResolvedValue({ connectors: [], operations: [] }),
      loadSalesforce: vi.fn().mockResolvedValue({ health: disconnectedSalesforceHealth(), writesConfigured: false }),
      loadUsage: vi.fn().mockResolvedValue(emptyUsage()),
      oauthConfigured: vi.fn().mockReturnValue(true),
      catalog: [],
      now: () => new Date("2026-09-07T12:00:00.000Z"),
    });

    expect(result.data.overview.state).toBe("partial");
    expect(result.data.overview.inventory.mcp).toEqual({
      state: "unavailable",
      detail: "MCP inventory is temporarily unavailable; no disconnected or healthy state was inferred.",
    });
    expect(JSON.stringify(result.data.overview)).not.toContain("secret detail");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("integrations.overview_source_failed"));
    warn.mockRestore();
  });
});

function disconnectedSalesforceHealth() {
  return {
    schemaVersion: 1,
    contractVersion: "p10.10-salesforce-read-sync:1",
    configured: false,
    connected: false,
    connectionId: null,
    workspaceId: "workspace:test",
    status: "configuration_required",
    accessMode: "read_only",
    objectScope: ["Account", "Contact", "Opportunity", "Case", "Task", "Note", "Product2", "Contract"],
    purposeScope: ["customer_success.account.read", "customer_success.crm_sync"],
    cursor: null,
    lagSeconds: null,
    lastSuccessfulSyncAt: null,
    lastWebhookAt: null,
    lastReplayIdSha256: null,
    actionableError: null,
    evaluatedAt: "2026-09-07T12:00:00.000Z",
  } as never;
}

function emptyUsage() {
  const totals = {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0,
    runs: 0, modelCalls: 0, sourceStreams: 0, providerCalls: 0, attempts: 0,
    failedAttempts: 0, failedCalls: 0, knownEstimatedCostUsd: 0,
    knownCostCalls: 0, unknownCostCalls: 0, costCoveragePercent: 0,
  };
  const period = { label: "", currentLabel: "", previousLabel: "", currentStartAt: "2026-09-07T12:00:00.000Z", currentEndAt: "2026-09-07T12:00:00.000Z", previousStartAt: "2026-09-07T12:00:00.000Z", previousEndAt: "2026-09-07T12:00:00.000Z", bucketUnit: "day", current: totals, previous: totals, series: [], providers: [], models: [] };
  return {
    generatedAt: "2026-09-07T12:00:00.000Z",
    scopeLabel: "test",
    disclosure: "test",
    sourceEventLimitReached: false,
    periods: {
      day: { ...period, key: "day" },
      week: { ...period, key: "week" },
      month: { ...period, key: "month" },
    },
  } as never;
}
