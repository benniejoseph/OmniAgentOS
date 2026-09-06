import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  forbiddenResponse: vi.fn(() => new Response(null, { status: 403 })),
  createAgentMemoryGrant: vi.fn(),
  listAgentMemoryGrants: vi.fn(),
  revokeAgentMemoryGrant: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: mocks.forbiddenResponse,
}));
vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext: () => ({
    canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
  }),
}));
vi.mock("@/lib/memory/agent-grant-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory/agent-grant-store")>(),
  createAgentMemoryGrant: mocks.createAgentMemoryGrant,
  listAgentMemoryGrants: mocks.listAgentMemoryGrants,
  revokeAgentMemoryGrant: mocks.revokeAgentMemoryGrant,
}));

import { GET, POST } from "@/app/api/agents/[id]/grants/route";
import { DELETE } from "@/app/api/agents/[id]/grants/[grantId]/route";

const auth = {
  tenantId: "tenant-one",
  actorId: "owner@example.test",
  role: "owner",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorizeRequest.mockResolvedValue(auth);
  mocks.listAgentMemoryGrants.mockResolvedValue([]);
  mocks.createAgentMemoryGrant.mockResolvedValue({
    record: { grantId: "context:one" },
    explanation: "Can see one exact target.",
    manageable: true,
  });
  mocks.revokeAgentMemoryGrant.mockResolvedValue(undefined);
});

describe("P7.4 Agent memory grant routes", () => {
  it("returns the exact custom Agent grant set privately", async () => {
    const response = await GET(
      new Request("http://asael.test/api/agents/agent-one/grants"),
      { params: Promise.resolve({ id: "agent-one" }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.listAgentMemoryGrants).toHaveBeenCalledWith("agent-one", {
      tenantId: "tenant-one",
      actorId: "owner@example.test",
      canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
    });
  });

  it("validates and creates a bounded grant", async () => {
    const draft = {
      schemaVersion: 1,
      grantKind: "context",
      purposeId: "memory.retrieve.v1",
      target: {
        visibility: "agent_private",
        resourceIds: ["memory:one"],
        workspaceId: null,
        projectId: null,
        missionId: null,
      },
      maxItems: 12,
      maxBytes: 24_000,
      expiresAt: "2026-09-08T10:00:00.000Z",
    };
    const response = await POST(
      new Request("http://asael.test/api/agents/agent-one/grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(draft),
      }),
      { params: Promise.resolve({ id: "agent-one" }) },
    );

    expect(response.status).toBe(201);
    expect(mocks.createAgentMemoryGrant).toHaveBeenCalledWith(
      "agent-one",
      draft,
      expect.objectContaining({ tenantId: "tenant-one" }),
    );
  });

  it("revokes one exact grant", async () => {
    const response = await DELETE(
      new Request(
        "http://asael.test/api/agents/agent-one/grants/context%3Aone",
        { method: "DELETE" },
      ),
      {
        params: Promise.resolve({
          id: "agent-one",
          grantId: "context:one",
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(mocks.revokeAgentMemoryGrant).toHaveBeenCalledWith(
      "agent-one",
      "context:one",
      expect.objectContaining({ actorId: "owner@example.test" }),
    );
  });
});
