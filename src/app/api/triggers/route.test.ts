import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  executionScopeFromSecurityContext: vi.fn(),
  createReviewedWorkflowSchedule: vi.fn(),
  createWorkflowTrigger: vi.fn(),
  getWorkflowTrigger: vi.fn(),
  getWorkflowTriggerStats: vi.fn(),
  listSchedulableWorkflowProcedures: vi.fn(),
  listWorkflowScheduleOccurrenceReceipts: vi.fn(),
  listWorkflowScheduleOccurrences: vi.fn(),
  listWorkflowTriggerEvents: vi.fn(),
  listWorkflowTriggers: vi.fn(),
  listCustomAgentsForRequest: vi.fn(),
  previewWorkflowSchedule: vi.fn(),
  runWorkflowScheduleOnce: vi.fn(),
  setWorkflowSchedulePaused: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope: <T extends (...args: never[]) => unknown>(handler: T) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));

vi.mock("@/lib/security/execution-scope", () => ({
  executionScopeFromSecurityContext: mocks.executionScopeFromSecurityContext,
}));

vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext: () => ({
    canonicalActorId: "actor:route-test",
    exactActorId: "actor:route-test",
  }),
}));

vi.mock("@/lib/skills/store", () => ({
  listCustomAgentsForRequest: mocks.listCustomAgentsForRequest,
}));

vi.mock("@/lib/workflows/triggers", () => {
  class WorkflowScheduleControlError extends Error {
    constructor(message: string, readonly code: string) {
      super(message);
    }
  }
  return {
    DEFAULT_READ_ONLY_SCHEDULE_BUDGET: {
      modelTurns: 4,
      tokens: 24_000,
      costMicrousd: 600_000,
      wallTimeMs: 180_000,
      toolCalls: 20,
      browserActions: 0,
      agents: 0,
      fanOut: 0,
      retries: 1,
      replans: 1,
    },
    WorkflowScheduleControlError,
    createReviewedWorkflowSchedule: mocks.createReviewedWorkflowSchedule,
    createWorkflowTrigger: mocks.createWorkflowTrigger,
    getWorkflowTrigger: mocks.getWorkflowTrigger,
    getWorkflowTriggerStats: mocks.getWorkflowTriggerStats,
    listSchedulableWorkflowProcedures: mocks.listSchedulableWorkflowProcedures,
    listWorkflowScheduleOccurrenceReceipts: mocks.listWorkflowScheduleOccurrenceReceipts,
    listWorkflowScheduleOccurrences: mocks.listWorkflowScheduleOccurrences,
    listWorkflowTriggerEvents: mocks.listWorkflowTriggerEvents,
    listWorkflowTriggers: mocks.listWorkflowTriggers,
    previewWorkflowSchedule: mocks.previewWorkflowSchedule,
    runWorkflowScheduleOnce: mocks.runWorkflowScheduleOnce,
    setWorkflowSchedulePaused: mocks.setWorkflowSchedulePaused,
  };
});

import { GET, POST } from "@/app/api/triggers/route";
import { POST as POSTControl } from "@/app/api/triggers/[id]/route";

const context = {
  tenantId: "tenant:route-test",
  actorId: "actor:route-test",
  role: "admin",
  source: "session",
};
const executionScope = {
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "user",
  executingPrincipalId: context.actorId,
  correlationId: "schedule-route-test",
  purpose: "workflow.schedule.review",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(context);
  mocks.executionScopeFromSecurityContext.mockReturnValue(executionScope);
  mocks.listWorkflowTriggers.mockResolvedValue([]);
  mocks.listWorkflowTriggerEvents.mockResolvedValue([]);
  mocks.getWorkflowTriggerStats.mockResolvedValue({ total: 0, active: 0 });
  mocks.listSchedulableWorkflowProcedures.mockResolvedValue([]);
  mocks.listWorkflowScheduleOccurrences.mockResolvedValue([]);
  mocks.listWorkflowScheduleOccurrenceReceipts.mockResolvedValue([]);
  mocks.listCustomAgentsForRequest.mockResolvedValue([]);
  mocks.createReviewedWorkflowSchedule.mockResolvedValue({ id: "schedule:test" });
  mocks.createWorkflowTrigger.mockResolvedValue({ id: "webhook:test" });
  mocks.setWorkflowSchedulePaused.mockResolvedValue({ id: "schedule:test", status: "paused" });
  mocks.runWorkflowScheduleOnce.mockResolvedValue({ id: "occurrence:test" });
});

