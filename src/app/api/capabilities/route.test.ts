import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  const cacheEntries = new Map<string, unknown>();
  return {
    after: vi.fn(),
    cacheEntries,
    getRunStats: vi.fn(),
    loadSettingsSnapshot: vi.fn(),
    loadSharedSnapshot: vi.fn(),
    resolveSecurityContext: vi.fn(),
    resolveSpecializedRuntime: vi.fn(),
    stats: async () => ({}),
    unstableCache: (
      callback: (...args: unknown[]) => Promise<unknown>,
      keyParts: string[] = [],
    ) =>
      async (...args: unknown[]) => {
        // Next keys an entry by the callback source, key parts, and arguments.
        const key = `${callback.toString()}-${keyParts.join(",")}-${JSON.stringify(args)}`;
        if (!cacheEntries.has(key)) {
          cacheEntries.set(key, await callback(...args));
        }
        return cacheEntries.get(key);
      },
  };
});

vi.mock("next/cache", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/cache")>()),
  unstable_cache: routeMocks.unstableCache,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: routeMocks.after,
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
  getVectorStoreStatus: async () => ({ status: "ready" }),
}));

vi.mock("@/lib/security/context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/context")>()),
  canPerform: () => true,
  requirePermission: () => undefined,
  resolveSecurityContext: routeMocks.resolveSecurityContext,
}));

vi.mock("@/lib/runs/store", () => ({ getRunStats: routeMocks.getRunStats }));
vi.mock("@/lib/memory/store", () => ({ getMemoryStats: routeMocks.stats }));
vi.mock("@/lib/memory/graph", () => ({ getMemoryGraphStats: routeMocks.stats }));
vi.mock("@/lib/rag/store", () => ({ getKnowledgeStats: routeMocks.stats }));
vi.mock("@/lib/rag/context-engine", () => ({
  getContextEngineStats: routeMocks.stats,
}));
vi.mock("@/lib/tools/audit-store", () => ({
  getToolExecutionStats: routeMocks.stats,
}));
vi.mock("@/lib/connectors/store", () => ({
  getMcpConnectorStats: routeMocks.stats,
}));
vi.mock("@/lib/connectors/openapi-store", () => ({
  getOpenApiConnectorStats: routeMocks.stats,
}));
vi.mock("@/lib/workflows/store", () => ({ getWorkflowStats: routeMocks.stats }));
vi.mock("@/lib/workflows/planner", () => ({
  getWorkflowPlanStats: routeMocks.stats,
}));
vi.mock("@/lib/workflows/executor", () => ({
  getWorkflowPlanNodeExecutionStats: routeMocks.stats,
}));
vi.mock("@/lib/workflows/triggers", () => ({
  getWorkflowTriggerStats: routeMocks.stats,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  getOperationJobStats: routeMocks.stats,
}));
vi.mock("@/lib/diagnostics/health", () => ({ getHealthStats: routeMocks.stats }));
vi.mock("@/lib/diagnostics/incidents", () => ({
  getIncidentStats: routeMocks.stats,
}));
vi.mock("@/lib/diagnostics/alerts", () => ({
  getAlertDeliveryStats: routeMocks.stats,
}));
vi.mock("@/lib/observability/store", () => ({
  getObservabilityStats: routeMocks.stats,
}));
vi.mock("@/lib/observability/slo-monitor", () => ({
  getObservabilitySloSnapshot: routeMocks.stats,
}));
vi.mock("@/lib/evaluations/store", () => ({ getEvalStats: routeMocks.stats }));
vi.mock("@/lib/security/audit-store", () => ({
  getSecurityStats: routeMocks.stats,
}));

vi.mock("@/lib/capabilities/settings-snapshot", () => ({
  loadSettingsStorageSnapshot: routeMocks.loadSettingsSnapshot,
}));

vi.mock("@/lib/capabilities/settings-cache", () => ({
  loadSharedSettingsStorageSnapshot: routeMocks.loadSharedSnapshot,
}));

vi.mock("@/lib/settings/specialized-runtime", () => ({
  resolveSpecializedRuntime: routeMocks.resolveSpecializedRuntime,
}));

import { GET } from "@/app/api/capabilities/route";
import {
  getDatabaseActorContext,
  runWithDatabaseActorScope,
} from "@/lib/db/client";

const degradedSnapshot = {
  vectorStore: {
    configured: null,
    dimensions: 1_536,
    hnswSupported: true,
    status: "unavailable",
    unavailableReason: "timeout",
  },
  memory: {
    total: null,
    byType: null,
    embedded: null,
    status: "unavailable",
    unavailableReason: "timeout",
  },
  knowledge: {
    documents: null,
    chunks: null,
    characters: null,
    embedded: null,
    status: "unavailable",
    unavailableReason: "timeout",
  },
  storageSnapshot: {
    status: "degraded",
    source: "postgres",
    reason: "timeout",
    checkedAt: "2026-08-26T12:00:00.000Z",
  },
};

