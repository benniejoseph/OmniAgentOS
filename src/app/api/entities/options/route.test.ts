import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authorize: vi.fn(), read: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({
  ...(await original<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope: (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (original) => ({
  ...(await original<typeof import("@/lib/security/guard")>()), authorizeRequest: mocks.authorize,
}));
vi.mock("@/lib/entities/store", () => ({ readEntityOptions: mocks.read }));

import { GET } from "./route";
import { ENTITY_OPTIONS_CONTRACT, entityOptionsResponseSchema } from "@/lib/entities/options-contracts";
import type { RequestEntityAccessV1 } from "@/lib/entities/request-access";
import { SecurityPolicyError } from "@/lib/security/context";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = { tenantId: "tenant-a", actorId: "owner@example.test", role: "viewer", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-one", tenantName: "Tenant A" } };
beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue(context);
  mocks.read.mockReset().mockImplementation(async (access: RequestEntityAccessV1, query: { limit: number; after?: string }) => ({
    schemaVersion: 1, contract: ENTITY_OPTIONS_CONTRACT,
    scope: { tenantId: access.accessBinding.tenantId, ownerActorId: access.actorBinding.canonicalActorId,
      accessScopeSha256: access.accessBinding.accessScopeSha256, purposeId: "entity.read.v1" },
    items: [], hasMore: false, nextAfter: null,
    coverage: { kind: "bounded_current", limit: query.limit, returned: 0, after: query.after ?? null, total: null }, authorityEffect: "none",
  }));
});
const request = (query = "") => new Request("http://localhost/api/entities/options" + query);

describe("read-only canonical Entity options route", () => {
  it("authorizes viewer reads and passes the exact private purpose/hash to the bounded store", async () => {
    const response = await GET(request("?limit=100&after=entity%3Aa%2F%2B"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({ action: "read", resourceType: "entity_registry" }));
    expect(mocks.read).toHaveBeenCalledWith(expect.objectContaining({
      actorBinding: expect.objectContaining({ canonicalActorId: "actor:11111111-1111-4111-8111-111111111111" }),
      accessBinding: expect.objectContaining({ tenantId: "tenant-a", visibility: "user_private", sensitivity: "confidential", accessScopeSha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      executionScope: expect.objectContaining({ purpose: "entity.read.v1" }),
    }), { limit: 100, after: "entity:a/+" });
    expect(entityOptionsResponseSchema.safeParse(await response.json()).success).toBe(true);
  });

  it("uses a bounded default and rejects unknown, repeated and malformed query fields before storage", async () => {
    expect((await GET(request())).status).toBe(200);
    expect(mocks.read.mock.calls[0][1]).toEqual({ limit: 40 });
    mocks.read.mockClear();
    for (const query of ["?limit=101", "?limit=0", "?limit=1.5", "?limit=1e2", "?limit=", "?limit=1&limit=2",
      "?after=", "?after=entity:a&after=entity:b", "?after=%20entity:a", "?tenantId=foreign", "?type=person", "?after=" + "x".repeat(241)]) {
      const response = await GET(request(query));
      expect(response.status, query).toBe(400);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("keeps unsupported compatibility identities outside the canonical private registry", async () => {
    for (const replacement of [{ ...context, source: "headers", auth: undefined },
      { ...context, auth: { ...context.auth!, userId: "invalid" } },
      { ...context, actorId: "someone-else@example.test" }]) {
      mocks.authorize.mockResolvedValueOnce(replacement);
      const response = await GET(request());
      expect(response.status).toBe(403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("returns private 401 and 403 denial envelopes without attempting a projection", async () => {
    for (const status of [401, 403]) {
      mocks.authorize.mockRejectedValueOnce(new SecurityPolicyError("Current membership is unavailable.", status));
      const response = await GET(request());
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ error: status === 401 ? "Unauthorized" : "Forbidden", message: "Current membership is unavailable." });
    }
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("re-resolves mobile canonical ownership and tenant on every page", async () => {
    const first = await (await GET(request("?limit=1"))).json();
    mocks.authorize.mockResolvedValueOnce({ ...context, tenantId: "tenant-b", source: "mobile",
      auth: { ...context.auth!, userId: "22222222-2222-4222-8222-222222222222", sessionId: "session-two" } });
    const second = await (await GET(request("?limit=1&after=entity:a"))).json();
    expect(mocks.authorize).toHaveBeenCalledTimes(2);
    expect(second.scope).toMatchObject({ tenantId: "tenant-b", ownerActorId: "actor:22222222-2222-4222-8222-222222222222" });
    expect(second.scope.accessScopeSha256).not.toBe(first.scope.accessScopeSha256);
    expect(second.coverage.after).toBe("entity:a");
  });

  it("turns storage uncertainty into an unavailable response without leaking a failed head", async () => {
    mocks.read.mockRejectedValueOnce(new Error("PRIVATE_RECORD_MUST_NOT_ESCAPE"));
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ error: "Entity options are temporarily unavailable." });
  });
});
