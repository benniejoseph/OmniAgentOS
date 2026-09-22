import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope: <T>(handler: T) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorize,
  forbiddenResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/app-services/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/app-services/notifications")>()),
  listNotificationDispositionsService: mocks.list,
}));

import { GET } from "@/app/api/notifications/dispositions/route";

describe("notification disposition history route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authorize.mockResolvedValue({
      tenantId: "tenant-one",
      actorId: "actor-one",
      role: "operator",
      source: "session",
    });
    mocks.list.mockResolvedValue({
      data: {
        version: "notification-disposition-projection:1",
        dispositions: [],
        contentIncluded: false,
      },
      receipt: { operation: "app.notifications.dispositions.list" },
    });
  });

  it("returns an actor-private, no-store, content-free projection", async () => {
    const response = await GET(new Request(
      "http://asael.test/api/notifications/dispositions?limit=25&before=2026-09-22T14%3A00%3A00.000Z",
    ));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(mocks.authorize).toHaveBeenCalledWith(expect.objectContaining({
      action: "read",
      resourceType: "notification_disposition",
    }));
    expect(mocks.list).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          tenantId: "tenant-one",
          actorId: "actor-one",
        }),
      }),
      { limit: 25, before: "2026-09-22T14:00:00.000Z" },
    );
    expect(await response.json()).toMatchObject({
      contentIncluded: false,
      serviceReceipt: { operation: "app.notifications.dispositions.list" },
    });
  });

  it("rejects an invalid cursor before authorization", async () => {
    const response = await GET(new Request(
      "http://asael.test/api/notifications/dispositions?before=not-a-date",
    ));
    expect(response.status).toBe(400);
    expect(mocks.authorize).not.toHaveBeenCalled();
  });
});
