import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  authorizeRequest: vi.fn(),
  listStreamEvents: vi.fn(),
  runPhaseOneGate: vi.fn(),
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

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
  listStreamEvents: mocks.listStreamEvents,
}));

vi.mock("@/lib/evals2/phase-one", () => ({
  PHASE_ONE_GATE_SUITE_ID: "p1-production-phase-gate-v1",
  runPhaseOneGate: mocks.runPhaseOneGate,
}));

import { POST } from "@/app/api/evaluations/phase-one/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
  mocks.runPhaseOneGate.mockResolvedValue({
    report: {
      schemaVersion: 1,
      suiteId: "p1-production-phase-gate-v1",
      suiteSha256: "a".repeat(64),
      gateCount: 7,
      passedGateCount: 7,
      failedGateIds: [],
      mutationDomainCount: 11,
      eventedMutationDomainCount: 10,
      noMutationSurfaceCount: 1,
      mutationEventTypeCount: 75,
      projectionCount: 10,
      matchedProjectionCount: 10,
      projectionReplayBasisPoints: 10_000,
      outcomeCaseCount: 15,
      outcomePassedCaseCount: 15,
      negativeOutcomeCaseCount: 14,
      falseSuccessCount: 0,
      effectReceiptContractCount: 1,
      claimEvidenceMapCount: 1,
      materialClaimCount: 1,
      unsupportedClaimCount: 1,
      checkpointContractCount: 1,
      forkLineageContractCount: 1,
      effectCount: 0,
      passed: true,
    },
    observations: [],
  });
  mocks.appendScopedDomainEvent.mockResolvedValue(undefined);
  mocks.listStreamEvents.mockResolvedValue([]);
});

describe("Phase 1 evaluation route", () => {
  it("runs the read-only gate and persists a content-free receipt", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/phase-one",
      {
        method: "POST",
        headers: { "idempotency-key": "p1-phase-a" },
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      report: {
        passed: true,
        passedGateCount: 7,
        projectionReplayBasisPoints: 10_000,
        falseSuccessCount: 0,
        effectCount: 0,
      },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: expect.objectContaining({
        suite: "p1-production-phase-gate-v1",
        effectCount: 0,
      }),
    }));
    expect(mocks.runPhaseOneGate).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p1-phase-a",
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^evaluation-p1-phase:[a-f0-9]{64}$/),
        type: "evaluation.phase_one.completed",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          purpose: "evaluation.p1.phase_gate",
        }),
        payload: expect.objectContaining({
          passed: true,
          passedGateCount: 7,
          projectionReplayBasisPoints: 10_000,
          falseSuccessCount: 0,
          safetyMode: "synthetic_read_only",
          effectCount: 0,
        }),
      }),
    );
  });

  it("returns the immutable receipt for a repeated key", async () => {
    mocks.listStreamEvents.mockResolvedValue([{
      type: "evaluation.phase_one.completed",
      payload: { passed: true, suiteId: "p1-production-phase-gate-v1" },
    }]);
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/phase-one",
      {
        method: "POST",
        headers: { "idempotency-key": "p1-phase-a" },
      },
    ));

    await expect(response.json()).resolves.toMatchObject({
      replayed: true,
      report: { passed: true },
      observations: [],
    });
    expect(mocks.runPhaseOneGate).not.toHaveBeenCalled();
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});
