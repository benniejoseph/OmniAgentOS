import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listEvaluationFailureFeedback: vi.fn(),
  reviewHarnessRuleProposal: vi.fn(),
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
  listEvaluationFailureFeedback: mocks.listEvaluationFailureFeedback,
  reviewHarnessRuleProposal: mocks.reviewHarnessRuleProposal,
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
      metadata: { decision: "approved", automaticApplication: false },
    }));
  });
});