describe("workflow trigger schedule routes", () => {
  it("scopes trigger-event reads and stats to the authenticated actor", async () => {
    const response = await GET(new Request("http://localhost/api/triggers?limit=12"));

    expect(response.status).toBe(200);
    expect(mocks.listWorkflowTriggerEvents).toHaveBeenCalledWith(12, {
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    expect(mocks.getWorkflowTriggerStats).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
  });

  it("requires an explicit stable Idempotency-Key for schedule creation", async () => {
    const missing = await POST(jsonRequest(scheduleBody()));
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ code: "idempotency_key_required" });
    expect(mocks.createReviewedWorkflowSchedule).not.toHaveBeenCalled();

    const accepted = await POST(jsonRequest(scheduleBody(), "routine-create-001"));
    expect(accepted.status).toBe(201);
    expect(mocks.createReviewedWorkflowSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId: context.actorId,
        idempotencyKey: "routine-create-001",
        executionScope,
      }),
    );
  });

  it("forwards the exact reviewed mutation acknowledgement", async () => {
    const reviewDigest = "a".repeat(64);
    const response = await POST(jsonRequest({
      ...scheduleBody(),
      authorityMode: "reviewed_mutation",
      reviewedMutationBindingsSha256: reviewDigest,
      mutationAcknowledged: true,
    }, "routine-reviewed-mutation-001"));

    expect(response.status).toBe(201);
    expect(mocks.createReviewedWorkflowSchedule).toHaveBeenCalledWith(
      expect.objectContaining({
        authorityMode: "reviewed_mutation",
        reviewedMutationBindingsSha256: reviewDigest,
        mutationAcknowledged: true,
        idempotencyKey: "routine-reviewed-mutation-001",
      }),
    );
  });

  it("preserves legacy webhook creation without a caller idempotency key", async () => {
    const response = await POST(jsonRequest({
      name: "Inbound webhook",
      authMode: "hmac_sha256",
      secretEnvVar: "OMNIAGENT_TRIGGER_TEST",
    }));

    expect(response.status).toBe(201);
    expect(mocks.createWorkflowTrigger).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      idempotencyKey: expect.stringMatching(/^workflow-trigger:/),
    }));
  });

  it("requires the same explicit key for pause, resume, and run-once controls", async () => {
    const routeContext = { params: Promise.resolve({ id: "schedule:test" }) };
    const missing = await POSTControl(jsonRequest({ action: "pause" }), routeContext);
    expect(missing.status).toBe(428);
    expect(mocks.setWorkflowSchedulePaused).not.toHaveBeenCalled();

    const accepted = await POSTControl(
      jsonRequest({ action: "run_once" }, "routine-run-once-001"),
      routeContext,
    );
    expect(accepted.status).toBe(202);
    expect(mocks.runWorkflowScheduleOnce).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      actorId: context.actorId,
      triggerId: "schedule:test",
      executionScope,
    }));
    expect(mocks.executionScopeFromSecurityContext).toHaveBeenLastCalledWith(
      context,
      expect.objectContaining({
        correlationId: "workflow-schedule-control:routine-run-once-001",
      }),
    );
  });
});

function scheduleBody() {
  return {
    triggerKind: "schedule",
    name: "Morning review",
    procedureId: "procedure:morning-review",
    agentId: "atlas",
    timezone: "Asia/Kolkata",
    rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
    startsAt: "2026-09-23T09:00:00+05:30",
  };
}

function jsonRequest(body: unknown, idempotencyKey?: string) {
  return new Request("http://localhost/api/triggers", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
  });
}
