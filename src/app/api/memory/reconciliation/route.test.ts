import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MemoryReconciliationConflictError extends Error {}
  return {
    MemoryReconciliationConflictError,
    authorize: vi.fn(),
    list: vi.fn(),
    resolve: vi.fn(),
    indexPrivate: vi.fn(),
    queueGraph: vi.fn(),
    projectEntities: vi.fn(),
    retireEntities: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: (error: unknown) => Response.json({ error }, { status: 403 }),
}));

vi.mock("@/lib/memory/store", () => ({
  listMemoryReconciliationReviews: mocks.list,
  resolveMemoryReconciliationReview: mocks.resolve,
  MemoryReconciliationConflictError: mocks.MemoryReconciliationConflictError,
}));

vi.mock("@/lib/memory/graph", () => ({
  indexUserPrivateMemoryGraphRecords: mocks.indexPrivate,
  queueMemoryGraphRebuild: mocks.queueGraph,
}));

vi.mock("@/lib/entities/extraction", () => ({
  projectExplicitMemoryEntities: mocks.projectEntities,
}));

vi.mock("@/lib/entities/store", () => ({
  retireEntityMemoryLineage: mocks.retireEntities,
}));

import { GET, PATCH } from "@/app/api/memory/reconciliation/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};

const candidate = {
  id: "memory-new",
  tenantId: "tenant-a",
  type: "fact" as const,
  title: "New claim",
  content: "Thursday",
  tags: [],
  scope: "user" as const,
  source: "correction:owner",
  importance: 0.7,
  confidence: 0.9,
  claimStatus: "active" as const,
  assertedBy: "user" as const,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:01:00.000Z",
  embedding: [0.1, 0.2],
};

const existing = {
  ...candidate,
  id: "memory-old",
  title: "Old claim",
  content: "Tuesday",
  claimStatus: "contradicted" as const,
};

const resolvedReview = {
  id: "review-a",
  tenantId: "tenant-a",
  ownerActorId: "actor:owner",
  resolvedBy: "actor:owner",
  kind: "contradiction" as const,
  status: "resolved" as const,
  decision: "confirm_candidate" as const,
  detectionReason: "explicit_contradiction" as const,
  candidate,
  existing,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:01:00.000Z",
  resolvedAt: "2026-09-06T00:01:00.000Z",
};

describe("memory reconciliation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(context);
    mocks.list.mockResolvedValueOnce([]).mockResolvedValueOnce([resolvedReview]);
    mocks.resolve.mockResolvedValue(resolvedReview);
  });

  it("merges the canonical private inbox without exposing actor IDs or embeddings", async () => {
    const response = await GET(new Request(
      "http://localhost/api/memory/reconciliation?status=all",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.list).toHaveBeenCalledTimes(2);
    const payload = await response.json();
    expect(payload.reviews).toHaveLength(1);
    expect(payload.reviews[0]).not.toHaveProperty("ownerActorId");
    expect(payload.reviews[0]).not.toHaveProperty("resolvedBy");
    expect(payload.reviews[0].candidate).not.toHaveProperty("embedding");
    expect(payload.reviews[0].existing).not.toHaveProperty("embedding");
  });

  it("resolves under the canonical private scope and updates projections", async () => {
    const response = await PATCH(new Request(
      "http://localhost/api/memory/reconciliation",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewId: "review-a",
          decision: "confirm_candidate",
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledWith(
      "review-a",
      "confirm_candidate",
      expect.objectContaining({
        accessScope: expect.objectContaining({
          purposeId: "memory.correct.v1",
        }),
      }),
    );
    expect(mocks.indexPrivate).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "memory-new" })],
      "memory.reconciliation.resolve",
      expect.any(Object),
    );
    expect(mocks.projectEntities).toHaveBeenCalled();
    expect(mocks.retireEntities).toHaveBeenCalledWith(expect.objectContaining({
      memoryIds: ["memory-old"],
    }));
  });

  it("falls back to the legacy lane when the private lane does not own the review", async () => {
    mocks.resolve.mockReset();
    mocks.resolve.mockResolvedValueOnce(null).mockResolvedValueOnce(resolvedReview);

    const response = await PATCH(new Request(
      "http://localhost/api/memory/reconciliation",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewId: "review-a",
          decision: "confirm_candidate",
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.resolve).toHaveBeenCalledTimes(2);
    expect(mocks.resolve).toHaveBeenNthCalledWith(
      2,
      "review-a",
      "confirm_candidate",
      expect.not.objectContaining({ accessScope: expect.anything() }),
    );
    expect(mocks.queueGraph).toHaveBeenCalledWith({ tenantId: "tenant-a" });
  });

  it("returns a state conflict instead of overwriting an earlier decision", async () => {
    mocks.resolve.mockRejectedValueOnce(
      new mocks.MemoryReconciliationConflictError("Already resolved."),
    );
    const response = await PATCH(new Request(
      "http://localhost/api/memory/reconciliation",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          reviewId: "review-a",
          decision: "keep_existing",
        }),
      },
    ));

    expect(response.status).toBe(409);
  });
});
