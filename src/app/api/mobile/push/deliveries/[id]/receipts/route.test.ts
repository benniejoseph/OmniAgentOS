import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getCandidate: vi.fn(),
  recordReceipt: vi.fn(),
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
  recordMobilePushDeliveryReceipt: mocks.recordReceipt,
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

import { POST } from "@/app/api/mobile/push/deliveries/[id]/receipts/route";

const observedAt = "2026-09-18T12:00:00.000Z";
const context = {
  tenantId: "tenant-one",
  actorId: "operator@example.test",
  role: "operator" as const,
  source: "mobile" as const,
};
const candidate = {
  id: "delivery-one",
  status: "delivered" as const,
  notificationId: "notification-one",
  target: { kind: "meeting" as const, id: "meeting-one" },
  deepLink: "/meetings/meeting-one",
};
const recordedResult = {
  newlyRecorded: true,
  receipt: {
    id: "receipt-one",
    kind: "opened" as const,
    appLifecycle: "terminated" as const,
    platform: "macos" as const,
    observedAt,
    recordedAt: observedAt,
  },
  delivery: {
    id: "delivery-one",
    notificationId: "notification-one",
    causeKind: "meeting" as const,
    causeId: "meeting-one",
    deepLink: "/meetings/meeting-one",
    providerState: "accepted" as const,
    providerAcceptedAt: observedAt,
    appState: "opened" as const,
    receivedAt: observedAt,
    openedAt: observedAt,
    lastAction: null,
    failureCode: null,
  },
};

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.getCandidate.mockReset().mockResolvedValue(candidate);
  mocks.updateNotification.mockReset().mockResolvedValue({ id: "notification-one" });
  mocks.recordReceipt.mockReset().mockResolvedValue(recordedResult);
});

describe("mobile push receipt route", () => {
  it("records an installation-scoped open and advances its notification", async () => {
    const response = await POST(request({
      schemaVersion: 1,
      kind: "opened",
      observedAt,
      appLifecycle: "terminated",
    }), { params: Promise.resolve({ id: "delivery-one" }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      schemaVersion: 1,
      recorded: true,
      newlyRecorded: true,
      receipt: { kind: "opened", platform: "macos" },
      delivery: { providerState: "accepted", appState: "opened" },
    });
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      resourceId: "delivery-one",
      nativeMutationCapability: "push.delivery.receipt",
    }));
    expect(mocks.updateNotification).toHaveBeenCalledWith(
      "notification-one",
      "read",
      expect.objectContaining({
        tenantId: "tenant-one",
        actorId: "operator@example.test",
        onlyIfUnread: true,
      }),
    );
    expect(mocks.recordReceipt).toHaveBeenCalledWith(
      context,
      "delivery-one",
      expect.objectContaining({ kind: "opened" }),
      "receipt-open-delivery-one",
    );
  });

  it("records receipt-only evidence without treating provider acceptance as an open", async () => {
    mocks.recordReceipt.mockResolvedValue({
      ...recordedResult,
      receipt: {
        ...recordedResult.receipt,
        kind: "received",
        appLifecycle: "background",
      },
      delivery: {
        ...recordedResult.delivery,
        appState: "received",
        openedAt: null,
      },
    });
    const response = await POST(request({
      schemaVersion: 1,
      kind: "received",
      observedAt,
      appLifecycle: "background",
    }), { params: Promise.resolve({ id: "delivery-one" }) });

    expect(response.status).toBe(200);
    expect(mocks.updateNotification).not.toHaveBeenCalled();
  });

  it("rejects malformed action receipts before authorization", async () => {
    const response = await POST(request({
      schemaVersion: 1,
      kind: "action",
      observedAt,
      appLifecycle: "foreground",
    }), { params: Promise.resolve({ id: "delivery-one" }) });
    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });
});

function request(body: unknown) {
  return new Request(
    "https://app.example.test/api/mobile/push/deliveries/delivery-one/receipts",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "receipt-open-delivery-one",
      },
      body: JSON.stringify(body),
    },
  );
}
