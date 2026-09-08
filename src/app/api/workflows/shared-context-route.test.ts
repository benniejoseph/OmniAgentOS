import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  createWorkflowRun: vi.fn(),
  getWorkflowPlanById: vi.fn(),
  requestSharedMemoryAccess: vi.fn(),
  resolveAgentIdentityForExecution: vi.fn(),
  enqueueWorkflowRunTick: vi.fn(),
  requireActivePersonalContextConsent: vi.fn(),
}));

vi.mock("@/lib/agents/identity-store", () => ({
  AgentIdentityResolutionError: class AgentIdentityResolutionError extends Error {},
  resolveAgentIdentityForExecution: mocks.resolveAgentIdentityForExecution,
}));
vi.mock("@/lib/skills/store", () => ({
  getCustomAgent: vi.fn(),
  listAgentSkills: vi.fn(),
}));
vi.mock("@/lib/workflows/agent-private-context", () => ({
  WORKFLOW_AGENT_PRIVATE_CONTEXT_METADATA_KEY:
    "_workflowAgentPrivateContext",
  createWorkflowAgentPrivateContextBinding: vi.fn(() => ({
    bindingSha256: "agent-binding-a",
  })),
  workflowAgentPrivatePlanContextBoundary: vi.fn(() => ({
    schemaVersion: 1,
    policyVersion: "workflow-agent-private-context-v1",
    contextScope: "agent_private",
    agentId: "atlas",
    authoritySha256: "c".repeat(64),
  })),
}));
vi.mock("@/lib/memory/personal-context-consent-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/personal-context-consent-store")>()),
  requireActivePersonalContextConsent:
    mocks.requireActivePersonalContextConsent,
}));
vi.mock("@/lib/workflows/personal-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/personal-context")>()),
  createWorkflowPersonalContextBinding: vi.fn(() => ({
    bindingSha256: "personal-binding-a",
  })),
  workflowPersonalPlanContextBoundary: vi.fn(() => ({
    schemaVersion: 1,
    policyVersion: "workflow-personal-context-v1",
    contextScope: "personal",
    authoritySha256: "d".repeat(64),
  })),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <TArgs extends unknown[], TResult>(
    handler: (...args: TArgs) => TResult,
  ) => handler,
}));
vi.mock("@/lib/app-services/contracts", () => ({
  createAppServiceCaller: vi.fn(),
}));
vi.mock("@/lib/app-services/workflows", () => ({
  listWorkflowsService: vi.fn(),
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn((error: unknown) => Response.json({
    error: error instanceof Error ? error.message : "forbidden",
  }, { status: 500 })),
}));
vi.mock("@/lib/memory/shared-context", () => ({
  requestSharedMemoryAccessFromSecurityContext:
    mocks.requestSharedMemoryAccess,
  SharedContextAuthorityError: class SharedContextAuthorityError extends Error {
    code = "scope_not_found" as const;
  },
}));
vi.mock("@/lib/workflows/shared-context", () => ({
  WORKFLOW_SHARED_CONTEXT_METADATA_KEY: "_workflowSharedContext",
  isWorkflowSharedContextScope: (value: unknown) =>
    value === "mission" || value === "project" || value === "workspace",
  createWorkflowSharedContextBinding: vi.fn(() => ({
    bindingSha256: "binding-a",
  })),
  workflowPlanContextBoundary: vi.fn(() => ({
    schemaVersion: 1,
    policyVersion: "workflow-shared-context-v1",
    contextScope: "project",
    authoritySha256: "a".repeat(64),
  })),
  workflowPlanContextBoundariesEqual: (
    left: { authoritySha256?: string } | undefined,
    right: { authoritySha256?: string } | undefined,
  ) => left?.authoritySha256 === right?.authoritySha256,
}));
vi.mock("@/lib/workflows/store", () => ({
  assertWorkflowRunExecutionAuthority: vi.fn(),
  createWorkflowRun: mocks.createWorkflowRun,
  getWorkflowRunDetail: vi.fn(),
  transitionWorkflowRunWithEvents: vi.fn(),
}));
vi.mock("@/lib/workflows/planner", () => ({
  claimWorkflowPlanForRun: vi.fn(),
  getWorkflowPlanById: mocks.getWorkflowPlanById,
  validateWorkflowPlan: vi.fn(() => ({
    isDag: true,
    missingDependencies: [],
    policyWarnings: [],
  })),
}));
vi.mock("@/lib/workflows/queue", () => ({
  enqueueWorkflowRunTick: mocks.enqueueWorkflowRunTick,
  scheduleWorkflowQueueDrain: vi.fn(),
}));
vi.mock("@/lib/workflows/public", () => ({
  publicWorkflowRunDetail: (detail: unknown) => detail,
}));
vi.mock("@/lib/threads/store", () => ({ getThread: vi.fn() }));

