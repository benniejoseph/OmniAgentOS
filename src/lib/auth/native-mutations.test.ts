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
  it("retains the existing capability floors on supported v7 and v8 clients", () => {
    expect(nativeMutationEnrollment(context(7), "markets.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(7), "settings.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(6), "markets.update", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(7), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(8), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(6), "markets.backtest.run", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 7,
    });
  });

  it("retains earlier workspace capability minimum on a supported client", () => {
    expect(nativeMutationEnrollment(context(7), "workspaces.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 3,
    });
    expect(
      nativeMutationCapabilityPolicy(context(7, new Date().toISOString()))[
        "settings.update"
      ].state,
    ).toBe("active");
  });
});
