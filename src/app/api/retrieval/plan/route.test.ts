import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  buildContextPack: vi.fn(async () => ({ results: [] })),
  getContextEngineStats: vi.fn(async () => ({ traces: 0 })),
  listRetrievalTraces: vi.fn(async () => []),
  requestMemoryAccessFromSecurityContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <TArgs extends unknown[], TResult>(
    handler: (...args: TArgs) => TResult,
  ) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: vi.fn(() => Response.json({ error: "forbidden" }, { status: 403 })),
}));
vi.mock("@/lib/memory/request-access", () => ({
  requestMemoryAccessFromSecurityContext:
    mocks.requestMemoryAccessFromSecurityContext,
}));
vi.mock("@/lib/rag/context-engine", () => ({
  buildContextPack: mocks.buildContextPack,
  getContextEngineStats: mocks.getContextEngineStats,
  listRetrievalTraces: mocks.listRetrievalTraces,
}));

import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { GET, POST } from "@/app/api/retrieval/plan/route";

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
const databaseAccessScope = {
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
  purposeId: MEMORY_PURPOSE_IDS.retrieve,
  purpose: "api.retrieval.plan",
};

describe("retrieval plan private-memory boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue(context);
    mocks.requestMemoryAccessFromSecurityContext.mockReturnValue({
      databaseAccessScope,
    });
  });

  it("passes canonical user-private scope to GET context retrieval", async () => {
    const response = await GET(
      new Request("http://localhost/api/retrieval/plan?q=remember%20my%20preference"),
    );

    expect(response.status).toBe(200);
    expect(mocks.requestMemoryAccessFromSecurityContext).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ purposeId: MEMORY_PURPOSE_IDS.retrieve }),
    );
    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "remember my preference",
      expect.objectContaining({ databaseMemoryAccessScope: databaseAccessScope }),
    );
  });

  it("passes canonical user-private scope to POST context retrieval", async () => {
    const response = await POST(new Request("http://localhost/api/retrieval/plan", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "remember my preference", limit: 5 }),
    }));

    expect(response.status).toBe(200);
    expect(mocks.buildContextPack).toHaveBeenCalledWith(
      "remember my preference",
      expect.objectContaining({
        databaseMemoryAccessScope: databaseAccessScope,
        limit: 5,
      }),
    );
  });
});
