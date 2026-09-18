import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  listMobilePushDevices: vi.fn(),
  registerMobilePushDevice: vi.fn(),
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
  listMobilePushDevices: mocks.listMobilePushDevices,
  registerMobilePushDevice: mocks.registerMobilePushDevice,
}));

import { GET, POST } from "@/app/api/mobile/push/registrations/route";

const context = {
  tenantId: "tenant-one",
  actorId: "operator@example.test",
  role: "operator" as const,
  source: "mobile" as const,
  auth: {
    userId: "user-one",
    email: "operator@example.test",
    sessionId: "session-one",
    tenantName: "Example",
  },
  native: {
    deviceId: "device-one",
    platform: "android" as const,
    appVersion: "1.0.0",
    buildNumber: 1,
    clientContractVersion: 4,
    clientAttestedAt: new Date().toISOString(),
  },
};

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue(context);
  mocks.listMobilePushDevices.mockReset().mockResolvedValue({
    schemaVersion: 1,
    registrations: [],
    providers: { apns: "configuration_required", fcm: "configured" },
  });
  mocks.registerMobilePushDevice.mockReset().mockResolvedValue({
    schemaVersion: 1,
    changed: true,
    providers: { apns: "configuration_required", fcm: "configured" },
    registration: {
      id: "mobile-push-registration-one",
      deviceId: "device-one",
      platform: "android",
      provider: "fcm",
      environment: "production",
      previewPolicy: "generic",
      state: "active",
      lifecycleRevision: 1,
      lastRegisteredAt: "2026-09-08T00:00:00.000Z",
      lastDeliveredAt: null,
      revokedAt: null,
    },
  });
});

describe("mobile push registrations route", () => {
  it("keeps provider tokens out of bounded registration responses", async () => {
    const token = `fcm-${"a".repeat(40)}`;
    const response = await POST(new Request(
      "https://app.example.test/api/mobile/push/registrations",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "push-register-device-one",
        },
        body: JSON.stringify({
          provider: "fcm",
          environment: "production",
          token,
          previewPolicy: "generic",
        }),
      },
    ));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(JSON.stringify(body)).not.toContain(token);
    expect(mocks.registerMobilePushDevice).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        token,
        idempotencyKey: "push-register-device-one",
      }),
    );
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeMutationCapability: "push.registration.update",
      }),
    );
  });

  it("rejects malformed input before authorization", async () => {
    const response = await POST(new Request(
      "https://app.example.test/api/mobile/push/registrations",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider: "fcm", token: "short" }),
      },
    ));
    expect(response.status).toBe(400);
    expect(mocks.authorizeRequest).not.toHaveBeenCalled();
  });

  it("lists only the current installation registrations", async () => {
    const response = await GET(new Request(
      "https://app.example.test/api/mobile/push/registrations",
    ));
    expect(response.status).toBe(200);
    expect(mocks.listMobilePushDevices).toHaveBeenCalledWith(context);
  });
});