beforeEach(() => {
  routeMocks.cacheEntries.clear();
  routeMocks.getRunStats.mockReset();
  routeMocks.resolveSecurityContext.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "owner-a",
    role: "admin",
  });
  routeMocks.after.mockReset();
  routeMocks.loadSettingsSnapshot.mockReset();
  routeMocks.loadSharedSnapshot.mockReset();
  routeMocks.resolveSpecializedRuntime.mockReset().mockResolvedValue({
    configured: true,
    provider: "google",
    model: "configured-image-model",
    source: "tenant_assignment",
    usageReceipt: { credentialSource: "tenant_vault" },
  });
});

describe("Settings capabilities cache fill", () => {
  it("advertises the explicitly selected installed Mac runtime", async () => {
    routeMocks.loadSettingsSnapshot.mockResolvedValue(degradedSnapshot);

    const response = await GET(
      new Request("http://localhost/api/capabilities?view=settings"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      computerUseRoute: {
        runtime: "installed_macos_app",
        target: "local_macos",
        authority: "explicit_selection_required",
      },
    });
  });

  it("keeps the exact shared fill alive after a bounded degraded response", async () => {
    let resolveFill!: (value: unknown) => void;
    const fill = new Promise((resolve) => {
      resolveFill = resolve;
    });
    routeMocks.loadSharedSnapshot.mockReturnValue(fill);
    routeMocks.loadSettingsSnapshot.mockImplementation(
      async (tenantId: string, options: { loader: (id: string) => Promise<unknown> }) => {
        expect(tenantId).toBe("tenant-a");
        expect(options.loader(tenantId)).toBe(fill);
        return degradedSnapshot;
      },
    );

    const response = await GET(
      new Request("http://localhost/api/capabilities?view=settings"),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      storageSnapshot: { status: "degraded", reason: "timeout" },
    });
    expect(routeMocks.loadSharedSnapshot).toHaveBeenCalledWith("tenant-a");
    expect(routeMocks.after).toHaveBeenCalledOnce();

    resolveFill({});
    await expect(routeMocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
  });

  it("sanitizes a failed post-response fill", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const fill = Promise.reject(new Error("postgres://private-host/secret"));
    routeMocks.loadSharedSnapshot.mockReturnValue(fill);
    routeMocks.loadSettingsSnapshot.mockImplementation(
      async (tenantId: string, options: { loader: (id: string) => Promise<unknown> }) => {
        void options.loader(tenantId);
        return degradedSnapshot;
      },
    );

    await GET(new Request("http://localhost/api/capabilities?view=settings"));
    await expect(routeMocks.after.mock.calls[0][0]()).resolves.toBeUndefined();

    expect(warning).toHaveBeenCalledOnce();
    expect(JSON.stringify(warning.mock.calls)).toContain(
      "capabilities.settings_storage_cache_fill_failed",
    );
    expect(JSON.stringify(warning.mock.calls)).not.toContain("private-host");
    warning.mockRestore();
  });
});

describe("Full capabilities cache", () => {
  it("never serves one actor's cached runs to another actor", async () => {
    // Row-level security returns only the active actor scope's latest runs.
    routeMocks.getRunStats.mockImplementation(async () => {
      const [actorId] = getDatabaseActorContext();
      return {
        total: 1,
        byStatus: { completed: 1 },
        latest: [{ id: `run-${actorId}`, prompt: `${actorId} private prompt` }],
      };
    });
    const readAs = (actorId: string) => {
      routeMocks.resolveSecurityContext.mockResolvedValueOnce({
        tenantId: "tenant-a",
        actorId,
        role: "admin",
      });
      return runWithDatabaseActorScope("tenant-a", [actorId], async () =>
        (await GET(new Request("http://localhost/api/capabilities"))).json());
    };

    const ownerA = await readAs("owner-a");
    const repeatA = await readAs("owner-a");
    const ownerB = await readAs("owner-b");

    expect(repeatA).toEqual(ownerA);
    expect(ownerA.runs.latest).toEqual([
      { id: "run-owner-a", prompt: "owner-a private prompt" },
    ]);
    expect(ownerB.runs.latest).toEqual([
      { id: "run-owner-b", prompt: "owner-b private prompt" },
    ]);
    expect(JSON.stringify(ownerB)).not.toContain("owner-a private prompt");
    expect(routeMocks.getRunStats).toHaveBeenCalledTimes(2);
  });
});