import { POST } from "@/app/api/workflows/route";

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

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(context);
  mocks.getWorkflowPlanById.mockResolvedValue(undefined);
  mocks.requestSharedMemoryAccess.mockResolvedValue({
    authority: {
      workspaceId: "workspace:one",
      projectId: "project:canonical",
      authoritySha256: "a".repeat(64),
    },
    databaseAccessScope: { projectId: "project:canonical" },
  });
  mocks.resolveAgentIdentityForExecution.mockResolvedValue({
    definition: { logicalAgentId: "atlas" },
    principal: {
      principalId: "agent:atlas:principal",
      contextGrantIds: [],
      capabilityGrantIds: [],
    },
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
  mocks.createWorkflowRun.mockImplementation(async (input) => ({
    run: {
      id: "workflow-a",
      tenantId: "tenant-a",
      workflowType: "agent.workflow.v1",
      status: "queued",
      goal: input.goal,
      input,
      attempt: 0,
      maxAttempts: 3,
      approvalRequired: false,
      createdAt: "2026-09-08T00:00:00.000Z",
      updatedAt: "2026-09-08T00:00:00.000Z",
    },
    steps: [],
    events: [],
  }));
  mocks.enqueueWorkflowRunTick.mockResolvedValue({ id: "job-a" });
});

describe("workflow start shared context", () => {
  it("replaces caller metadata with a server binding and avoids explicit-empty retrieval", async () => {
    const response = await POST(workflowRequest({
      contextScope: "project",
      projectId: "legacy-project-a",
      _workflowSharedContext: { bindingSha256: "caller-value" },
    }));

    expect(response.status).toBe(201);
    expect(mocks.requestSharedMemoryAccess).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        scope: "project",
        projectId: "legacy-project-a",
        correlationId: expect.stringMatching(/^workflow-request:/),
      }),
    );
    expect(mocks.createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAuthority: expect.objectContaining({
          executionScope: expect.objectContaining({
            workspaceId: "workspace:one",
            projectId: "project:canonical",
          }),
        }),
        metadata: expect.objectContaining({
          contextScope: "project",
          _workflowSharedContext: { bindingSha256: "binding-a" },
        }),
      }),
    );
    const created = mocks.createWorkflowRun.mock.calls[0]?.[0];
    expect(created.metadata.contextSelection).toBeUndefined();
  });

  it("rejects a reviewed plan bound to another shared authority", async () => {
    mocks.getWorkflowPlanById.mockResolvedValue({
      id: "plan-a",
      status: "planned",
      goal: "Prepare the Project brief",
      plan: { mode: "orchestrate", nodes: [] },
      contextBoundary: {
        authoritySha256: "b".repeat(64),
      },
    });

    const response = await POST(workflowRequest({
      contextScope: "project",
      projectId: "legacy-project-a",
    }, { planId: "plan-a" }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringMatching(/different context boundary/i),
    });
    expect(mocks.createWorkflowRun).not.toHaveBeenCalled();
  });

  it("replaces caller Agent metadata with an exact Agent-private binding", async () => {
    const response = await POST(workflowRequest({
      contextScope: "agent_private",
      agentId: "atlas",
      primaryAgentId: "caller-agent",
      agentIdentity: { principal: { principalId: "caller-principal" } },
      _workflowAgentPrivateContext: { bindingSha256: "caller-value" },
    }));

    expect(response.status).toBe(201);
    expect(mocks.resolveAgentIdentityForExecution).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "owner@example.test",
      agentId: "atlas",
    });
    expect(mocks.createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executionAuthority: expect.objectContaining({
          executionScope: expect.objectContaining({
            executingPrincipalType: "agent",
            executingPrincipalId: "agent:atlas:principal",
          }),
        }),
        metadata: expect.objectContaining({
          contextScope: "agent_private",
          agentId: "atlas",
          primaryAgentId: "atlas",
          agentIdentity: expect.objectContaining({
            principal: expect.objectContaining({
              principalId: "agent:atlas:principal",
            }),
          }),
          _workflowAgentPrivateContext: {
            bindingSha256: "agent-binding-a",
          },
        }),
      }),
    );
    const created = mocks.createWorkflowRun.mock.calls[0]?.[0];
    expect(created.metadata.contextSelection).toBeUndefined();
  });

  it("replaces caller metadata with an active personal-context binding", async () => {
    const response = await POST(workflowRequest({
      contextScope: "personal",
      _workflowPersonalContext: { bindingSha256: "caller-value" },
    }));

    expect(response.status).toBe(201);
    expect(mocks.requireActivePersonalContextConsent).toHaveBeenCalledOnce();
    expect(mocks.createWorkflowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          contextScope: "personal",
          _workflowPersonalContext: {
            bindingSha256: "personal-binding-a",
          },
        }),
      }),
    );
    const created = mocks.createWorkflowRun.mock.calls[0]?.[0];
    expect(created.metadata.contextSelection).toBeUndefined();
  });
});

function workflowRequest(
  metadata: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
) {
  return new Request("http://asael.test/api/workflows", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "Prepare the Project brief",
      mode: "orchestrate",
      requireApproval: false,
      metadata,
      ...overrides,
    }),
  });
}
