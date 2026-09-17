import { afterEach, describe, expect, it } from "vitest";
import {
  evaluateNativeClientCompatibility,
  isStableNativeVersion,
  nativeClientCompatibility,
  nativeClientPolicy,
} from "@/lib/auth/native-client-contract";

afterEach(() => {
  delete process.env.OMNIAGENT_NATIVE_MIN_ANDROID_VERSION;
  delete process.env.OMNIAGENT_NATIVE_MIN_IOS_VERSION;
  delete process.env.OMNIAGENT_NATIVE_MIN_MACOS_VERSION;
});

describe("native client compatibility contract", () => {
  it("accepts only normalized stable release versions", () => {
    expect(isStableNativeVersion("1.2.3")).toBe(true);
    expect(isStableNativeVersion("01.2.3")).toBe(false);
    expect(isStableNativeVersion("1.2.3-beta.1")).toBe(false);
    expect(isStableNativeVersion(" 1.2.3")).toBe(false);
  });

  it("keeps legacy and future contracts out while retaining the previous version", () => {
    expect(evaluateNativeClientCompatibility({
      platform: "ios",
      appVersion: "1.0.0",
    })).toBe("unknown");
    expect(evaluateNativeClientCompatibility({
      platform: "ios",
      appVersion: "1.0.0",
      buildNumber: 1,
      clientContractVersion: 13,
    })).toBe("unknown");
    expect(evaluateNativeClientCompatibility({
      platform: "ios",
      appVersion: "1.0.0",
      buildNumber: 1,
      clientContractVersion: 7,
    })).toBe("upgrade_required");
    expect(evaluateNativeClientCompatibility({
      platform: "macos",
      appVersion: "1.0.0",
      buildNumber: 1,
      clientContractVersion: 11,
    })).toBe("compatible");
    expect(evaluateNativeClientCompatibility({
      platform: "macos",
      appVersion: "1.0.0",
      buildNumber: 1,
      clientContractVersion: 10,
    })).toBe("upgrade_required");
  });

  it("applies the server-owned platform minimum without enrolling Agents", () => {
    process.env.OMNIAGENT_NATIVE_MIN_ANDROID_VERSION = "2.0.0";
    expect(evaluateNativeClientCompatibility({
      platform: "android",
      appVersion: "1.9.9",
      buildNumber: 20,
      clientContractVersion: 12,
    })).toBe("upgrade_required");
    expect(nativeClientPolicy().agentCatalogEnrollment.state).toBe("held");
  });

  it("uses the default policy only when minimums are absent", () => {
    expect(nativeClientPolicy()).toMatchObject({
      configurationStatus: "valid",
      minimumVersions: {
        android: "1.0.0",
        ios: "1.0.0",
        macos: "1.0.0",
      },
    });
    process.env.OMNIAGENT_NATIVE_MIN_IOS_VERSION = "latest";
    expect(nativeClientPolicy()).toMatchObject({
      configurationStatus: "invalid",
      minimumVersions: {
        android: "1.0.0",
        ios: null,
        macos: "1.0.0",
      },
    });
  });

  it("requires fresh server-observed attestation for compatibility", () => {
    const client = {
      platform: "ios" as const,
      appVersion: "1.0.0",
      buildNumber: 1,
      clientContractVersion: 11,
    };
    const asOf = new Date("2026-09-04T12:00:00.000Z");
    expect(nativeClientCompatibility(client, { asOf }).status).toBe("unknown");
    expect(nativeClientCompatibility(client, {
      asOf,
      clientAttestedAt: "2026-09-04T11:59:00.000Z",
    }).status).toBe("compatible");
    expect(nativeClientCompatibility(client, {
      asOf,
      clientAttestedAt: "2026-07-01T00:00:00.000Z",
    }).status).toBe("unknown");
  });
});
