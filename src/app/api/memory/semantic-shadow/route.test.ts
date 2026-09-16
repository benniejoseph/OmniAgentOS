import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  binding: vi.fn(),
  workspace: vi.fn(),
  save: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext: mocks.binding,
}));
vi.mock("@/lib/evals2/semantic-memory-shadow-review", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/evals2/semantic-memory-shadow-review")
  >()),
  getSemanticMemoryShadowReviewWorkspace: mocks.workspace,
  saveSemanticMemoryShadowReview: mocks.save,
}));

import { GET, POST } from "@/app/api/memory/semantic-shadow/route";

const context = {
  tenantId: "tenant-review-route",
  actorId: "actor:review-route",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "user-review-route",
    email: "owner@example.test",
    sessionId: "session-review-route",
    tenantName: "Review tenant",
  },
};
const candidate = {
  id: `semantic_episode_enrichment_${"a".repeat(48)}`,
  reviewSourceSha256: "b".repeat(64),
  startsAt: "2026-09-16T07:00:00.000Z",
  endsAt: "2026-09-16T08:00:00.000Z",
  model: { provider: "openai", model: "settings-memory-model" },
  metrics: {
    sourceCharacterCount: 500,
    outputCharacterCount: 120,
    quoteBindingCount: 2,
    validQuoteBindingCount: 2,
    semanticItemCount: 2,
    generationLatencyMs: 1_500,
    deterministicReplayMatch: true,
  },
  sourceTurns: [{
    id: "turn-route-1",
    role: "user" as const,
    content: "Private route evidence",
    createdAt: "2026-09-16T07:00:00.000Z",
  }],
  deterministicSummary: "Private baseline",
  semanticItems: [{
    id: "semantic_summary",
    kind: "summary" as const,
    text: "Private semantic summary",
    confidenceBasisPoints: 9_000,
    evidence: [{
      turnId: "turn-route-1",
      quote: "Private route evidence",
      startOffset: 0,
      endOffsetExclusive: 22,
      valid: true,
    }],
  }, {
    id: `semantic_episode_statement_${"c".repeat(48)}`,
    kind: "decision" as const,
    text: "Private decision",
    confidenceBasisPoints: 9_000,
    evidence: [{
      turnId: "turn-route-1",
      quote: "Private route evidence",
      startOffset: 0,
      endOffsetExclusive: 22,
      valid: true,
    }],
  }],
  reviewable: true,
  scope: {
    ownerActorId: context.actorId,
    threadId: "thread-route",
    episodeSummaryId: "episode-route",
    projectId: "project-route",
    sourceSha256: "d".repeat(64),
    enrichmentSha256: "e".repeat(64),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(context);
  mocks.binding.mockReturnValue({
    canonicalActorId: context.actorId,
    readableOwnerActorIds: [context.actorId, "owner@example.test"],
  });
  mocks.workspace.mockResolvedValue({
    candidates: [candidate],
    observation: null,
    report: null,
  });
  mocks.save.mockResolvedValue({
    reviewSourceSha256: candidate.reviewSourceSha256,
    reviewedAt: "2026-09-16T08:30:00.000Z",
  });
});

describe("semantic shadow review API", () => {
  it("keeps source detail lazy and never projects private scope coordinates", async () => {
    const summaryResponse = await GET(new Request(
      "http://localhost/api/memory/semantic-shadow?limit=24",
    ));
    const summary = await summaryResponse.json();

    expect(summaryResponse.status).toBe(200);
    expect(summaryResponse.headers.get("cache-control")).toBe("private, no-store");
    expect(summary.candidates[0]).not.toHaveProperty("scope");
    expect(summary.candidates[0]).not.toHaveProperty("sourceTurns");
    expect(summary.candidates[0]).not.toHaveProperty("semanticItems");

    const detailResponse = await GET(new Request(
      `http://localhost/api/memory/semantic-shadow?limit=100&id=${candidate.id}`,
    ));
    const detail = await detailResponse.json();
    expect(detail.candidates[0]).not.toHaveProperty("scope");
    expect(detail.candidates[0].sourceTurns[0].content)
      .toBe("Private route evidence");
    expect(detail.candidates[0].semanticItems).toHaveLength(2);
  });

  it("binds a valid human decision to the exact owner, project, and episode", async () => {
    const response = await POST(reviewRequest(validReview()));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "write.memory",
      resourceId: candidate.id,
    }));
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      actorIds: [context.actorId, "owner@example.test"],
      correlationId: "route-review-key",
      executionScope: expect.objectContaining({
        initiatingActorId: context.actorId,
        executingPrincipalType: "user",
        projectId: "project-route",
        causationId: candidate.id,
        purpose: "conversation.summary.semantic_shadow.review",
      }),
    }));
  });

  it("rejects incomplete evidence decisions before authorization or persistence", async () => {
    const review = validReview();
    review.itemDecisions = [];
    const response = await POST(reviewRequest(review));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not expose the private workspace to an unauthorized request", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("not signed in"));
    const response = await GET(new Request(
      "http://localhost/api/memory/semantic-shadow",
    ));

    expect(response.status).toBe(403);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});

function validReview() {
  return {
    enrichmentId: candidate.id,
    reviewSourceSha256: candidate.reviewSourceSha256,
    dimension: "decision",
    itemDecisions: candidate.semanticItems.map(({ id }) => ({
      itemId: id,
      decision: "supported",
    })),
    importantFactCount: 2,
    baselineImportantFactHitCount: 1,
    semanticImportantFactHitCount: 2,
    baselineFirstRelevantRank: null,
    semanticFirstRelevantRank: null,
    compressionJudgment: "good",
    scopeLeakCount: 0,
    humanReviewed: true,
  };
}

function reviewRequest(body: unknown) {
  return new Request("http://localhost/api/memory/semantic-shadow", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-idempotency-key": "route-review-key",
    },
    body: JSON.stringify(body),
  });
}
