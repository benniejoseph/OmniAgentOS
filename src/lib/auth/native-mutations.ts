import {
  evaluateNativeClientCompatibility,
  isFreshNativeClientAttestation,
} from "@/lib/auth/native-client-contract";
import { NATIVE_API_CURRENT_VERSION } from "@/lib/mobile/contracts";
import type { SecurityContext } from "@/lib/security/types";

export const NATIVE_MUTATION_CAPABILITIES = [
  "conversation.send",
  "notifications.update",
  "capture.submit",
  "capture.transcribe",
  "approvals.decide",
  "today.update",
  "workspaces.update",
  "markets.update",
  "markets.backtest.run",
  "settings.update",
  "evidence.cancel",
  "push.registration.update",
  "push.delivery.acknowledge",
  "push.delivery.receipt",
  "push.canary.run",
  "plugins.manage",
  "agents.create",
  "agents.update",
  "agents.moltbook.manage",
  "agents.tasks.cancel",
  "computer.use.device.update",
  "computer.use.command.claim",
  "computer.use.command.complete",
  "computer.use.stop",
] as const;

export type NativeMutationCapability =
  (typeof NATIVE_MUTATION_CAPABILITIES)[number];

export type NativeMutationEnrollment = Readonly<{
  state: "active" | "held";
  minimumContractVersion: number;
  reason?: string;
}>;

export function nativeMutationEnrollment(
  context: Pick<SecurityContext, "source" | "native">,
  capability: NativeMutationCapability,
  asOf = new Date(),
): NativeMutationEnrollment {
  if (!NATIVE_MUTATION_CAPABILITIES.includes(capability)) {
    return held("The native capability is not registered.");
  }
  if (context.source !== "mobile" || !context.native) {
    return held("An authenticated native session is required.");
  }
  const minimumContractVersion = minimumVersion(capability);
  if (
    capability.startsWith("computer.use.") &&
    context.native.platform !== "macos"
  ) {
    return held(
      "Local Computer Use is available only to the authenticated macOS installation.",
      minimumContractVersion,
    );
  }
  if (
    (context.native.clientContractVersion || 0) < minimumContractVersion ||
    evaluateNativeClientCompatibility(context.native) !== "compatible" ||
    !isFreshNativeClientAttestation(context.native.clientAttestedAt, asOf)
  ) {
    return held(
      `A fresh compatible client on native contract v${minimumContractVersion} or later is required.`,
      minimumContractVersion,
    );
  }
  return Object.freeze({
    state: "active",
    minimumContractVersion,
  });
}

export function nativeMutationCapabilityPolicy(
  context: Pick<SecurityContext, "source" | "native">,
) {
  return Object.freeze(
    Object.fromEntries(
      NATIVE_MUTATION_CAPABILITIES.map((capability) => [
        capability,
        nativeMutationEnrollment(context, capability),
      ]),
    ),
  );
}

function minimumVersion(capability: NativeMutationCapability) {
  if (capability.startsWith("computer.use.")) return 11;
  // Backtests were enrolled in v7. Keep that capability floor stable when the
  // current document advances; compatibility still independently limits calls
  // to the current and immediately previous native contracts.
  if (capability === "markets.backtest.run") return 7;
  if (
    capability === "push.registration.update" ||
    capability === "push.delivery.acknowledge"
  ) return 4;
  if (
    capability === "push.delivery.receipt" ||
    capability === "push.canary.run"
  ) return 15;
  if (capability === "plugins.manage") return 17;
  if (
    capability === "agents.create" ||
    capability === "agents.update" ||
    capability === "agents.moltbook.manage"
  ) return 19;
  if (capability === "agents.tasks.cancel") return 22;
  if (capability === "markets.update" || capability === "settings.update") return 6;
  return 3;
}

function held(
  reason: string,
  minimumContractVersion: number = NATIVE_API_CURRENT_VERSION,
): NativeMutationEnrollment {
  return Object.freeze({
    state: "held",
    minimumContractVersion,
    reason,
  });
}
