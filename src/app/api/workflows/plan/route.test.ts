import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  buildDynamicWorkflowPlan: vi.fn(),
  getWorkflowPlanStats: vi.fn(),
  listWorkflowPlans: vi.fn(),
  resolveAgentIdentityForExecution: vi.fn(),
  requireActivePersonalContextConsent: vi.fn(),
  sql: vi.fn(),
}));

vi.mock("@/lib/agents/identity-store", () => ({
  AgentIdentityResolutionError: class AgentIdentityResolutionError extends Error {},
  resolveAgentIdentityForExecution: mocks.resolveAgentIdentityForExecution,
}));
vi.mock("@/lib/workflows/agent-private-context", () => ({
  workflowAgentPrivateDatabaseAccessScope: vi.fn(() => ({
    version: 1,
    tenantId: "tenant-a",
    initiatingActorId: "owner@example.test",
    executingPrincipalType: "agent",
    executingPrincipalId: "agent:atlas:principal",
    workspaceId: null,
    projectId: null,
    missionId: null,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purposeId: "memory.retrieve.v1",
    purpose: "Retrieve memory owned by the exact assigned agent.",
  })),
  workflowAgentPrivatePlanContextBoundary: vi.fn(() => ({
    schemaVersion: 1,
    policyVersion: "workflow-agent-private-context-v1",
    contextScope: "agent_private",
    agentId: "atlas",
    authoritySha256: "b".repeat(64),
  })),
}));
vi.mock("@/lib/memory/personal-context-consent-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/personal-context-consent-store")>()),
  requireActivePersonalContextConsent:
    mocks.requireActivePersonalContextConsent,
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: () => mocks.sql,
  hasDatabaseUrl: () => true,
  withDatabaseRequestScope: <TArgs extends unknown[], TResult>(
    handler: (...args: TArgs) => TResult,
  ) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(() => Response.json({ error: "forbidden" }, { status: 403 })),
}));
vi.mock("@/lib/workflows/planner", () => ({
  buildDynamicWorkflowPlan: mocks.buildDynamicWorkflowPlan,
  getWorkflowPlanStats: mocks.getWorkflowPlanStats,
  listWorkflowPlans: mocks.listWorkflowPlans,
}));

import { POST } from "@/app/api/workflows/plan/route";
import {
  issueContextSelectionPreview,
  lockContextSelection,
} from "@/lib/rag/context-selection-lock";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

