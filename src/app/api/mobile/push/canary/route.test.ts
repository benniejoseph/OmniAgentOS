import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listTargets: vi.fn(),
  runCanary: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
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
  listMobilePushCanaryTargets: mocks.listTargets,
  runMobilePushReceiptCanary: mocks.runCanary,
}));

import { GET, maxDuration, POST } from "@/app/api/mobile/push/canary/route";

const timestamp = "2026-09-18T12:00:00.000Z";
const context = {
  tenantId: "tenant-one",
  actorId: "operator@example.test",
  role: "operator" as const,
  source: "browser" as const,
};

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.listTargets.mockReset().mockResolvedValue({
    schemaVersion: 1,
    registrations: [{
      id: "registration-one",
      deviceId: "device-one",
      platform: "macos",
      provider: "apns",
      environment: "production",
      previewPolicy: "generic",
      state: "active",
      lifecycleRevision: 1,
      lastRegisteredAt: timestamp,
      lastDeliveredAt: null,
      revokedAt: null,
    }],
    providers: { apns: "configured", fcm: "configuration_required" },
  });
  mocks.runCanary.mockReset().mockResolvedValue({
    schemaVersion: 1,
    canaryId: "canary-one",
    deliveryId: "delivery-one",
    outcome: "timed_out",
    timedOut: true,
    state: {
      id: "delivery-one",
      notificationId: null,
      causeKind: "canary",
      causeId: "canary-one",
      deepLink: "/settings?pushCanary=canary-one",
      providerState: "accepted",
      providerAcceptedAt: timestamp,
      appState: "none",
      receivedAt: null,
      openedAt: null,
      lastAction: null,
      failureCode: null,
    },
  });
});

describe("mobile push receipt canary route", () => {
  it("keeps platform runtime above provider and maximum receipt budgets", () => {
    expect(maxDuration).toBeGreaterThanOrEqual(45);
  });

  it("lists only the authorized actor's eligible registrations", async () => {
    const response = await GET(new Request(
      "https://app.example.test/api/mobile/push/canary",
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      registrations: [{ id: "registration-one", platform: "macos" }],
    });
    expect(mocks.listTargets).toHaveBeenCalledWith(context);
  });

  it("reports provider acceptance separately from an app-receipt timeout", async () => {
    const response = await POST(new Request(
      "https://app.example.test/api/mobile/push/canary",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "canary-registration-one",
        },
        body: JSON.stringify({
          registrationId: "registration-one",
          timeoutSeconds: 3,
        }),
      },
    ));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: "timed_out",
      timedOut: true,
      state: { providerState: "accepted", appState: "none" },
    });
    expect(mocks.runCanary).toHaveBeenCalledWith(
      context,
      "canary-registration-one",
      { registrationId: "registration-one", timeoutMs: 3_000 },
    );
    expect(mocks.authorizeRequest).toHaveBeenLastCalledWith(expect.objectContaining({
      nativeMutationCapability: "push.canary.run",
    }));
  });

  it("rejects an excessive wait before authorization", async () => {
    const response = await POST(new Request(
      "https://app.example.test/api/mobile/push/canary",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timeoutSeconds: 60 }),
      },
    ));
    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });
});
