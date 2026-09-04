import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  getSettingsSnapshot: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext:
    routeMocks.canonicalRequestActorBindingFromSecurityContext,
}));

vi.mock("@/lib/settings/snapshot", () => ({
  getSettingsSnapshot: routeMocks.getSettingsSnapshot,
}));

import { GET } from "@/app/api/settings/route";

const context = {
  tenantId: "tenant-a",
  actorId: "settings-owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "settings-owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId: context.auth.userId,
  canonicalActorId: `actor:${context.auth.userId}`,
  legacyOwnerActorIds: [context.actorId],
  readableOwnerActorIds: [
    `actor:${context.auth.userId}`,
    context.actorId,
  ],
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.getSettingsSnapshot.mockReset().mockResolvedValue({ apiKeys: [] });
});

describe("settings snapshot route", () => {
  it("passes the authenticated request binding into the snapshot", async () => {
    const response = await GET(new Request("http://localhost/api/settings"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    expect(routeMocks.getSettingsSnapshot).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
  });
});
