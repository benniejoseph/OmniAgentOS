import { describe, expect, it, vi } from "vitest";

import { showSourceCoverageService } from "@/lib/app-services/source-coverage";

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

describe("P11.9 source coverage application service", () => {
  it("binds every inventory to the canonical/current actor pair and emits a read receipt", async () => {
    const listOAuth = vi.fn().mockResolvedValue([]);
    const loadOwnedSources = vi.fn().mockResolvedValue(emptyOwnedInventory());
    const result = await showSourceCoverageService(caller, { workspaceId: "workspace:test" }, {
      showIntegrations: vi.fn().mockResolvedValue({
        data: { overview: emptyOverview() },
        receipt: {},
      }),
      listOAuth,
      loadOwnedSources,
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });

    const actorIds = [
      "actor:00000000-0000-4000-8000-000000000001",
      "owner@example.test",
    ];
    expect(listOAuth).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant:test",
      actorId: "owner@example.test",
      requestActorBinding: expect.objectContaining({ readableOwnerActorIds: actorIds }),
    }));
    expect(loadOwnedSources).toHaveBeenCalledWith({ tenantId: "tenant:test", actorIds });
    expect(result.receipt).toMatchObject({
      operation: "app.sources.coverage.show",
      accessMode: "read",
      resourceType: "source_coverage",
      resourceCount: result.data.coverage.domains.length,
    });
    expect(result.data.coverage.version).toBe("p11.9-source-coverage:1");
  });

  it("keeps one failed dependency explicit without exposing its error message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await showSourceCoverageService(caller, {}, {
      showIntegrations: vi.fn().mockResolvedValue({ data: { overview: emptyOverview() }, receipt: {} }),
      listOAuth: vi.fn().mockRejectedValue(Object.assign(new Error("secret database detail"), { code: "POOL_TIMEOUT" })),
      loadOwnedSources: vi.fn().mockResolvedValue(emptyOwnedInventory()),
      now: () => new Date("2026-09-08T12:00:00.000Z"),
    });

    expect(result.data.coverage.state).toBe("partial");
    expect(result.data.coverage.inventory.oauth.state).toBe("unavailable");
    expect(JSON.stringify(result.data.coverage)).not.toContain("secret database detail");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("sources.coverage_source_failed"));
    warn.mockRestore();
  });
});

function emptyOverview() {
  return {
    version: "p11.7-truthful-integrations:1",
    generatedAt: "2026-09-08T12:00:00.000Z",
    state: "empty",
    disclosure: {
      catalogSuggestions: "separate_from_installed",
      credentialValuesIncluded: false,
      rawCursorValuesIncluded: false,
      providerContentIncluded: false,
      costBasis: "recorded_attributable_usage_only",
    },
    summary: { installed: 0, working: 0, degraded: 0, actionRequired: 0, unavailable: 0, suggestions: 0 },
    inventory: {
      oauth: { state: "ready", detail: "ready" },
      mcp: { state: "ready", detail: "ready" },
      openapi: { state: "ready", detail: "ready" },
      salesforce: { state: "ready", detail: "ready" },
      usage: { state: "ready", detail: "ready" },
    },
    installed: [],
    suggestions: [],
  } as never;
}

function emptyOwnedInventory() {
  return {
    domains: [],
    knowledgeIndex: { sourceItems: 0, indexedDocuments: 0, chunks: 0, embeddedChunks: 0, lastIndexedAt: null },
    capture: { total: 0, indexed: 0, pending: 0, failed: 0, lastUpdatedAt: null },
  } as const;
}
