import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  buildDynamicWorkflowPlan: vi.fn(),
  getWorkflowPlanStats: vi.fn(),
  listWorkflowPlans: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
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
  actorId: "actor-a",
  role: "admin" as const,
  source: "session" as const,
};

describe("workflow plan context lock", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "workflow-plan-lock-test-secret");
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.buildDynamicWorkflowPlan.mockResolvedValue({ id: "plan-a", status: "planned" });
    mocks.getWorkflowPlanStats.mockResolvedValue({ plans: 1 });
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

  it("keeps Mission context on the direct Conversation boundary", async () => {
    const response = await POST(workflowPlanRequest({
      contextScope: "mission",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Context scope unavailable",
      message: expect.stringMatching(/direct Conversation/i),
    });
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
    expect(mocks.buildDynamicWorkflowPlan).not.toHaveBeenCalled();
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
