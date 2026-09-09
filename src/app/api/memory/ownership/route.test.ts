import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  indexUserPrivateMemoryGraphRecords: vi.fn(),
  listMemories: vi.fn(),
  migrateLegacyDurableMemoryOwnership: vi.fn(),
  previewLegacyDurableMemoryOwnership: vi.fn(),
  projectExplicitMemoryEntities: vi.fn(),
  requestMemoryAccessFromSecurityContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <TArgs extends unknown[], TResult>(
    handler: (...args: TArgs) => TResult,
  ) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(() =>
    Response.json({ error: "forbidden" }, { status: 403 })
  ),
}));
vi.mock("@/lib/memory/request-access", () => ({
  requestMemoryAccessFromSecurityContext:
    mocks.requestMemoryAccessFromSecurityContext,
}));
vi.mock("@/lib/memory/legacy-ownership", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/legacy-ownership")>()),
  migrateLegacyDurableMemoryOwnership:
    mocks.migrateLegacyDurableMemoryOwnership,
  previewLegacyDurableMemoryOwnership:
    mocks.previewLegacyDurableMemoryOwnership,
}));
vi.mock("@/lib/memory/store", () => ({ listMemories: mocks.listMemories }));
vi.mock("@/lib/memory/graph", () => ({
  indexUserPrivateMemoryGraphRecords:
    mocks.indexUserPrivateMemoryGraphRecords,
}));
vi.mock("@/lib/entities/extraction", () => ({
  projectExplicitMemoryEntities: mocks.projectExplicitMemoryEntities,
}));

import { GET, POST } from "@/app/api/memory/ownership/route";

const ownerActorId = "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
  },
};
const preview = {
  version: 1,
  count: 2,
  activeCount: 1,
  historicalCount: 1,
  manifestSha256: "a".repeat(64),
};

describe("memory ownership route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.previewLegacyDurableMemoryOwnership.mockResolvedValue(preview);
    mocks.requestMemoryAccessFromSecurityContext.mockImplementation((
      _context: unknown,
      input: { purposeId: string },
    ) => ({
      actorBinding: { canonicalActorId: ownerActorId },
      executionScope: {
        tenantId: "tenant-a",
        initiatingActorId: ownerActorId,
        executingPrincipalType: "user",
        executingPrincipalId: ownerActorId,
        workspaceId: null,
        projectId: null,
        missionId: null,
      },
      databaseAccessScope: { purposeId: input.purposeId },
    }));
    mocks.migrateLegacyDurableMemoryOwnership.mockResolvedValue({
      preview,
      migratedCount: 2,
      reviewCount: 1,
      traceCount: 1,
      removedGraphNodeCount: 3,
      removedGraphEdgeCount: 2,
      recordIds: ["memory-a", "memory-b"],
    });
    mocks.listMemories.mockResolvedValue([{
      id: "memory-a",
      tenantId: "tenant-a",
      assertedBy: "user",
      source: "manual",
    }]);
    mocks.indexUserPrivateMemoryGraphRecords.mockResolvedValue({
      indexedMemoryCount: 1,
      nodeCount: 4,
      edgeCount: 3,
    });
    mocks.projectExplicitMemoryEntities.mockResolvedValue({
      extraction: { candidates: [] },
      createdEntityIds: [],
      linkedEntityIds: [],
      reviewResolutionIds: [],
    });
  });

  it("returns a content-free ownership preview", async () => {
    const response = await GET(new Request("http://localhost/api/memory/ownership"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ preview });
  });

  it("enrolls the previewed cohort and refreshes private projections", async () => {
    const response = await POST(new Request(
      "http://localhost/api/memory/ownership",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "enroll_current_user",
          expectedManifestSha256: preview.manifestSha256,
        }),
      },
    ));

    expect(response.status).toBe(200);
    expect(mocks.migrateLegacyDurableMemoryOwnership).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-a",
        ownerActorId,
        expectedManifestSha256: preview.manifestSha256,
      }),
    );
    expect(mocks.indexUserPrivateMemoryGraphRecords).toHaveBeenCalledWith(
      [expect.objectContaining({ id: "memory-a" })],
      "memory.legacy_owner_enrollment",
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
    await expect(response.json()).resolves.toMatchObject({
      migration: { migratedCount: 2, activeCount: 1, reviewCount: 1 },
      graphProjection: { indexedMemoryCount: 1 },
    });
  });
});
