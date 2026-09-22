import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  preview: vi.fn(),
  revoke: vi.fn(),
  directRevoke: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: (handler: unknown) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext: () => ({
    canonicalActorId: "actor:11111111-1111-4111-8111-111111111111",
  }),
}));
vi.mock("@/lib/app-services/agent-governance", () => ({
  previewAgentGrantRevokeService: mocks.preview,
  revokeAgentGrantService: mocks.revoke,
}));
vi.mock("@/lib/memory/agent-grant-store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/memory/agent-grant-store")>(),
  revokeAgentMemoryGrant: mocks.directRevoke,
}));

import { DELETE } from "@/app/api/agents/[id]/grants/[grantId]/route";

const context = {
  params: Promise.resolve({ id: "agent-one", grantId: "context:grant-one" }),
};

describe("Agent memory-grant revoke route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "session",
    });
    mocks.preview.mockResolvedValue({
      data: {
        target: { agentId: "agent-one", grant: { grantId: "context:grant-one" } },
        targetSha256: "a".repeat(64),
      },
      receipt: { operation: "app.agents.grants.revoke.preview" },
    });
    mocks.revoke.mockResolvedValue({
      data: { revoked: true, targetSha256: "a".repeat(64) },
      receipt: { operation: "app.agents.grants.revoke" },
    });
  });

  it("uses the request-attributed exact-target revoke service", async () => {
    const response = await DELETE(new Request(
      "http://asael.test/api/agents/agent-one/grants/context%3Agrant-one",
      { method: "DELETE", headers: { "idempotency-key": "revoke-grant-one" } },
    ), context);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.preview).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "revoke-grant-one",
        executionScope: expect.objectContaining({
          tenantId: "tenant-one",
          initiatingActorId: "actor-one",
          purpose: "agent.memory_grant.revoke",
        }),
      }),
      { agentId: "agent-one", grantId: "context:grant-one" },
    );
    expect(mocks.revoke).toHaveBeenCalledWith(expect.anything(), {
      agentId: "agent-one",
      grantId: "context:grant-one",
      expectedTargetSha256: "a".repeat(64),
    });
    expect(mocks.directRevoke).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({
      revoked: true,
      serviceReceipt: { operation: "app.agents.grants.revoke" },
    });
  });

  it("does not invoke mutation when the exact target is absent", async () => {
    mocks.preview.mockResolvedValueOnce({
      data: { target: null, targetSha256: "0".repeat(64) },
      receipt: { operation: "app.agents.grants.revoke.preview" },
    });
    const response = await DELETE(new Request(
      "http://asael.test/api/agents/agent-one/grants/context%3Agrant-one",
      { method: "DELETE" },
    ), context);

    expect(response.status).toBe(404);
    expect(mocks.revoke).not.toHaveBeenCalled();
    expect(mocks.directRevoke).not.toHaveBeenCalled();
  });
});
