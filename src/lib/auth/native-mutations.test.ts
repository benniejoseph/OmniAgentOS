import { describe, expect, it } from "vitest";

import {
  nativeMutationCapabilityPolicy,
  nativeMutationEnrollment,
} from "@/lib/auth/native-mutations";

const asOf = new Date("2026-09-15T08:00:00.000Z");

function context(
  contract: number,
  clientAttestedAt = "2026-09-15T07:59:00.000Z",
) {
  return {
    source: "mobile" as const,
    native: {
      deviceId: "device-one",
      platform: "android" as const,
      appVersion: "1.0.0",
      buildNumber: 2,
      clientContractVersion: contract,
      clientAttestedAt,
    },
  };
}

describe("native mutation capability enrollment", () => {
  it("enrolls market and settings mutations only on contract v6", () => {
    expect(nativeMutationEnrollment(context(6), "markets.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(6), "settings.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(5), "markets.update", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 6,
    });
  });

  it("retains earlier workspace mutation compatibility", () => {
    expect(nativeMutationEnrollment(context(5), "workspaces.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 3,
    });
    expect(
      nativeMutationCapabilityPolicy(context(6, new Date().toISOString()))[
        "settings.update"
      ].state,
    ).toBe("active");
  });
});
