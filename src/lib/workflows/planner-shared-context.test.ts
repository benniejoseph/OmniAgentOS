import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  buildContextPack: vi.fn(),
  definitions: [] as ToolDefinition[],
}));

vi.mock("@/lib/rag/context-engine", () => ({
  buildContextPack: mocks.buildContextPack,
}));
vi.mock("@/lib/capabilities/toolbox", () => ({
  loadProgressiveAgentTools: vi.fn(async () => ({
    definitions: mocks.definitions,
    omittedToolIds: [],
    schemaBytes: 0,
  })),
}));

const requiredTool: ToolDefinition = {
  id: "runs.list",
  name: "List runs",
  description: "List recent workflow runs.",
  category: "runs",
  status: "active",
  riskLevel: 0,
  dryRunSupported: true,
  approvalRequired: false,
  inputSchema: { type: "object" },
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-shared-context-planner-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  mocks.definitions = [requiredTool];
  mocks.buildContextPack.mockReset().mockResolvedValue({
    contextBlock: "Authorized Project context",
    trace: undefined,
  });
});

describe("workflow planner shared-context boundary", () => {
  it("uses only the authorized scope and preserves its content-free plan binding", async () => {
    const { buildDynamicWorkflowPlan, getWorkflowPlanById } = await import(
      "@/lib/workflows/planner"
    );
    const databaseMemoryAccessScope = {
      version: 1 as const,
      tenantId: "tenant-shared",
      initiatingActorId: "actor:owner",
      executingPrincipalType: "user" as const,
      executingPrincipalId: "actor:owner",
      workspaceId: "workspace:one",
      projectId: "project:one",
      missionId: null,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purposeId: "memory.retrieve.v1",
      purpose: "Retrieve explicitly selected shared workspace context.",
    };
    const contextBoundary = {
      schemaVersion: 1 as const,
      policyVersion: "workflow-shared-context-v1" as const,
      contextScope: "project" as const,
      authoritySha256: "a".repeat(64),
    };

    const record = await buildDynamicWorkflowPlan({
      tenantId: "tenant-shared",
      actorId: "owner@example.test",
      goal: "List recent runs for this Project",
      databaseMemoryAccessScope,
      contextBoundary,
      requiredToolBindings: [{ toolId: "runs.list", input: { limit: 5 } }],
    });

    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "List recent runs for this Project",
      expect.objectContaining({
        databaseMemoryAccessScope,
        scopedMemoryOnly: true,
        persistTrace: false,
        evidenceIds: undefined,
      }),
    );
    expect(record.contextBoundary).toEqual(contextBoundary);
    await expect(getWorkflowPlanById(record.id, {
      tenantId: "tenant-shared",
    })).resolves.toMatchObject({ contextBoundary });
  });

  it("rejects a partial shared-context authority", async () => {
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    await expect(buildDynamicWorkflowPlan({
      tenantId: "tenant-shared",
      goal: "List recent runs",
      contextBoundary: {
        schemaVersion: 1,
        policyVersion: "workflow-shared-context-v1",
        contextScope: "project",
        authoritySha256: "a".repeat(64),
      },
    })).rejects.toThrow(/complete authority boundary/i);
    expect(mocks.buildContextPack).not.toHaveBeenCalled();
  });
});
