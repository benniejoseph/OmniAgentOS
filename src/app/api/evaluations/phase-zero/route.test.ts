import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  authorizeRequest: vi.fn(),
  getCurrentTenantCapabilityRollout: vi.fn(),
  listStreamEvents: vi.fn(),
  runPhaseZeroGate: vi.fn(),
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

vi.mock("@/lib/rollouts/tenant-capability-rollouts", () => ({
  getCurrentTenantCapabilityRollout: mocks.getCurrentTenantCapabilityRollout,
}));

vi.mock("@/lib/evals2/phase-zero", () => ({
  runPhaseZeroGate: mocks.runPhaseZeroGate,
}));

import { POST } from "@/app/api/evaluations/phase-zero/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
  mocks.getCurrentTenantCapabilityRollout.mockResolvedValue({
    capabilityId: "agent_loop_v2",
    rolloutGeneration: 7,
    status: "active",
  });
  mocks.runPhaseZeroGate.mockReturnValue({
    report: {
      schemaVersion: 1,
      suiteId: "p0-production-phase-gate-v1",
      suiteSha256: "a".repeat(64),
      gateCount: 6,
      passedGateCount: 6,
      failedGateIds: [],
      scopeBoundaryCount: 10,
      scopedBoundaryCount: 10,
      runContractCount: 6,
      currentRolloutGeneration: 7,
      currentRolloutStatus: "active",
      canonicalStatusCount: 9,
      observedCanonicalStatusCount: 9,
      baselineCaseCount: 16,
      baselinePassedCaseCount: 16,
      baselineScoreBasisPoints: 10_000,
      acceptedArchitectureDecisionCount: 7,
      unresolvedArchitectureDecisionCount: 0,
      effectCount: 0,
      passed: true,
    },
    observations: [],
  });
  mocks.appendScopedDomainEvent.mockResolvedValue(undefined);
  mocks.listStreamEvents.mockResolvedValue([]);
});

describe("Phase 0 evaluation route", () => {
  it("runs the read-only gate and persists a content-free receipt", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/phase-zero",
      {
        method: "POST",
        headers: { "idempotency-key": "p0-phase-a" },
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      report: { passed: true, passedGateCount: 6, effectCount: 0 },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: expect.objectContaining({ effectCount: 0 }),
    }));
    expect(mocks.getCurrentTenantCapabilityRollout).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      capabilityId: "agent_loop_v2",
    });
    expect(mocks.runPhaseZeroGate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p0-phase-a",
      currentRollout: expect.objectContaining({ rolloutGeneration: 7 }),
    }));
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^evaluation-p0-phase:[a-f0-9]{64}$/),
        type: "evaluation.phase_zero.completed",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          purpose: "evaluation.p0.phase_gate",
        }),
        payload: expect.objectContaining({
          passed: true,
          safetyMode: "synthetic_read_only",
          effectCount: 0,
        }),
      }),
    );
  });

  it("returns the immutable receipt for a repeated key", async () => {
    mocks.listStreamEvents.mockResolvedValue([{
      type: "evaluation.phase_zero.completed",
      payload: { passed: true, suiteId: "p0-production-phase-gate-v1" },
    }]);
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/phase-zero",
      {
        method: "POST",
        headers: { "idempotency-key": "p0-phase-a" },
      },
    ));

    await expect(response.json()).resolves.toMatchObject({
      replayed: true,
      report: { passed: true },
      observations: [],
    });
    expect(mocks.getCurrentTenantCapabilityRollout).not.toHaveBeenCalled();
    expect(mocks.runPhaseZeroGate).not.toHaveBeenCalled();
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});

