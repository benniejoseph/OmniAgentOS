import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  authorizeRequest: vi.fn(),
  listStreamEvents: vi.fn(),
  runPhaseFiveGate: vi.fn(),
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

vi.mock("@/lib/evals2/phase-five", () => ({
  PHASE_FIVE_GATE_SUITE_ID: "p5-production-phase-gate-v1",
  runPhaseFiveGate: mocks.runPhaseFiveGate,
}));

import { POST } from "@/app/api/evaluations/phase-five/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
  mocks.runPhaseFiveGate.mockResolvedValue({
    report: {
      schemaVersion: 1,
      suiteId: "p5-production-phase-gate-v1",
      suiteSha256: "a".repeat(64),
      gateCount: 6,
      passedGateCount: 6,
      failedGateIds: [],
      ontologyEntityTypeCount: 17,
      ontologyRelationTypeCount: 13,
      entityResolutionCaseCount: 27,
      entityResolutionPassedCaseCount: 27,
      entityResolutionPrecisionBasisPoints: 10_000,
      entityResolutionScopeLeakCount: 0,
      entityResolutionFalseAutoMergeCount: 0,
      temporalCaseCount: 8,
      temporalPassedCaseCount: 8,
      orphanEvidenceCount: 0,
      projectionComparisonCount: 4,
      rebuildParityBasisPoints: 10_000,
      deletionPropagationPassed: true,
      relationshipPathCount: 2,
      multiHopPathCount: 1,
      relationshipHopCount: 3,
      evidencedRelationshipHopCount: 3,
      unevidencedRelationshipHopCount: 0,
      crossScopeRejectionCount: 1,
      crossScopeLeakCount: 0,
      storagePrimaryAdapterId: "postgres-temporal-graph:1",
      storageShadowState: "matched",
      storageParityBasisPoints: 10_000,
      storageDisposition: "collect_more_telemetry",
      graphDatabasePromotionReady: false,
      effectCount: 0,
      passed: true,
    },
    observations: [],
  });
  mocks.appendScopedDomainEvent.mockResolvedValue(undefined);
  mocks.listStreamEvents.mockResolvedValue([]);
});

describe("Phase 5 evaluation route", () => {
  it("runs the synthetic graph gate and persists a content-free receipt", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/phase-five",
      {
        method: "POST",
        headers: { "idempotency-key": "p5-phase-a" },
      },
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toMatchObject({
      report: {
        passed: true,
        passedGateCount: 6,
        rebuildParityBasisPoints: 10_000,
        crossScopeLeakCount: 0,
        effectCount: 0,
      },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: expect.objectContaining({
        suite: "p5-production-phase-gate-v1",
        effectCount: 0,
      }),
    }));
    expect(mocks.runPhaseFiveGate).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p5-phase-a",
      entityResolutionSuite: expect.objectContaining({
        suiteId: "p5.2-entity-resolution-production-like-v1",
      }),
    }));
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^evaluation-p5-phase:[a-f0-9]{64}$/),
        type: "evaluation.phase_five.completed",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          purpose: "evaluation.p5.phase_gate",
        }),
        payload: expect.objectContaining({
          passed: true,
          safetyMode: "synthetic_read_only",
          crossScopeLeakCount: 0,
          effectCount: 0,
        }),
      }),
    );
  });

  it("returns the immutable receipt for a repeated key", async () => {
    mocks.listStreamEvents.mockResolvedValue([{
      type: "evaluation.phase_five.completed",
      payload: { passed: true, suiteId: "p5-production-phase-gate-v1" },
    }]);
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/phase-five",
      {
        method: "POST",
        headers: { "idempotency-key": "p5-phase-a" },
      },
    ));

    await expect(response.json()).resolves.toMatchObject({
      replayed: true,
      report: { passed: true },
      observations: [],
    });
    expect(mocks.runPhaseFiveGate).not.toHaveBeenCalled();
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });

  it("rejects malformed idempotency keys before authorization", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/phase-five",
      {
        method: "POST",
        headers: { "idempotency-key": "invalid key" },
      },
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });
});
