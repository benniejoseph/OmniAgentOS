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
  saveSemanticMemoryShadowRankProbe: mocks.save,
}));

import { POST } from "@/app/api/memory/semantic-shadow/rank-probe/route";

const context = {
  tenantId: "tenant-rank-route",
  actorId: "actor:rank-route",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "user-rank-route",
    email: "owner@example.test",
    sessionId: "session-rank-route",
    tenantName: "Rank tenant",
  },
};
const candidate = {
  id: `semantic_episode_enrichment_${"a".repeat(48)}`,
  reviewSourceSha256: "b".repeat(64),
  reviewable: true,
  scope: {
    ownerActorId: context.actorId,
    threadId: "thread-rank-route",
    episodeSummaryId: "episode-rank-route",
    projectId: "project-rank-route",
    sourceSha256: "c".repeat(64),
    enrichmentSha256: "d".repeat(64),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorize.mockResolvedValue(context);
  mocks.binding.mockReturnValue({
    canonicalActorId: context.actorId,
    readableOwnerActorIds: [context.actorId, "owner@example.test"],
  });
  mocks.workspace.mockResolvedValue({ candidates: [candidate] });
  mocks.save.mockResolvedValue({
    enrichmentId: candidate.id,
    baselineFirstRelevantRank: 4,
    semanticFirstRelevantRank: 1,
  });
});

describe("semantic shadow retrieval-rank API", () => {
  it("binds the local probe to the exact actor and episode scope", async () => {
    const response = await POST(probeRequest({
      enrichmentId: candidate.id,
      reviewSourceSha256: candidate.reviewSourceSha256,
      query: "Which Apollo release date was approved?",
      humanConfirmedTarget: true,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "write.memory",
      resourceId: candidate.id,
      metadata: { operation: "semantic_shadow_rank_probe" },
    }));
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: context.tenantId,
      actorIds: [context.actorId, "owner@example.test"],
      correlationId: "route-rank-key",
      executionScope: expect.objectContaining({
        initiatingActorId: context.actorId,
        projectId: "project-rank-route",
        causationId: candidate.id,
        purpose: "conversation.summary.semantic_shadow.rank_probe",
      }),
    }));
  });

  it("rejects an unconfirmed target before authorization", async () => {
    const response = await POST(probeRequest({
      enrichmentId: candidate.id,
      reviewSourceSha256: candidate.reviewSourceSha256,
      query: "Which Apollo release date was approved?",
      humanConfirmedTarget: false,
    }));

    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("does not disclose candidate existence without authorization", async () => {
    mocks.authorize.mockRejectedValueOnce(new Error("not signed in"));
    const response = await POST(probeRequest({
      enrichmentId: candidate.id,
      reviewSourceSha256: candidate.reviewSourceSha256,
      query: "Which Apollo release date was approved?",
      humanConfirmedTarget: true,
    }));

    expect(response.status).toBe(403);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});

function probeRequest(body: unknown) {
  return new Request(
    "http://localhost/api/memory/semantic-shadow/rank-probe",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-idempotency-key": "route-rank-key",
      },
      body: JSON.stringify(body),
    },
  );
}
