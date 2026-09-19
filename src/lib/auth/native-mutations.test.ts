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
  it("retains existing capability floors on supported v16 and v17 clients", () => {
    expect(nativeMutationEnrollment(context(16), "markets.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(17), "settings.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(9), "markets.update", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(16), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(17), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(9), "markets.backtest.run", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 7,
    });
  });

  it("retains earlier workspace capability minimum on a supported client", () => {
    expect(nativeMutationEnrollment(context(16), "workspaces.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 3,
    });
    expect(
      nativeMutationCapabilityPolicy(context(16, new Date().toISOString()))[
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
        nativeMutationEnrollment(context(17, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(16, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(15, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "held", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(16), capability, asOf),
      ).toMatchObject({ state: "held", minimumContractVersion: 11 });
    }
  });

  it("keeps typed push receipts and canaries active from contract v15", () => {
    for (const capability of [
      "push.delivery.receipt",
      "push.canary.run",
    ] as const) {
      expect(nativeMutationEnrollment(context(16), capability, asOf)).toMatchObject({
        state: "active",
        minimumContractVersion: 15,
      });
      expect(nativeMutationEnrollment(context(17), capability, asOf)).toMatchObject({
        state: "active",
        minimumContractVersion: 15,
      });
      expect(nativeMutationEnrollment(context(14), capability, asOf)).toMatchObject({
        state: "held",
        minimumContractVersion: 15,
      });
    }
  });

  it("enrolls governed Plugin lifecycle only on contract v17", () => {
    expect(
      nativeMutationEnrollment(context(17), "plugins.manage", asOf),
    ).toMatchObject({ state: "active", minimumContractVersion: 17 });
    expect(
      nativeMutationEnrollment(context(16), "plugins.manage", asOf),
    ).toMatchObject({ state: "held", minimumContractVersion: 17 });
  });
});
