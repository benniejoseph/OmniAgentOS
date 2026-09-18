import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asaelNotificationCategory,
  deliverMobilePush,
  mobilePushProviderConfiguration,
} from "@/lib/mobile/push-providers";

vi.mock("node:crypto", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:crypto")>()),
  createSign: () => ({
    update: () => undefined,
    end: () => undefined,
    sign: () => Buffer.from("provider-signature"),
  }),
}));

const names = [
  "OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON",
  "OMNIAGENT_APNS_TEAM_ID",
  "OMNIAGENT_APNS_KEY_ID",
  "OMNIAGENT_APNS_BUNDLE_ID",
  "OMNIAGENT_APNS_PRIVATE_KEY",
] as const;
const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));

afterEach(() => {
  vi.unstubAllGlobals();
  for (const name of names) {
    const value = original[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("mobile push provider configuration", () => {
  it("pins the native actionable category across providers", () => {
    expect(asaelNotificationCategory).toBe("ASAEL_ACTIONABLE_V1");
  });
  it("fails closed without complete server credentials", () => {
    for (const name of names) delete process.env[name];
    expect(mobilePushProviderConfiguration()).toEqual({
      apns: "configuration_required",
      fcm: "configuration_required",
    });
  });

  it("reports only structurally complete providers", () => {
    process.env.OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "asael-project",
      client_email: "push@example.test",
      private_key: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    });
    process.env.OMNIAGENT_APNS_TEAM_ID = "TEAM123456";
    process.env.OMNIAGENT_APNS_KEY_ID = "KEY1234567";
    process.env.OMNIAGENT_APNS_BUNDLE_ID = "app.omniagent.omniagent";
    process.env.OMNIAGENT_APNS_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\\nfixture\\n-----END PRIVATE KEY-----";
    expect(mobilePushProviderConfiguration()).toEqual({
      apns: "configured",
      fcm: "configured",
    });
  });

  it("sends Android through the data-only handler with causal actions", async () => {
    process.env.OMNIAGENT_FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: "asael-push-test",
      client_email: "push@example.test",
      private_key: "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----",
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: "oauth-token",
        expires_in: 3_600,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "projects/asael-push-test/messages/provider-one",
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        name: "projects/asael-push-test/messages/provider-two",
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(deliverMobilePush({
      provider: "fcm",
      environment: "production",
      token: `fcm-${"a".repeat(40)}`,
      target: { kind: "approval", id: "approval-one" },
      envelope: {
        schemaVersion: "1",
        deliveryId: "delivery-one",
        notificationId: "notification-one",
        causeKind: "approval",
        causeId: "approval-one",
        deepLink: "/inbox/approvals/approval-one",
      },
      previewPolicy: "generic",
    })).resolves.toEqual({
      messageId: "projects/asael-push-test/messages/provider-one",
    });

    const request = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body.message.notification).toBeUndefined();
    expect(body.message.data).toMatchObject({
      deliveryId: "delivery-one",
      causeKind: "approval",
      asaelTitle: "Asael",
      asaelCategory: "ASAEL_ACTIONABLE_V1",
    });
    expect(body.message.apns.payload.aps).toMatchObject({
      category: "ASAEL_ACTIONABLE_V1",
      "content-available": 1,
    });

    await expect(deliverMobilePush({
      provider: "fcm",
      environment: "production",
      token: `fcm-${"b".repeat(40)}`,
      target: { kind: "canary", id: "canary-one" },
      envelope: {
        schemaVersion: "1",
        deliveryId: "delivery-two",
        causeKind: "canary",
        causeId: "canary-one",
        deepLink: "/settings?pushCanary=canary-one",
      },
      previewPolicy: "generic",
    })).resolves.toEqual({
      messageId: "projects/asael-push-test/messages/provider-two",
    });

    const openOnlyRequest = fetchMock.mock.calls[2]?.[1] as RequestInit;
    const openOnlyBody = JSON.parse(String(openOnlyRequest.body));
    expect(openOnlyBody.message.data).toMatchObject({
      deliveryId: "delivery-two",
      asaelTitle: "Asael",
      asaelBody: "Push notification verification is ready.",
    });
    expect(openOnlyBody.message.data.asaelCategory).toBeUndefined();
    expect(openOnlyBody.message.apns.payload.aps.category).toBeUndefined();
  });
});
