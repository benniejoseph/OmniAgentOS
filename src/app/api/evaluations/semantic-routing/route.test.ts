import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(),
  authorizeRequest: vi.fn(),
  listStreamEvents: vi.fn(),
  runSemanticRoutingBenchmark: vi.fn(),
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

vi.mock("@/lib/evals2/semantic-routing-runtime", () => ({
  runSemanticRoutingBenchmark: mocks.runSemanticRoutingBenchmark,
}));

import { POST } from "@/app/api/evaluations/semantic-routing/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "actor-a",
    role: "admin",
    source: "session",
  });
  mocks.runSemanticRoutingBenchmark.mockResolvedValue({
    report: {
      schemaVersion: 1,
      suiteId: "p6.2-semantic-routing-v1",
      caseCount: 24,
      routeAccuracy: 1,
      requiredToolRecall: 1,
      modelCoverage: 1,
      unexpectedClarificationCount: 0,
      routeFailures: [],
      missingToolBindings: [],
      fallbackCases: [],
      passed: true,
    },
    observations: [],
  });
  mocks.appendScopedDomainEvent.mockResolvedValue(undefined);
  mocks.listStreamEvents.mockResolvedValue([]);
});

describe("semantic routing evaluation route", () => {
  it("runs the fixed synthetic suite and persists its receipt", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/semantic-routing",
      {
        method: "POST",
        headers: { "idempotency-key": "p62-evaluation-a" },
      },
    ));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      report: { passed: true, caseCount: 24 },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.evaluation",
      resourceType: "evaluation",
    }));
    expect(mocks.runSemanticRoutingBenchmark).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        actorId: "actor-a",
        correlationId: "p62-evaluation-a",
      }),
    );
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.stringMatching(/^evaluation-p62:[a-f0-9]{64}$/),
        type: "evaluation.semantic_routing.completed",
        executionScope: expect.objectContaining({
          tenantId: "tenant-a",
          initiatingActorId: "actor-a",
          purpose: "evaluation.p6_2.semantic_routing",
        }),
        payload: expect.objectContaining({
          passed: true,
          safetyMode: "synthetic",
          selectedToolIds: [],
          effectCount: 0,
        }),
      }),
    );
  });
});
