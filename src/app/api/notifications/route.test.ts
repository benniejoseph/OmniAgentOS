import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getNotificationCenter: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/today/notifications", () => ({
  getNotificationCenter: routeMocks.getNotificationCenter,
  markAllNotificationsRead: vi.fn(),
}));

import { GET } from "@/app/api/notifications/route";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "notification-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;

describe("notification inbox route", () => {
  beforeEach(() => {
    routeMocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId: "tenant-a",
      actorId,
      role: "admin",
      source: "session",
      auth: {
        userId: authUserId,
        email: actorId,
        sessionId: "session-a",
        tenantName: "Tenant A",
      },
    });
    routeMocks.getNotificationCenter.mockReset().mockResolvedValue({
      generatedAt: "2026-08-26T12:00:00.000Z",
      notifications: [],
      unreadCount: 0,
      quietHoursActive: false,
      preferences: {},
    });
  });

  it("keeps reminder generation out of the interactive read", async () => {
    const response = await GET(
      new Request("http://localhost/api/notifications"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.getNotificationCenter).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      actorId,
      processDue: false,
      requestActorBinding: {
        version: 1,
        kind: "auth_user",
        authUserId,
        canonicalActorId,
        legacyOwnerActorIds: [actorId],
        readableOwnerActorIds: [canonicalActorId, actorId],
      },
    });
  });
});
