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
  "settings.update",
  "evidence.cancel",
  "push.registration.update",
  "push.delivery.acknowledge",
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
  return capability === "push.registration.update" ||
      capability === "push.delivery.acknowledge" ||
      capability === "markets.update" ||
      capability === "settings.update"
    ? NATIVE_API_CURRENT_VERSION
    : 3;
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
