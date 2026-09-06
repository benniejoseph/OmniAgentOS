import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  authorizeRequest: vi.fn(),
  listStreamEvents: vi.fn(),
  runOutcomeContractGate: vi.fn(),
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

vi.mock("@/lib/evals2/outcome-contracts", () => ({
  OUTCOME_CONTRACT_GATE_SUITE_ID: "p1.3-outcome-contracts-v1",
  runOutcomeContractGate: mocks.runOutcomeContractGate,
}));

import { POST } from "@/app/api/evaluations/outcome-contracts/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
  mocks.runOutcomeContractGate.mockReturnValue({
    report: {
      schemaVersion: 1,
      suiteId: "p1.3-outcome-contracts-v1",
      suiteSha256: "a".repeat(64),
      caseCount: 15,
      passedCaseCount: 15,
      negativeCaseCount: 14,
      falseSuccessCount: 0,
      verifiedSuccessCount: 1,
      rejectedTamperCount: 2,
      failedCaseIds: [],
      effectCount: 0,
      passed: true,
    },
    observations: [],
  });
  mocks.appendScopedDomainEvent.mockResolvedValue(undefined);
  mocks.listStreamEvents.mockResolvedValue([]);
});

describe("P1.3 outcome-contract evaluation route", () => {
  it("runs the fixed synthetic suite and records a content-free receipt", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/outcome-contracts",
      {
        method: "POST",
        headers: { "idempotency-key": "p13-outcomes-a" },
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      report: {
        passed: true,
        caseCount: 15,
        falseSuccessCount: 0,
        verifiedSuccessCount: 1,
      },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.evaluation",
      resourceType: "evaluation",
      metadata: expect.objectContaining({
        suite: "p1.3-outcome-contracts-v1",
        effectCount: 0,
      }),
    }));
    expect(mocks.runOutcomeContractGate).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p13-outcomes-a",
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^evaluation-p13-outcomes:[a-f0-9]{64}$/),
        type: "evaluation.outcome_contracts.completed",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          purpose: "evaluation.p1_3.outcome_contracts",
        }),
        payload: expect.objectContaining({
          passed: true,
          caseCount: 15,
          falseSuccessCount: 0,
          verifiedSuccessCount: 1,
          safetyMode: "synthetic_read_only",
          effectCount: 0,
        }),
      }),
    );
  });

  it("replays the immutable receipt for the same evaluation key", async () => {
    mocks.listStreamEvents.mockResolvedValue([{
      type: "evaluation.outcome_contracts.completed",
      payload: { passed: true, suiteId: "p1.3-outcome-contracts-v1" },
    }]);
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/outcome-contracts",
      {
        method: "POST",
        headers: { "idempotency-key": "p13-outcomes-a" },
      },
    ));

    await expect(response.json()).resolves.toMatchObject({
      replayed: true,
      report: { passed: true },
      observations: [],
    });
    expect(mocks.runOutcomeContractGate).not.toHaveBeenCalled();
    expect(mocks.appendScopedDomainEvent).not.toHaveBeenCalled();
  });
});
