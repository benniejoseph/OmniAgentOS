import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  accessSweep: vi.fn(async () => ({ expired: 0, deleted: 0 })),
  forgetMemoryWithReceipt: vi.fn(),
  hasDatabaseUrl: vi.fn(() => false),
  purgeExpiredKnowledgeCognitionsBoundedLocal: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(),
  hasDatabaseUrl: mocks.hasDatabaseUrl,
  runWithDatabaseSystemScope: vi.fn(),
  runWithDatabaseTenantScope: vi.fn(),
}));
vi.mock("@/lib/memory/graph", () => ({
  rebuildMemoryGraphSystemScoped: vi.fn(),
}));
vi.mock("@/lib/memory/store", () => ({
  forgetMemoryWithReceipt: mocks.forgetMemoryWithReceipt,
}));
vi.mock("@/lib/knowledge/cognification-store", () => ({
  purgeExpiredKnowledgeCognitionsBoundedLocal:
    mocks.purgeExpiredKnowledgeCognitionsBoundedLocal,
}));
vi.mock("@/lib/entities/store", () => ({
  retireEntityMemoryLineage: vi.fn(),
}));
vi.mock("@/lib/entities/relation-projection-queue", () => ({
  queueTemporalRelationProjection: vi.fn(),
}));
vi.mock("@/lib/onboarding/access-request-store", () => ({
  getAccessRequestStore: () => ({ sweepRetention: mocks.accessSweep }),
}));

import { sweepExpiredSensitiveData } from "@/lib/security/retention";

const tenantId = "tenant-retention";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-11T10:00:00.000Z"));
  process.env.OMNIAGENT_RETENTION_BATCH_SIZE = "137";
  mocks.accessSweep.mockReset().mockResolvedValue({ expired: 1, deleted: 2 });
  mocks.hasDatabaseUrl.mockReset().mockReturnValue(false);
  mocks.purgeExpiredKnowledgeCognitionsBoundedLocal.mockReset()
    .mockResolvedValue({
      removedCandidateCount: 2,
      projectedMemories: [
        { id: "memory-one", ownerActorId: "actor:memory-owner" },
        { id: "memory-two", ownerActorId: "actor:memory-owner" },
      ],
      moreAvailable: true,
    });
  mocks.forgetMemoryWithReceipt.mockReset()
    .mockResolvedValueOnce({ deletionDisposition: "committed" })
    .mockResolvedValueOnce({ deletionDisposition: "already_deleted" });
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.OMNIAGENT_RETENTION_BATCH_SIZE;
});

describe("bounded-local sensitive-data retention", () => {
  it("purges one exact cognition tenant and scrubs its projected memories", async () => {
    const result = await sweepExpiredSensitiveData({ tenantId });

    expect(mocks.purgeExpiredKnowledgeCognitionsBoundedLocal).toHaveBeenCalledWith({
      tenantId,
      limit: 137,
    });
    expect(mocks.forgetMemoryWithReceipt).toHaveBeenNthCalledWith(
      1,
      "memory-one",
      expect.objectContaining({
        tenantId,
        executionScope: expect.objectContaining({
          tenantId,
          initiatingActorId: "actor:memory-owner",
          executingPrincipalType: "system",
          executingPrincipalId: "retention-sweep",
          correlationId: expect.stringMatching(/^retention-cognition:/),
          purpose: "memory.forget.v1",
        }),
        accessScope: expect.objectContaining({
          tenantId,
          initiatingActorId: "actor:memory-owner",
          purposeId: "memory.forget.v1",
          purpose: "security.retention.local-cognition-forget",
        }),
      }),
    );
    expect(mocks.forgetMemoryWithReceipt).toHaveBeenNthCalledWith(
      2,
      "memory-two",
      expect.objectContaining({
        tenantId,
        executionScope: expect.objectContaining({
          initiatingActorId: "actor:memory-owner",
        }),
        accessScope: expect.objectContaining({
          initiatingActorId: "actor:memory-owner",
        }),
      }),
    );
    expect(result).toMatchObject({
      backend: "bounded_local",
      scope: "tenant",
      tenantId,
      batchLimit: 137,
      moreAvailable: true,
      deleted: {
        expiredAccessRequests: 1,
        accessRequests: 2,
        knowledgeCognitionCandidates: 2,
        memories: 1,
      },
    });
  });

  it("does not present one tenant's cognition sweep as all-tenant coverage", async () => {
    const result = await sweepExpiredSensitiveData({
      tenantId,
      allTenants: true,
    });

    expect(mocks.accessSweep).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: undefined,
    }));
    expect(mocks.purgeExpiredKnowledgeCognitionsBoundedLocal)
      .not.toHaveBeenCalled();
    expect(mocks.forgetMemoryWithReceipt).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      backend: "bounded_local",
      scope: "all_tenants",
      batchLimit: 0,
      moreAvailable: false,
      deleted: {
        knowledgeCognitionCandidates: 0,
        memories: 0,
      },
    });
    expect(result.tenantId).toBeUndefined();
  });
});
