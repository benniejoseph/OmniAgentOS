import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { memoryClaimFingerprint } from "@/lib/memory/lifecycle";
import type { MemoryRecord } from "@/lib/memory/types";

const mocks = vi.hoisted(() => {
  class MemoryLifecycleConflictError extends Error {}
  return {
    MemoryLifecycleConflictError,
    authorize: vi.fn(),
    listMemories: vi.fn(),
    getMemory: vi.fn(),
    saveMemory: vi.fn(),
    listReviews: vi.fn(),
    getReview: vi.fn(),
    runMaintenance: vi.fn(),
    resolveReview: vi.fn(),
    indexPrivate: vi.fn(),
    queueGraph: vi.fn(),
    projectEntities: vi.fn(),
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
  listMemories: mocks.listMemories,
  getMemory: mocks.getMemory,
  saveMemory: mocks.saveMemory,
}));

vi.mock("@/lib/memory/maintenance-store", () => ({
  MemoryLifecycleConflictError: mocks.MemoryLifecycleConflictError,
  listMemoryPromotionReviews: mocks.listReviews,
  getMemoryPromotionReview: mocks.getReview,
  runActorMemoryMaintenance: mocks.runMaintenance,
  resolveMemoryPromotionReview: mocks.resolveReview,
}));

vi.mock("@/lib/memory/graph", () => ({
  indexUserPrivateMemoryGraphRecords: mocks.indexPrivate,
  queueMemoryGraphRebuild: mocks.queueGraph,
}));

vi.mock("@/lib/entities/extraction", () => ({
  projectExplicitMemoryEntities: mocks.projectEntities,
}));

import { GET, PATCH, POST } from "@/app/api/memory/maintenance/route";

const authUserId = "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const ownerActorId = `actor:${authUserId}`;
const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const accessBinding = buildUserPrivateMemoryAccessBindingV1({
  tenantId: "tenant-a",
  ownerActorId,
  originPurpose: "api.memory.write",
  accessBoundAt: "2026-09-06T00:00:00.000Z",
});
const canonical: MemoryRecord = {
  id: "memory-a",
  tenantId: "tenant-a",
  type: "episode",
  tier: "episodic",
  tierPolicyVersion: 1,
  formationReason: "verified_effect",
  title: "Deploy service",
  content: "Run the focused gate, then promote the release.",
  tags: ["release"],
  scope: "user",
  source: "effect-receipt:a",
  importance: 0.8,
  confidence: 0.9,
  claimStatus: "active",
  assertedBy: "system",
  evidenceRefs: ["effect:a"],
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
  embedding: [0.1, 0.2],
  accessBinding,
};
const review = {
  id: "review-a",
  tenantId: "tenant-a",
  ownerActorId,
  policyVersion: 1 as const,
  status: "pending" as const,
  sourceMemoryIds: ["memory-a", "memory-b"],
  canonicalMemoryId: "memory-a",
  sourceClaimSha256: memoryClaimFingerprint(canonical),
  targetTier: "procedural" as const,
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};
const emptyReport = {
  policyVersion: 1 as const,
  scanned: 1,
  eligible: 1,
  exactDuplicateGroups: 0,
  autoArchivedDuplicates: 0,
  pinnedDuplicateConflicts: 0,
  promotionReviewsCreated: 0,
  expiredArchived: 0,
  duplicateRateBefore: 0,
  duplicateRateAfter: 0,
  duplicateRateTarget: 0.01 as const,
};

describe("memory maintenance API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue(context);
    mocks.listReviews.mockImplementation(async (options) =>
      options.accessScope ? [review] : []
    );
    mocks.listMemories.mockImplementation(async (options) =>
      options.accessScope ? [canonical] : []
    );
    mocks.runMaintenance.mockResolvedValue({ report: emptyReport, reviews: [] });
    mocks.getReview.mockImplementation(async (_id, options) =>
      options.accessScope ? review : null
    );
    mocks.getMemory.mockResolvedValue(canonical);
    mocks.resolveReview.mockImplementation(async (_id, decision, promotedId) => ({
      ...review,
      status: "resolved",
      decision,
      promotedMemoryId: promotedId,
      resolvedAt: "2026-09-06T00:01:00.000Z",
    }));
    mocks.saveMemory.mockImplementation(async (input) => ({
      ...canonical,
      ...input,
      createdAt: "2026-09-06T00:01:00.000Z",
      updatedAt: "2026-09-06T00:01:00.000Z",
    }));
  });

  it("returns the policy and private reviews without owner identifiers", async () => {
    const response = await GET(new Request(
      "http://localhost/api/memory/maintenance?status=all",
    ));
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(payload.policy.decay.mutatesHistoricalTruth).toBe(false);
    expect(payload.reviews[0]).not.toHaveProperty("ownerActorId");
  });

  it("runs private maintenance under the maintenance purpose", async () => {
    const response = await POST(new Request(
      "http://localhost/api/memory/maintenance",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "run" }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.runMaintenance).toHaveBeenCalledWith(
      [canonical],
      expect.objectContaining({
        accessScope: expect.objectContaining({
          purposeId: "memory.maintenance.v1",
          initiatingActorId: ownerActorId,
        }),
      }),
    );
  });

  it("promotes only after review and retains every source memory id", async () => {
    const response = await PATCH(new Request(
      "http://localhost/api/memory/maintenance",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "decide_promotion",
          reviewId: "review-a",
          decision: "promote",
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.saveMemory).toHaveBeenCalledWith(expect.objectContaining({
      tier: "procedural",
      formationReason: "maintenance_promotion",
      promotedFromTier: "episodic",
      evidenceRefs: ["memory:memory-a", "memory:memory-b"],
      databaseAccessScope: expect.objectContaining({ purposeId: "memory.write.v1" }),
    }));
    expect(mocks.resolveReview).toHaveBeenCalledWith(
      "review-a",
      "promote",
      expect.stringMatching(/^memory_promoted_/),
      expect.objectContaining({
        accessScope: expect.objectContaining({ purposeId: "memory.maintenance.v1" }),
      }),
    );
    const payload = await response.json();
    expect(payload.promotedMemory).not.toHaveProperty("embedding");
    expect(mocks.indexPrivate).toHaveBeenCalled();
  });
});
