import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORIZED_MEMORY_ONLY_RETRIEVAL_SOURCES } from "@/lib/rag/context-engine";
import type { ToolDefinition } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  buildContextPack: vi.fn(),
  appendScopedDomainEvent: vi.fn(),
  definitions: [] as ToolDefinition[],
}));

vi.mock("@/lib/rag/context-engine", () => ({
  AUTHORIZED_CONTEXT_RETRIEVAL_SOURCES: Object.freeze({
    memory: "authorized_only",
    knowledge: "canonical_authorized",
    topicGraph: "exclude",
    entityGraph: "authorized",
  }),
  AUTHORIZED_MEMORY_ONLY_RETRIEVAL_SOURCES: Object.freeze({
    memory: "authorized_only",
    knowledge: "exclude",
    topicGraph: "exclude",
    entityGraph: "exclude",
  }),
  buildContextPack: mocks.buildContextPack,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
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
  mocks.appendScopedDomainEvent.mockReset().mockResolvedValue(undefined);
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
        retrievalSources: AUTHORIZED_MEMORY_ONLY_RETRIEVAL_SOURCES,
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

  it("commits an automatic compiler barrier before personal-context planning", async () => {
    const { buildDynamicWorkflowPlan } = await import("@/lib/workflows/planner");
    const executionScope = {
      version: 1 as const,
      tenantId: "tenant-shared",
      initiatingActorId: "owner@example.test",
      executingPrincipalType: "user" as const,
      executingPrincipalId: "owner@example.test",
      workspaceId: null,
      projectId: null,
      missionId: null,
      delegationId: null,
      correlationId: "personal-plan-a",
      causationId: null,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purpose: "workflow.plan.create",
    };
    const databaseMemoryAccessScope = {
      version: 1 as const,
      tenantId: "tenant-shared",
      initiatingActorId: "actor:owner",
      executingPrincipalType: "user" as const,
      executingPrincipalId: "actor:owner",
      workspaceId: null,
      projectId: null,
      missionId: null,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purposeId: "memory.retrieve.v1",
      purpose: "agent.context.personal.retrieve",
    };
    const receipt = {
      receiptSha256: "f".repeat(64),
      mode: "automatic",
    };
    mocks.buildContextPack.mockResolvedValue({
      contextBlock: "Authorized personal context",
      trace: undefined,
      compilerV2Automatic: { receipt, selectedEvidenceIds: [] },
    });

    await buildDynamicWorkflowPlan({
      tenantId: "tenant-shared",
      actorId: "owner@example.test",
      goal: "List recent runs for me",
      databaseMemoryAccessScope,
      contextBoundary: {
        schemaVersion: 1,
        policyVersion: "workflow-personal-context-v1",
        contextScope: "personal",
        authoritySha256: "a".repeat(64),
      },
      executionScope,
      requiredToolBindings: [{ toolId: "runs.list", input: { limit: 5 } }],
    });

    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "List recent runs for me",
      expect.objectContaining({
        databaseMemoryAccessScope,
        contextCompilerV2Automatic: expect.objectContaining({
          executionScope,
        }),
      }),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "workflow.plan.context_compiler_v2.automatic",
        payload: receipt,
        executionScope: expect.objectContaining({
          purpose: "workflow.plan.context_compiler_v2.automatic",
        }),
      }),
    );
  });
});
