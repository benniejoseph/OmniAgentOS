import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  createWorkflowRun: vi.fn(),
  getWorkflowPlanById: vi.fn(),
  requestSharedMemoryAccess: vi.fn(),
  enqueueWorkflowRunTick: vi.fn(),
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
