import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getMemoryGraphStats: vi.fn(async () => ({ nodes: 0, edges: 0 })),
  listMemoryGraphEdges: vi.fn(async () => []),
  listMemoryGraphNodes: vi.fn(async () => []),
  queryTemporalRelationClaims: vi.fn(
    async (): Promise<Array<Record<string, unknown>>> => [],
  ),
  retrieveGraphRelationshipPaths: vi.fn(),
  requestEntityAccessFromSecurityContext: vi.fn(),
  requestMemoryAccessFromSecurityContext: vi.fn(),
  searchMemoryGraph: vi.fn(async () => []),
}));
vi.mock("@/lib/entities/graph-retrieval", () => ({
  retrieveGraphRelationshipPaths: mocks.retrieveGraphRelationshipPaths,
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
vi.mock("@/lib/entities/request-access", () => ({
  requestEntityAccessFromSecurityContext:
    mocks.requestEntityAccessFromSecurityContext,
}));
vi.mock("@/lib/entities/temporal-claim-store", () => ({
  queryTemporalRelationClaims: mocks.queryTemporalRelationClaims,
}));
vi.mock("@/lib/memory/graph", () => ({
  getMemoryGraphStats: mocks.getMemoryGraphStats,
  listMemoryGraphEdges: mocks.listMemoryGraphEdges,
  listMemoryGraphNodes: mocks.listMemoryGraphNodes,
  rebuildMemoryGraph: vi.fn(),
  searchMemoryGraph: mocks.searchMemoryGraph,
}));

import { GET } from "@/app/api/memory/graph/route";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin",
  source: "session" as const,
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
  },
};

function databaseAccessScope(purposeId: string) {
  return {
    version: 1 as const,
    tenantId: "tenant-a",
    initiatingActorId: "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    executingPrincipalType: "user" as const,
    executingPrincipalId: "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    workspaceId: null,
    projectId: null,
    missionId: null,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purposeId,
    purpose: "test.memory.graph",
  };
}

describe("memory graph private-memory boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.requestMemoryAccessFromSecurityContext.mockImplementation((
      _context: unknown,
      input: { purposeId: string },
    ) => ({
      databaseAccessScope: databaseAccessScope(input.purposeId),
      executionScope: { purpose: "test.memory.graph" },
    }));
    mocks.requestEntityAccessFromSecurityContext.mockReturnValue({
      actorBinding: {
        canonicalActorId:
          "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
      },
      accessBinding: {
        accessScopeSha256: "private-scope",
      },
      executionScope: {
        purpose: "entity.read.v1",
      },
    });
    mocks.retrieveGraphRelationshipPaths.mockResolvedValue({
      paths: [],
      receipt: {
        version: "p5.5-graph-retrieval:1",
        pathCount: 0,
      },
    });
  });

  it("searches the graph under the owner retrieval scope", async () => {
    const response = await GET(new Request(
      "http://localhost/api/memory/graph?q=private%20preference&limit=8",
    ));
    const accessScope = databaseAccessScope(MEMORY_PURPOSE_IDS.retrieve);

    expect(response.status).toBe(200);
    expect(mocks.searchMemoryGraph).toHaveBeenCalledWith(
      "private preference",
      { tenantId: "tenant-a", limit: 8, accessScope },
    );
    expect(mocks.getMemoryGraphStats).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      accessScope,
    });
  });

  it("lists the graph under the owner read scope", async () => {
    const response = await GET(new Request(
      "http://localhost/api/memory/graph?limit=6",
    ));
    const accessScope = databaseAccessScope(MEMORY_PURPOSE_IDS.read);

    expect(response.status).toBe(200);
    expect(mocks.listMemoryGraphNodes).toHaveBeenCalledWith(6, {
      tenantId: "tenant-a",
      accessScope,
    });
    expect(mocks.listMemoryGraphEdges).toHaveBeenCalledWith(12, {
      tenantId: "tenant-a",
      accessScope,
    });
    expect(mocks.getMemoryGraphStats).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      accessScope,
    });
  });

  it("queries the bitemporal relation view without exposing contracts", async () => {
    mocks.queryTemporalRelationClaims.mockResolvedValueOnce([{
      claim: {
        claimId: "claim-a",
        revisionId: "revision-a",
        previousRevisionId: null,
        relationTypeId: "affiliated_with",
        source: {
          entityId: "entity-person",
          entityTypeId: "person",
          entitySha256: "secret-source-digest",
        },
        target: {
          entityId: "entity-organization",
          entityTypeId: "organization",
          entitySha256: "secret-target-digest",
        },
        epistemicKind: "asserted",
        claimState: "active",
        confidenceBasisPoints: 10_000,
        validFrom: "2026-01-01T00:00:00.000Z",
        validTo: null,
        recordedAt: "2026-02-01T00:00:00.000Z",
        lineage: [{ referenceId: "secret-evidence" }],
        accessBinding: { accessScopeSha256: "secret-access-digest" },
        claimSha256: "secret-claim-digest",
      },
      supersededAt: null,
    }]);
    const response = await GET(new Request(
      "http://localhost/api/memory/graph?view=temporal_relations" +
      "&entityId=entity-person&relationTypeId=affiliated_with" +
      "&epistemicKind=asserted&validAt=2026-03-01T00%3A00%3A00.000Z" +
      "&recordedAt=2026-03-01T00%3A00%3A00.000Z&limit=25",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.queryTemporalRelationClaims).toHaveBeenCalledWith({
      actorBinding: expect.any(Object),
      accessBinding: expect.objectContaining({ accessScopeSha256: "private-scope" }),
      executionScope: expect.objectContaining({ purpose: "entity.read.v1" }),
      entityId: "entity-person",
      relationTypeId: "affiliated_with",
      epistemicKinds: ["asserted"],
      validAt: "2026-03-01T00:00:00.000Z",
      recordedAt: "2026-03-01T00:00:00.000Z",
      history: false,
      limit: 25,
    });
    const payload = await response.json();
    expect(payload.relations).toEqual([expect.objectContaining({
      claimId: "claim-a",
      epistemicKind: "asserted",
      lineageCount: 1,
    })]);
    expect(JSON.stringify(payload)).not.toContain("secret-");
  });

  it("rejects malformed temporal queries before reading relation data", async () => {
    const response = await GET(new Request(
      "http://localhost/api/memory/graph?view=temporal_relations" +
      "&validAt=not-a-time&epistemicKind=opinion",
    ));

    expect(response.status).toBe(400);
    expect(mocks.queryTemporalRelationClaims).not.toHaveBeenCalled();
  });

  it("returns bounded, no-store relationship paths under both actor scopes", async () => {
    mocks.retrieveGraphRelationshipPaths.mockResolvedValueOnce({
      paths: [{
        pathId: "relationship_path_a",
        anchor: { entityId: "entity-a", entityTypeId: "person", label: "Ada" },
        terminal: { entityId: "entity-b", entityTypeId: "project", label: "Phoenix" },
        hopCount: 1,
        score: 0.9,
        explanation: "Ada → Phoenix",
        hops: [{
          claimId: "claim-a",
          revisionId: "revision-a",
          relationTypeId: "commits_to",
          relationLabel: "Commits to",
          direction: "forward",
          source: { entityId: "entity-a", entityTypeId: "person", label: "Ada" },
          target: { entityId: "entity-b", entityTypeId: "project", label: "Phoenix" },
          epistemicKind: "asserted",
          confidenceBasisPoints: 9_000,
          validFrom: "2026-09-01T00:00:00.000Z",
          validTo: null,
          evidence: [{
            evidenceId: "memory:memory-a",
            kind: "memory",
            title: "Commitment",
            excerpt: "Ada committed to Phoenix.",
            source: "manual",
            observedAt: "2026-09-01T00:00:00.000Z",
          }],
        }],
        pathSha256: "a".repeat(64),
      }],
      receipt: { version: "p5.5-graph-retrieval:1", pathCount: 1 },
    });
    const response = await GET(new Request(
      "http://localhost/api/memory/graph?view=relationship_paths" +
      "&q=How%20is%20Ada%20connected%3F&maxHops=2&limit=12",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.retrieveGraphRelationshipPaths).toHaveBeenCalledWith(
      "How is Ada connected?",
      expect.objectContaining({
        entityAccess: expect.objectContaining({
          executionScope: expect.objectContaining({ purpose: "entity.read.v1" }),
        }),
        memoryAccessScope: expect.objectContaining({
          purposeId: MEMORY_PURPOSE_IDS.retrieve,
        }),
        maxHops: 2,
        limit: 12,
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      view: "relationship_paths",
      paths: [{
        pathId: "relationship_path_a",
        hops: [{ evidence: [{ evidenceId: "memory:memory-a" }] }],
      }],
    });
  });

  it("rejects relationship traversal without a query", async () => {
    const response = await GET(new Request(
      "http://localhost/api/memory/graph?view=relationship_paths",
    ));

    expect(response.status).toBe(400);
    expect(mocks.retrieveGraphRelationshipPaths).not.toHaveBeenCalled();
  });
});
