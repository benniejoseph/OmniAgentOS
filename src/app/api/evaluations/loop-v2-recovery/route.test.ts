import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  authorizeRequest: vi.fn(),
  listStreamEvents: vi.fn(),
  runLoopV2RecoveryEvaluation: vi.fn(),
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

vi.mock("@/lib/evals2/loop-v2-recovery", () => ({
  runLoopV2RecoveryEvaluation: mocks.runLoopV2RecoveryEvaluation,
}));

import { POST } from "@/app/api/evaluations/loop-v2-recovery/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
  mocks.runLoopV2RecoveryEvaluation.mockResolvedValue({
    report: {
      schemaVersion: 1,
      suiteId: "p6.1-loop-v2-interruption-recovery-v1",
      suiteSha256: "a".repeat(64),
      caseCount: 15,
      passedCaseCount: 15,
      recoveryEligible: 7,
      recovered: 7,
      recoveryRateBasisPoints: 10_000,
      duplicateEffectCount: 0,
      falseSuccessCount: 0,
      unfencedWriteCount: 0,
      genericFailureMutationCount: 0,
      traceIncompleteCount: 0,
      missingFirstProgressCount: 0,
      failedCaseIds: [],
      passed: true,
    },
    observations: [],
  });
  mocks.appendScopedDomainEvent.mockResolvedValue(undefined);
  mocks.listStreamEvents.mockResolvedValue([]);
});

describe("Loop v2 recovery evaluation route", () => {
  it("runs the fixed synthetic suite and persists a content-free receipt", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/loop-v2-recovery",
      {
        method: "POST",
        headers: { "idempotency-key": "p61-recovery-a" },
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      report: {
        passed: true,
        caseCount: 15,
        recoveryRateBasisPoints: 10_000,
        duplicateEffectCount: 0,
        falseSuccessCount: 0,
      },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: expect.objectContaining({ effectCount: 0 }),
    }));
    expect(mocks.runLoopV2RecoveryEvaluation).toHaveBeenCalledWith({
      suite: expect.objectContaining({
        suiteId: "p6.1-loop-v2-interruption-recovery-v1",
      }),
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p61-recovery-a",
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^evaluation-p61-recovery:[a-f0-9]{64}$/),
        type: "evaluation.loop_v2_recovery.completed",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          purpose: "evaluation.p6_1.loop_v2_recovery",
        }),
        payload: expect.objectContaining({
          passed: true,
          recoveryRateBasisPoints: 10_000,
          duplicateEffectCount: 0,
          falseSuccessCount: 0,
          safetyMode: "synthetic",
          governedToolIds: ["runs.list"],
          effectCount: 0,
        }),
      }),
    );
  });

  it("replays the immutable receipt for the same evaluation key", async () => {
    mocks.listStreamEvents.mockResolvedValue([{
      type: "evaluation.loop_v2_recovery.completed",
      payload: { passed: true, suiteId: "p6.1-loop-v2-interruption-recovery-v1" },
    }]);
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/loop-v2-recovery",
      {
        method: "POST",
        headers: { "idempotency-key": "p61-recovery-a" },
      },
    ));

    await expect(response.json()).resolves.toMatchObject({
      replayed: true,
      report: { passed: true },
      observations: [],
    });
    expect(mocks.runLoopV2RecoveryEvaluation).not.toHaveBeenCalled();
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});