describe("workflow plan context lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "workflow-plan-lock-test-secret");
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.buildDynamicWorkflowPlan.mockResolvedValue({ id: "plan-a", status: "planned" });
    mocks.getWorkflowPlanStats.mockResolvedValue({ plans: 1 });
    mocks.resolveAgentIdentityForExecution.mockResolvedValue({
      definition: { logicalAgentId: "atlas" },
      principal: { principalId: "agent:atlas:principal" },
    });
    mocks.requireActivePersonalContextConsent.mockResolvedValue({
      schemaVersion: 1,
      contractId: "personal-context-consent:1",
      tenantId: context.tenantId,
      actorId: `actor:${context.auth.userId}`,
      consentGeneration: 1,
      lifecycleRevision: 1,
      noticeContractId: "notice:personal-context-automatic",
      noticeContractVersion: 1,
      noticeSha256:
        "443267b19d744dc16298e950b4c5c0f8543124a526488fa018668193e61f1e75",
      activatedAt: "2026-09-08T00:00:00.000Z",
      authoritySha256:
        "e0fe7b722444187d3c675b38f84c575139c74f8e8393fe267cffaa3c51ee9fe5",
    });
    mocks.sql.mockImplementation((parts: TemplateStringsArray) => {
      const query = parts.join(" ");
      if (query.includes("FROM omni_work_projects")) {
        return [{
          workspace_id: "workspace:personal:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
          project_id: "project:launch",
          access_level: "manager",
        }];
      }
      if (query.includes("FROM omni_tenant_workspaces")) {
        return [{
          workspace_id: "workspace:personal:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
          access_level: "manager",
        }];
      }
      return [];
    });
  });

  it("plans only with the authenticated locked selection", async () => {
    const selection = lockedSelection();
    const response = await POST(workflowPlanRequest({
      contextScope: "explicit_selection",
      contextSelection: selection,
    }));

    expect(response.status).toBe(201);
    expect(mocks.buildDynamicWorkflowPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId: context.actorId,
        contextSelection: expect.objectContaining({
          selectionSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          evidenceIds: ["knowledge:runbook"],
        }),
      }),
    );
  });

  it("uses an explicit empty boundary for non-durable scopes", async () => {
    const response = await POST(workflowPlanRequest({ contextScope: "session" }));

    expect(response.status).toBe(201);
    expect(mocks.buildDynamicWorkflowPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSelection: {
          query: "Run the reviewed procedure",
          evidenceIds: [],
        },
      }),
    );
  });

  it("plans Mission context through its canonical Project authority", async () => {
    const response = await POST(workflowPlanRequest({
      contextScope: "mission",
      missionId: "b30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    }));

    expect(response.status).toBe(201);
    expect(mocks.buildDynamicWorkflowPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSelection: undefined,
        databaseMemoryAccessScope: expect.objectContaining({
          projectId: "project:launch",
          purposeId: "memory.retrieve.v1",
        }),
        contextBoundary: expect.objectContaining({
          contextScope: "mission",
          authoritySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
        executionScope: expect.objectContaining({
          projectId: "project:launch",
          missionId: "b30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
        }),
      }),
    );
  });

  it("plans Agent-private context with the exact selected Agent authority", async () => {
    const response = await POST(workflowPlanRequest({
      contextScope: "agent_private",
      agentId: "atlas",
    }));

    expect(response.status).toBe(201);
    expect(mocks.resolveAgentIdentityForExecution).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      agentId: "atlas",
    });
    expect(mocks.buildDynamicWorkflowPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSelection: undefined,
        databaseMemoryAccessScope: expect.objectContaining({
          executingPrincipalType: "agent",
          executingPrincipalId: "agent:atlas:principal",
          workspaceId: null,
          projectId: null,
          missionId: null,
        }),
        contextBoundary: expect.objectContaining({
          contextScope: "agent_private",
          agentId: "atlas",
          authoritySha256: "b".repeat(64),
        }),
      }),
    );
  });

  it("plans automatic personal context with active standing consent", async () => {
    const response = await POST(workflowPlanRequest({
      contextScope: "personal",
    }));

    expect(response.status).toBe(201);
    expect(mocks.requireActivePersonalContextConsent).toHaveBeenCalledOnce();
    expect(mocks.buildDynamicWorkflowPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        contextSelection: undefined,
        databaseMemoryAccessScope: expect.objectContaining({
          initiatingActorId: `actor:${context.auth.userId}`,
          executingPrincipalType: "user",
          workspaceId: null,
          projectId: null,
          missionId: null,
        }),
        contextBoundary: expect.objectContaining({
          contextScope: "personal",
          policyVersion: "workflow-personal-context-v1",
        }),
      }),
    );
  });

  it("rejects a changed selection after lock", async () => {
    const selection = { ...lockedSelection(), evidenceIds: [] };
    const response = await POST(workflowPlanRequest({
      contextScope: "explicit_selection",
      contextSelection: selection,
    }));

    expect(response.status).toBe(409);
    expect(mocks.buildDynamicWorkflowPlan).not.toHaveBeenCalled();
  });
});

function lockedSelection() {
  const preview = issueContextSelectionPreview({
    tenantId: context.tenantId,
    actorId: context.actorId,
    query: "Run the reviewed procedure",
    candidateEvidenceIds: ["knowledge:runbook", "memory:preference"],
    contextPackSha256: "a".repeat(64),
  });
  const locked = lockContextSelection({
    tenantId: context.tenantId,
    actorId: context.actorId,
    query: "Run the reviewed procedure",
    evidenceIds: ["knowledge:runbook"],
    previewToken: preview.token,
  });
  return {
    query: locked.binding.query,
    evidenceIds: locked.binding.evidenceIds,
    lockToken: locked.token,
  };
}

function workflowPlanRequest(overrides: Record<string, unknown>) {
  return new Request("http://asael.test/api/workflows/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "Run the reviewed procedure",
      mode: "orchestrate",
      ...overrides,
    }),
  });
}
