import {
  evaluateNativeClientCompatibility,
  isFreshNativeClientAttestation,
} from "@/lib/auth/native-client-contract";
import { NATIVE_API_CURRENT_VERSION } from "@/lib/mobile/contracts";
import type { SecurityContext } from "@/lib/security/types";

export const NATIVE_MUTATION_CAPABILITIES = [
  "conversation.send",
  "prompt.queue.manage",
  "notifications.update",
  "capture.submit",
  "capture.transcribe",
  "approvals.decide",
  "today.update",
  "workspaces.update",
  "markets.update",
  "markets.backtest.run",
  "settings.update",
  "companion.preferences.update",
  "responsibilities.drafts.manage",
  "responsibilities.lifecycle.manage",
  "responsibilities.notifications.manage",
  "meetings.records.manage",
  "customers.records.manage",
  "customers.health.evaluate",
  "customers.facts.mutate",
  "customers.salesforce.manage",
  "knowledge.cognification.decide",
  "knowledge.cognification.build",
  "knowledge.sources.delete",
  "memory.maintenance.run",
  "memory.graph.rebuild",
  "meetings.recordings.process",
  "customers.workflows.start",
  "customers.workflows.outcomes.manage",
  "memory.records.write",
  "memory.lifecycle.write",
  "memory.reconciliation.resolve",
  "memory.promotions.decide",
  "memory.personal-context-consent.manage",
  "meetings.calendar.sync",
  "meetings.commitments.propose",
  "meetings.commitments.resolve",
  "evidence.cancel",
  "push.registration.update",
  "push.delivery.acknowledge",
  "push.delivery.receipt",
  "push.canary.run",
  "plugins.manage",
  "google.personal.manage",
  "connectors.manage",
  "agents.create",
  "agents.update",
  "agents.delete",
  "skills.create",
  "skills.update",
  "skills.delete",
  "agents.moltbook.manage",
  "agents.tasks.cancel",
  "agents.release.manage",
  "agents.adaptations.manage",
  "computer.use.device.update",
  "computer.use.command.claim",
  "computer.use.command.complete",
  "computer.use.stop",
  "voice.session.manage",
  "voice.speech.stream",
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
  if (capability === "google.personal.manage" || capability === "connectors.manage") return 40;
  if (capability === "memory.maintenance.run" || capability === "memory.graph.rebuild") return 38;
  if (capability === "knowledge.sources.delete") return 38;
  if (capability === "knowledge.cognification.decide" || capability === "knowledge.cognification.build") return 38;
  if (capability === "customers.salesforce.manage") return 38;
  if (capability === "customers.facts.mutate" || capability === "meetings.recordings.process") return 38;
  if (capability === "agents.delete" || capability === "skills.create" ||
    capability === "skills.update" || capability === "skills.delete") return 38;
  if (capability === "customers.workflows.start" || capability === "customers.workflows.outcomes.manage") return 38;
  if (capability === "memory.promotions.decide") return 38;
  if (capability === "customers.health.evaluate") return 37;
  if (capability === "memory.personal-context-consent.manage" || capability === "meetings.calendar.sync") return 36;
  if (capability === "memory.reconciliation.resolve") return 35;
  if (capability === "customers.records.manage" || capability === "memory.records.write" ||
    capability === "memory.lifecycle.write") return 34;
  if (capability === "meetings.records.manage" || capability === "meetings.commitments.propose" ||
    capability === "meetings.commitments.resolve") return 33;
  if (capability === "responsibilities.drafts.manage" || capability === "responsibilities.lifecycle.manage" ||
    capability === "responsibilities.notifications.manage") return 32;
  if (capability === "companion.preferences.update") return 31;
  if (
    capability === "voice.session.manage" ||
    capability === "voice.speech.stream"
  ) return 29;
  if (capability === "prompt.queue.manage") return 24;
  if (
    capability === "agents.release.manage" ||
    capability === "agents.adaptations.manage"
  ) return 25;
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
