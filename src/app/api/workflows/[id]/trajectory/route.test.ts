import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getWorkflowRunDetail: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
  listStreamEvents: vi.fn(),
  listCorrelatedEvents: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/workflows/store", () => ({
  getWorkflowRunDetail: mocks.getWorkflowRunDetail,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
}));
vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listStreamEvents,
  listCorrelatedEvents: mocks.listCorrelatedEvents,
}));

import { GET } from "@/app/api/workflows/[id]/trajectory/route";

const detail: WorkflowRunDetail = {
  run: {
    id: "workflow-one",
    tenantId: "tenant-one",
    workflowType: "dynamic",
    status: "completed",
    goal: "private workflow goal",
    input: { goal: "private workflow goal" },
    attempt: 1,
    maxAttempts: 3,
    approvalRequired: false,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:04.000Z",
    completedAt: "2026-09-06T00:00:04.000Z",
  },
  steps: [],
  events: [],
};

function event(id: string, seq: number, streamId: string, type: string): DomainEvent {
  return {
    id,
    seq,
    streamId,
    type,
    tenantId: "tenant-one",
    actorId: "actor-one",
    payload: {},
    correlationId: "request-one",
    at: `2026-09-06T00:00:0${seq}.000Z`,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-one",
    actorId: "actor-one",
    role: "operator",
    source: "session",
  });
  mocks.getWorkflowRunDetail.mockResolvedValue(detail);
  mocks.getWorkflowRunExecutionAuthority.mockResolvedValue({
    requesterRole: "operator",
    executionScope: {
      version: 1,
      tenantId: "tenant-one",
      initiatingActorId: "actor-one",
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      workspaceId: null,
      projectId: null,
      missionId: null,
      delegationId: null,
      correlationId: "request-one",
      causationId: null,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purpose: "workflow.run",
    },
  });
  mocks.listStreamEvents.mockResolvedValue([
    event("workflow-plan", 2, "workflow:workflow-one", "workflow.dynamic_plan.created"),
    event("workflow-model", 3, "workflow:workflow-one", "model.called"),
    event("workflow-done", 4, "workflow:workflow-one", "workflow.completed"),
  ]);
  mocks.listCorrelatedEvents.mockResolvedValue([
    event("intent", 1, "intent:request-one", "intent.semantic_resolved"),
    event("workflow-plan", 2, "workflow:workflow-one", "workflow.dynamic_plan.created"),
  ]);
});

describe("workflow trajectory route", () => {
  it("returns a correlated workflow trace inside the owner boundary", async () => {
    const response = await GET(
      new Request("http://asael.test/api/workflows/workflow-one/trajectory"),
      { params: Promise.resolve({ id: "workflow-one" }) },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.traceHierarchy).toMatchObject({
      runId: "workflow-one",
      outcome: "succeeded",
      summary: { eventCount: 4 },
    });
    expect(mocks.listCorrelatedEvents).toHaveBeenCalledWith("request-one", {
      tenantId: "tenant-one",
      actorId: "actor-one",
      limit: 2_000,
    });
    expect(JSON.stringify(body)).not.toContain("private workflow goal");
    expect(JSON.stringify(body)).not.toContain("request-one");
  });

  it("fails closed without an owner-bound workflow authority", async () => {
    mocks.getWorkflowRunExecutionAuthority.mockResolvedValue(undefined);
    const response = await GET(
      new Request("http://asael.test/api/workflows/workflow-one/trajectory"),
      { params: Promise.resolve({ id: "workflow-one" }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.listCorrelatedEvents).not.toHaveBeenCalled();
  });
});
