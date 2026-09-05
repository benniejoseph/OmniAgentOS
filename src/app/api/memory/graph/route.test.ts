import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getMemoryGraphStats: vi.fn(async () => ({ nodes: 0, edges: 0 })),
  listMemoryGraphEdges: vi.fn(async () => []),
  listMemoryGraphNodes: vi.fn(async () => []),
  requestMemoryAccessFromSecurityContext: vi.fn(),
  searchMemoryGraph: vi.fn(async () => []),
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
    ) => ({ databaseAccessScope: databaseAccessScope(input.purposeId) }));
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
});
