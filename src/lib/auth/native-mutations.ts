import {
  evaluateNativeClientCompatibility,
  isFreshNativeClientAttestation,
} from "@/lib/auth/native-client-contract";
import { NATIVE_API_CURRENT_VERSION } from "@/lib/mobile/contracts";
import type { SecurityContext } from "@/lib/security/types";

export const NATIVE_MUTATION_CAPABILITIES = ["conversation.send"] as const;

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
  if (
    context.native.clientContractVersion !== NATIVE_API_CURRENT_VERSION ||
    evaluateNativeClientCompatibility(context.native) !== "compatible" ||
    !isFreshNativeClientAttestation(context.native.clientAttestedAt, asOf)
  ) {
    return held("A fresh client on the current native contract is required.");
  }
  return Object.freeze({
    state: "active",
    minimumContractVersion: NATIVE_API_CURRENT_VERSION,
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

function held(reason: string): NativeMutationEnrollment {
  return Object.freeze({
    state: "held",
    minimumContractVersion: NATIVE_API_CURRENT_VERSION,
    reason,
  });
}
