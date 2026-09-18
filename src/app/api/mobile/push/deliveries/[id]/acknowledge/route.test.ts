import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getCandidate: vi.fn(),
  acknowledge: vi.fn(),
  updateNotification: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (request: Request, route: unknown) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: (error: unknown) => Response.json(
    { error: error instanceof Error ? error.message : "failed" },
    { status: 500 },
  ),
}));
vi.mock("@/lib/mobile/push-store", () => ({
  MobilePushConflictError: class extends Error { readonly status = 409; },
  MobilePushStorageRequiredError: class extends Error { readonly status = 503; },
  getMobilePushAcknowledgementCandidate: mocks.getCandidate,
  acknowledgeMobilePushDelivery: mocks.acknowledge,
}));
vi.mock("@/lib/today/notifications", () => ({
  updatePersonalNotification: mocks.updateNotification,
}));
vi.mock("@/lib/today/notification-events", () => ({
  notificationMutationFromRequest: () => ({
    idempotencyKey: "push-open:delivery-one",
    executionScope: { fixture: true },
  }),
}));

import { POST } from "@/app/api/mobile/push/deliveries/[id]/acknowledge/route";

const context = {
  tenantId: "tenant-one",
  actorId: "operator@example.test",
  role: "operator" as const,
  source: "mobile" as const,
};
const delivery = {
  id: "delivery-one",
  status: "delivered" as const,
  notificationId: "notification-one",
  target: { kind: "meeting" as const, id: "meeting-one" },
  deepLink: "/meetings/meeting-one",
};

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.getCandidate.mockReset().mockResolvedValue(delivery);
  mocks.updateNotification.mockReset().mockResolvedValue({ id: "notification-one" });
  mocks.acknowledge.mockReset().mockResolvedValue({
    delivery,
    newlyAcknowledged: true,
  });
});

describe("mobile push acknowledgement route", () => {
  it("marks the personal notification before acknowledging the delivery", async () => {
    const response = await POST(
      request(),
      { params: Promise.resolve({ id: "delivery-one" }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      acknowledged: true,
      newlyAcknowledged: true,
      notificationId: "notification-one",
      causeKind: "meeting",
      causeId: "meeting-one",
      deepLink: "/meetings/meeting-one",
    });
    expect(mocks.updateNotification.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.acknowledge.mock.invocationCallOrder[0],
    );
    expect(mocks.updateNotification).toHaveBeenCalledWith(
      "notification-one",
      "read",
      expect.objectContaining({ onlyIfUnread: true }),
    );
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeMutationCapability: "push.delivery.acknowledge",
      }),
    );
  });

  it("returns the stable prior acknowledgement on response retry", async () => {
    mocks.getCandidate.mockResolvedValue({
      ...delivery,
      status: "acknowledged",
    });
    mocks.acknowledge.mockResolvedValue({
      delivery: { ...delivery, status: "acknowledged" },
      newlyAcknowledged: false,
    });
    const response = await POST(
      request(),
      { params: Promise.resolve({ id: "delivery-one" }) },
    );
    await expect(response.json()).resolves.toMatchObject({
      acknowledged: true,
      newlyAcknowledged: false,
    });
    expect(mocks.updateNotification).not.toHaveBeenCalled();
  });
});

function request() {
  return new Request(
    "https://app.example.test/api/mobile/push/deliveries/delivery-one/acknowledge",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "push-open-delivery-one",
      },
      body: "{}",
    },
  );
}
