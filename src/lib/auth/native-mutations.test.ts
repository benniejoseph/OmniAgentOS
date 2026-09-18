import { describe, expect, it } from "vitest";

import {
  nativeMutationCapabilityPolicy,
  nativeMutationEnrollment,
} from "@/lib/auth/native-mutations";

const asOf = new Date("2026-09-15T08:00:00.000Z");

function context(
  contract: number,
  clientAttestedAt = "2026-09-15T07:59:00.000Z",
  platform: "android" | "ios" | "macos" = "android",
) {
  return {
    source: "mobile" as const,
    native: {
      deviceId: "device-one",
      platform,
      appVersion: "1.0.0",
      buildNumber: 2,
      clientContractVersion: contract,
      clientAttestedAt,
    },
  };
}

describe("native mutation capability enrollment", () => {
  it("retains existing capability floors on supported v14 and v15 clients", () => {
    expect(nativeMutationEnrollment(context(14), "markets.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(15), "settings.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(9), "markets.update", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(14), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(15), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(9), "markets.backtest.run", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 7,
    });
  });

  it("retains earlier workspace capability minimum on a supported client", () => {
    expect(nativeMutationEnrollment(context(14), "workspaces.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 3,
    });
    expect(
      nativeMutationCapabilityPolicy(context(14, new Date().toISOString()))[
        "settings.update"
      ].state,
    ).toBe("active");
  });

  it("gates the local Computer Use courier to v11 on macOS", () => {
    const capabilities = [
      "computer.use.device.update",
      "computer.use.command.claim",
      "computer.use.command.complete",
      "computer.use.stop",
    ] as const;
    for (const capability of capabilities) {
      expect(
        nativeMutationEnrollment(context(15, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(14, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(13, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "held", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(14), capability, asOf),
      ).toMatchObject({ state: "held", minimumContractVersion: 11 });
    }
  });

  it("enrolls typed push receipts and canaries only on contract v15", () => {
    for (const capability of [
      "push.delivery.receipt",
      "push.canary.run",
    ] as const) {
      expect(nativeMutationEnrollment(context(15), capability, asOf)).toMatchObject({
        state: "active",
        minimumContractVersion: 15,
      });
      expect(nativeMutationEnrollment(context(14), capability, asOf)).toMatchObject({
        state: "held",
        minimumContractVersion: 15,
      });
    }
  });
});
