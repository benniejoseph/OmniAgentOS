import { describe, expect, it } from "vitest";
import {
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
  nativeBootstrapResponseSchema,
  nativeContractDiscovery,
  nativeContractSchemas,
  nativeConversationEventSchema,
  nativeLoginRequestSchema,
  nativeOperationsForVersion,
} from "@/lib/mobile/contracts";

describe("native API contracts", () => {
  it("retains exactly the current and previous rollout versions", () => {
    expect(NATIVE_API_CURRENT_VERSION).toBe(2);
    expect(NATIVE_API_PREVIOUS_VERSION).toBe(1);
    expect(nativeOperationsForVersion(2)?.length).toBeGreaterThan(
      nativeOperationsForVersion(1)?.length || 0,
    );
    expect(nativeOperationsForVersion(3)).toBeUndefined();
    expect(nativeContractSchemas.NativeContractDiscovery.parse(
      nativeContractDiscovery(),
    ).supportedVersions).toEqual([2, 1]);
  });

  it("accepts current and previous device envelopes but rejects partial attestation", () => {
    const request = {
      email: "operator@example.test",
      password: "fixture-password",
      device: {
        id: "asael-fixture-device",
        name: "Asael on iOS",
        platform: "ios",
        appVersion: "1.0.0",
        buildNumber: 2,
        clientContractVersion: 2,
      },
    };
    expect(nativeLoginRequestSchema.safeParse(request).success).toBe(true);
    expect(nativeLoginRequestSchema.safeParse({
      ...request,
      device: { ...request.device, clientContractVersion: 1 },
    }).success).toBe(true);
    expect(nativeLoginRequestSchema.safeParse({
      ...request,
      device: { ...request.device, buildNumber: undefined },
    }).success).toBe(false);
  });

  it("publishes a discriminated event contract for every streamed event family", () => {
    expect(nativeConversationEventSchema.parse({
      type: "waiting_approval",
      executionId: "execution-one",
      toolId: "calendar.event.create",
      message: "Approval is required.",
    }).type).toBe("waiting_approval");
    expect(nativeConversationEventSchema.safeParse({
      type: "invented_event",
      content: "untrusted",
    }).success).toBe(false);
  });

  it("requires bootstrap to advertise the authoritative contract rollout", () => {
    const timestamp = "2026-09-08T08:00:00.000Z";
    const identity = {
      context: {
        tenantId: "tenant-one",
        actorId: "operator@example.test",
        role: "operator",
        source: "mobile",
        auth: {
          userId: "user-one",
          email: "operator@example.test",
          sessionId: "session-one",
          tenantName: "Example",
        },
      },
      user: { id: "user-one", email: "operator@example.test", status: "active", createdAt: timestamp, updatedAt: timestamp },
      tenant: { id: "tenant-one", name: "Example", slug: "example", createdAt: timestamp, updatedAt: timestamp },
      membership: { id: "membership-one", tenantId: "tenant-one", userId: "user-one", role: "operator", status: "active", createdAt: timestamp, updatedAt: timestamp },
      device: { id: "device-one", name: "Asael on iOS", platform: "ios", appVersion: "1.0.0", buildNumber: 2, clientContractVersion: 2 },
    };
    expect(nativeBootstrapResponseSchema.parse({
      authenticated: true,
      ...identity,
      permissions: ["read"],
      api: {
        version: 1,
        basePath: "/api",
        mobileBasePath: "/api/mobile",
        nativeContract: {
          id: "asael.native-api",
          currentVersion: 2,
          previousVersion: 1,
          supportedVersions: [2, 1],
          discoveryPath: "/api/mobile/contracts",
        },
      },
      client: {
        schemaVersion: 1,
        platform: "ios",
        appVersion: "1.0.0",
        buildNumber: 2,
        clientContractVersion: 2,
        minimumVersion: "1.0.0",
        requiredContractVersion: 2,
        supportedContractVersions: [2, 1],
        status: "compatible",
        agentCatalogEnrollment: { state: "held", clientReady: true },
      },
      nativeClientPolicy: { schemaVersion: 1 },
    }).api.nativeContract.currentVersion).toBe(2);
  });
});
