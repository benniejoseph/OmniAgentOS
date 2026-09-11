import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  canonicalRequestActorBindingFromSecurityContext: vi.fn(),
  listRecentEvents: vi.fn(),
  listStreamEvents: vi.fn(),
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

vi.mock("@/lib/events/store", () => ({
  listRecentEvents: routeMocks.listRecentEvents,
  listStreamEvents: routeMocks.listStreamEvents,
}));

import { GET } from "@/app/api/events/route";

const context = {
  tenantId: "tenant-events",
  actorId: "events-owner@example.test",
  role: "viewer" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "events-owner@example.test",
    sessionId: "session-events",
    tenantName: "Tenant Events",
  },
};
const readableOwnerActorIds = [
  `actor:${context.auth.userId}`,
  context.actorId,
];

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue({
      version: 1,
      kind: "auth_user",
      authUserId: context.auth.userId,
      canonicalActorId: readableOwnerActorIds[0],
      legacyOwnerActorIds: [context.actorId],
      readableOwnerActorIds,
    });
  routeMocks.listRecentEvents.mockReset().mockResolvedValue([]);
  routeMocks.listStreamEvents.mockReset().mockResolvedValue([]);
});

describe("domain event route", () => {
  it("reads a summary stream through only the canonical actor pair", async () => {
    const response = await GET(new Request(
      "http://localhost/api/events?stream=conversation-summary%3Aepisode-one&limit=40",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listStreamEvents).toHaveBeenCalledWith(
      "conversation-summary:episode-one",
      {
        tenantId: context.tenantId,
        privateActorIds: readableOwnerActorIds,
        limit: 40,
      },
    );
    expect(routeMocks.listRecentEvents).not.toHaveBeenCalled();
  });

  it("applies the canonical actor pair to mixed recent-event reads", async () => {
    await GET(new Request(
      "http://localhost/api/events?type=conversation.summary.enriched",
    ));

    expect(routeMocks.listRecentEvents).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      privateActorIds: readableOwnerActorIds,
      limit: 50,
      type: "conversation.summary.enriched",
    });
    expect(routeMocks.listStreamEvents).not.toHaveBeenCalled();
  });

  it("fails closed to the exact authenticated actor without a canonical pair", async () => {
    routeMocks.canonicalRequestActorBindingFromSecurityContext
      .mockReturnValue(undefined);

    await GET(new Request("http://localhost/api/events"));

    expect(routeMocks.listRecentEvents).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      privateActorIds: [context.actorId],
      limit: 50,
      type: undefined,
    });
  });
});
