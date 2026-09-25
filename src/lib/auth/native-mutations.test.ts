import { describe, expect, it } from "vitest";

import {
  nativeMutationCapabilityPolicy,
  nativeMutationEnrollment,
} from "@/lib/auth/native-mutations";
import {
  NATIVE_API_CURRENT_VERSION,
  NATIVE_API_PREVIOUS_VERSION,
} from "@/lib/mobile/contracts";

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
  it("retains existing capability floors on both supported clients", () => {
    expect(nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION), "markets.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(NATIVE_API_CURRENT_VERSION), "settings.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION - 1), "markets.update", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 6,
    });
    expect(nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(NATIVE_API_CURRENT_VERSION), "markets.backtest.run", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 7,
    });
    expect(nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION - 1), "markets.backtest.run", asOf)).toMatchObject({
      state: "held",
      minimumContractVersion: 7,
    });
  });

  it("retains earlier workspace capability minimum on a supported client", () => {
    expect(nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION), "workspaces.update", asOf)).toMatchObject({
      state: "active",
      minimumContractVersion: 3,
    });
    expect(
      nativeMutationCapabilityPolicy(context(NATIVE_API_PREVIOUS_VERSION, new Date().toISOString()))[
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
        nativeMutationEnrollment(context(NATIVE_API_CURRENT_VERSION, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION - 1, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "held", minimumContractVersion: 11 });
      expect(
        nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION), capability, asOf),
      ).toMatchObject({ state: "held", minimumContractVersion: 11 });
    }
  });

  it("keeps typed push receipts and canaries active from contract v15", () => {
    for (const capability of [
      "push.delivery.receipt",
      "push.canary.run",
    ] as const) {
      expect(nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION), capability, asOf)).toMatchObject({
        state: "active",
        minimumContractVersion: 15,
      });
      expect(nativeMutationEnrollment(context(NATIVE_API_CURRENT_VERSION), capability, asOf)).toMatchObject({
        state: "active",
        minimumContractVersion: 15,
      });
      expect(nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION - 1), capability, asOf)).toMatchObject({
        state: "held",
        minimumContractVersion: 15,
      });
    }
  });

  it("retains the governed Plugin lifecycle floor on supported clients", () => {
    expect(
      nativeMutationEnrollment(context(NATIVE_API_CURRENT_VERSION), "plugins.manage", asOf),
    ).toMatchObject({ state: "active", minimumContractVersion: 17 });
    expect(
      nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION), "plugins.manage", asOf),
    ).toMatchObject({ state: "active", minimumContractVersion: 17 });
    expect(
      nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION - 1), "plugins.manage", asOf),
    ).toMatchObject({ state: "held", minimumContractVersion: 17 });
  });

  it("retains the scoped Agent mutations on both supported clients", () => {
    const capabilities = [
      "agents.create",
      "agents.update",
      "agents.moltbook.manage",
    ] as const;

    for (const capability of capabilities) {
      expect(
        nativeMutationEnrollment(context(NATIVE_API_CURRENT_VERSION, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 19 });
      expect(
        nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "active", minimumContractVersion: 19 });
      expect(
        nativeMutationEnrollment(context(NATIVE_API_PREVIOUS_VERSION - 1, undefined, "macos"), capability, asOf),
      ).toMatchObject({ state: "held", minimumContractVersion: 19 });
    }

    const policy = nativeMutationCapabilityPolicy(
      context(NATIVE_API_CURRENT_VERSION, undefined, "macos"),
    );
    expect(Object.keys(policy)).toEqual(
      expect.arrayContaining([...capabilities]),
    );
    expect(policy).not.toHaveProperty("agents.delete");
  });

  it("retains exact child cancellation on both supported clients", () => {
    for (const platform of ["android", "macos"] as const) {
      expect(
        nativeMutationEnrollment(
          context(NATIVE_API_CURRENT_VERSION, undefined, platform),
          "agents.tasks.cancel",
          asOf,
        ),
      ).toMatchObject({ state: "active", minimumContractVersion: 22 });
      expect(
        nativeMutationEnrollment(
          context(NATIVE_API_PREVIOUS_VERSION, undefined, platform),
          "agents.tasks.cancel",
          asOf,
        ),
      ).toMatchObject({ state: "active", minimumContractVersion: 22 });
      expect(
        nativeMutationEnrollment(
          context(22 - 1, undefined, platform),
          "agents.tasks.cancel",
          asOf,
        ),
      ).toMatchObject({ state: "held", minimumContractVersion: 22 });
    }
  });

  it("enrolls prompt queue mutations only on native v24", () => {
    for (const platform of ["android", "macos"] as const) {
      expect(
        nativeMutationEnrollment(
          context(NATIVE_API_CURRENT_VERSION, undefined, platform),
          "prompt.queue.manage",
          asOf,
        ),
      ).toMatchObject({ state: "active", minimumContractVersion: 24 });
      expect(
        nativeMutationEnrollment(
          context(NATIVE_API_PREVIOUS_VERSION, undefined, platform),
          "prompt.queue.manage",
          asOf,
        ),
      ).toMatchObject({ state: "active", minimumContractVersion: 24 });
      expect(
        nativeMutationEnrollment(
          context(24 - 1, undefined, platform),
          "prompt.queue.manage",
          asOf,
        ),
      ).toMatchObject({ state: "held", minimumContractVersion: 24 });
    }
  });

  it("enrolls governed release and adaptation changes only on native v25", () => {
    for (const capability of [
      "agents.release.manage",
      "agents.adaptations.manage",
    ] as const) {
      expect(
        nativeMutationEnrollment(
          context(NATIVE_API_CURRENT_VERSION, undefined, "macos"),
          capability,
          asOf,
        ),
      ).toMatchObject({ state: "active", minimumContractVersion: 25 });
      expect(
        nativeMutationEnrollment(
          context(NATIVE_API_PREVIOUS_VERSION, undefined, "macos"),
          capability,
          asOf,
        ),
      ).toMatchObject({ state: "active", minimumContractVersion: 25 });
      expect(
        nativeMutationEnrollment(
          context(25 - 1, undefined, "macos"),
          capability,
          asOf,
        ),
      ).toMatchObject({ state: "held", minimumContractVersion: 25 });
    }
    expect(
      nativeMutationCapabilityPolicy(
        context(NATIVE_API_CURRENT_VERSION, undefined, "macos"),
      ),
    ).not.toHaveProperty("agents.release.retire");
  });
});
