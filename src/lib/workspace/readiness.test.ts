import { afterEach, describe, expect, it, vi } from "vitest";

const readinessMocks = vi.hoisted(() => {
  const entries = new Map<string, unknown>();
  return {
    entries,
    getRunStats: vi.fn(),
    unstableCache: (
      callback: (...args: unknown[]) => Promise<unknown>,
      keyParts: string[] = [],
    ) =>
      async (...args: unknown[]) => {
        // Next keys an entry by the callback source, key parts, and arguments.
        const key = `${callback.toString()}-${keyParts.join(",")}-${JSON.stringify(args)}`;
        if (!entries.has(key)) entries.set(key, await callback(...args));
        return entries.get(key);
      },
  };
});

vi.mock("next/cache", () => ({
  unstable_cache: readinessMocks.unstableCache,
}));
vi.mock("@/lib/runs/store", () => ({ getRunStats: readinessMocks.getRunStats }));
vi.mock("@/lib/memory/store", () => ({ getMemoryStats: async () => ({ total: 0 }) }));
vi.mock("@/lib/rag/store", () => ({
  getKnowledgeStats: async () => ({ documents: 0 }),
}));
vi.mock("@/lib/connectors/store", () => ({
  getMcpConnectorStats: async () => ({ active: 0 }),
}));
vi.mock("@/lib/connectors/openapi-store", () => ({
  getOpenApiConnectorStats: async () => ({ active: 0 }),
}));
vi.mock("@/lib/connectors/oauth-store", () => ({
  listOAuthGrantsForTenant: async () => [],
}));
vi.mock("@/lib/workflows/store", () => ({
  getWorkflowStats: async () => ({ byStatus: {} }),
}));
vi.mock("@/lib/evaluations/store", () => ({ getEvalStats: async () => ({ total: 0 }) }));

import {
  getDatabaseActorContext,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  calculateWorkspaceReadiness,
  loadWorkspaceReadiness,
} from "@/lib/workspace/readiness";

afterEach(() => {
  readinessMocks.entries.clear();
  readinessMocks.getRunStats.mockReset();
});

describe("workspace readiness", () => {
  it("maps aggregate tenant stats to five readiness checks", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 1,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 1,
      activeOAuthConnectors: 0,
      completedAgentRuns: 0,
      completedWorkflows: 1,
      evaluationTotal: 1,
    })).toMatchObject({
      checks: {
        identity: true,
        knowledge: true,
        connector: true,
        firstRun: true,
        evaluation: true,
      },
      completedCount: 5,
      totalCount: 5,
      firstSuccessfulRun: true,
    });
  });

  it("treats optional missing setup as incomplete rather than an error", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 0,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 0,
      activeOAuthConnectors: 0,
      completedAgentRuns: 0,
      completedWorkflows: 0,
      evaluationTotal: 0,
    })).toMatchObject({
      completedCount: 1,
      firstSuccessfulRun: false,
    });
  });

  it("keeps each actor's first-run check in its own cache entry", async () => {
    // Row-level security counts only the active actor scope's agent runs.
    readinessMocks.getRunStats.mockImplementation(async () => ({
      byStatus: getDatabaseActorContext().includes("actor-a")
        ? { completed: 1 }
        : {},
    }));
    const readAs = (actorId: string) =>
      runWithDatabaseActorScope("tenant-a", [actorId], () =>
        loadWorkspaceReadiness({ tenantId: "tenant-a", identityReady: true }));

    const ownerA = await readAs("actor-a");
    const repeatA = await readAs("actor-a");
    const ownerB = await readAs("actor-b");

    expect(ownerA.checks.firstRun).toBe(true);
    expect(repeatA).toEqual(ownerA);
    expect(ownerB.checks.firstRun).toBe(false);
    expect(readinessMocks.getRunStats).toHaveBeenCalledTimes(2);
  });

  it("loads every aggregate for the requested tenant", async () => {
    const calls: string[] = [];
    const aggregate = async (tenantId: string) => {
      calls.push(tenantId);
      return 0;
    };
    const readiness = await loadWorkspaceReadiness(
      { tenantId: "tenant-a", identityReady: true },
      {
        memoryTotal: aggregate,
        knowledgeTotal: aggregate,
        activeMcpConnectors: aggregate,
        activeOpenApiConnectors: aggregate,
        activeOAuthConnectors: aggregate,
        completedAgentRuns: aggregate,
        completedWorkflows: aggregate,
        evaluationTotal: aggregate,
      },
    );
    expect(calls).toEqual(Array(8).fill("tenant-a"));
    expect(readiness.checks.identity).toBe(true);
  });

  it("treats a personal Google grant as an active connector", () => {
    expect(calculateWorkspaceReadiness({
      identityReady: true,
      memoryTotal: 0,
      knowledgeTotal: 0,
      activeMcpConnectors: 0,
      activeOpenApiConnectors: 0,
      activeOAuthConnectors: 1,
      completedAgentRuns: 0,
      completedWorkflows: 0,
      evaluationTotal: 0,
    }).checks.connector).toBe(true);
  });
});
