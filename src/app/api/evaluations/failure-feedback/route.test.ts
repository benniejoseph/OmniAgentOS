import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  enqueueEvaluationJob: vi.fn(),
  evaluateEvaluationGovernance: vi.fn(),
  getEvaluationFailureCluster: vi.fn(),
  listEvaluationFailureFeedback: vi.fn(),
  projectOperationJobStatus: vi.fn((job) => job),
  reviewHarnessRuleProposal: vi.fn(),
  evalCase: {
    id: "system.readiness",
    name: "System readiness",
    description: "Checks readiness.",
    type: "system",
    input: {},
    expected: { ready: true },
    governance: {
      safetyMode: "read_only",
      riskLevel: 0,
      writesToDatabase: false,
      cleanup: "none",
      production: {
        allowedByDefault: true,
        requiresAdmin: false,
        requiresMutationApproval: false,
      },
      notes: [],
    },
  },
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
vi.mock("@/lib/evaluations/failure-feedback-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/evaluations/failure-feedback-store")>()),
  getEvaluationFailureCluster: mocks.getEvaluationFailureCluster,
  listEvaluationFailureFeedback: mocks.listEvaluationFailureFeedback,
  reviewHarnessRuleProposal: mocks.reviewHarnessRuleProposal,
}));
vi.mock("@/lib/evaluations/runner", () => ({
  defaultEvalCases: [mocks.evalCase],
  evaluateEvaluationGovernance: mocks.evaluateEvaluationGovernance,
}));
vi.mock("@/lib/operations/background-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/background-jobs")>()),
  enqueueEvaluationJob: mocks.enqueueEvaluationJob,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  projectOperationJobStatus: mocks.projectOperationJobStatus,
}));

import { GET, POST } from "@/app/api/evaluations/failure-feedback/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "operator-a",
    role: "operator",
    source: "session",
  });
  mocks.listEvaluationFailureFeedback.mockResolvedValue({
    clusters: [],
    proposals: [],
    summary: { activeRecurring: 0, proposedRules: 0 },
  });
  mocks.reviewHarnessRuleProposal.mockResolvedValue({
    id: "proposal-a",
    status: "approved",
    proposal: { automaticApplication: false },
  });
  mocks.evaluateEvaluationGovernance.mockReturnValue({
    allowed: true,
    violations: [],
  });
  mocks.enqueueEvaluationJob.mockResolvedValue({
    id: "job-a",
    status: "queued",
  });
});

describe("evaluation failure feedback route", () => {
  it("returns tenant-scoped feedback without caching", async () => {
    const response = await GET(new Request(
      "http://asael.test/api/evaluations/failure-feedback?limit=25",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listEvaluationFailureFeedback).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 25,
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "evaluation_failure_feedback",
    }));
  });

  it("records review evidence without applying the proposed change", async () => {
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/failure-feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "review",
          proposalId: "proposal-a",
          decision: "approved",
          reason: "Reviewed against its minimized replay evidence.",
        }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ applied: false });
    expect(mocks.reviewHarnessRuleProposal).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "operator-a",
      proposalId: "proposal-a",
      decision: "approved",
      reason: "Reviewed against its minimized replay evidence.",
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "run.evaluation",
      resourceType: "harness_rule_proposal",
      metadata: {
        feedbackAction: "review",
        decision: "approved",
        automaticApplication: false,
      },
    }));
  });

  it("queues only the digest-matched minimized case without inherited mutation authority", async () => {
    const { canonicalJsonSha256 } = await import("@/lib/tools/effect-receipt");
    mocks.getEvaluationFailureCluster.mockResolvedValue({
      id: "cluster-a",
      replayCase: {
        schemaVersion: 1,
        caseId: mocks.evalCase.id,
        caseDefinitionSha256: canonicalJsonSha256(mocks.evalCase),
      },
    });
    const response = await POST(new Request(
      "http://asael.test/api/evaluations/failure-feedback",
      {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "replay-a" },
        body: JSON.stringify({ action: "replay", clusterId: "cluster-a" }),
      },
    ));
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(body).toMatchObject({
      job: { id: "job-a", status: "queued" },
      mutationAuthorityInherited: false,
    });
    expect(mocks.enqueueEvaluationJob).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId: "operator-a",
      idempotencyKey: "replay-a",
      request: {
        suite: "failure-replay:cluster-a",
        caseIds: ["system.readiness"],
      },
    });
  });
});
