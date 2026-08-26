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

describe("notification inbox route", () => {
  beforeEach(() => {
    routeMocks.authorizeRequest.mockReset().mockResolvedValue({
      tenantId: "tenant-a",
      actorId: "owner-a",
      role: "admin",
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
      actorId: "owner-a",
      processDue: false,
    });
  });
});
