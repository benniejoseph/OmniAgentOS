import { createHash } from "node:crypto";
import { z } from "zod";

import {
  localComputerFailureMetadata,
  readLocalComputerFailureMetadata,
  type LocalComputerFailureMetadata,
} from "@/lib/local-computer/command-failure";
import { redactSensitive } from "@/lib/security/context";

const snapshotActions = new Set([
  "local.macos.click", "local.macos.press", "local.macos.type",
  "local.macos.key", "local.macos.scroll",
]);
const revisionPattern = /^[a-f0-9]{64}$/;
const maximumConsecutiveRefusals = 3;
const maximumRememberedTargets = 16;

type FailedTarget = {
  fingerprint: string;
  refusals: number;
  failure: LocalComputerFailureMetadata;
};

/**
 * One denial-only episode per tenant/actor/run on the selected-Mac surface.
 * The native router still resolves the actual device and validates snapshots;
 * switching devices does not grant another retry budget inside the same run.
 */
export type LocalComputerRecoveryState = {
  schemaVersion: 1;
  consecutiveRefusals: number;
  observationRequired: boolean;
  refusedRevision?: string;
  latestObservationRevision?: string;
  stopped: boolean;
  failedTargets: FailedTarget[];
};

export function createLocalComputerRecoveryState(): LocalComputerRecoveryState {
  return {
    schemaVersion: 1, consecutiveRefusals: 0, observationRequired: false,
    stopped: false, failedTargets: [],
  };
}

export type LocalComputerRecoveryScope = Readonly<{
  tenantId: string; actorId: string; runId: string;
}>;

function scopeDigest(scope: LocalComputerRecoveryScope): string {
  const identities = [scope.tenantId, scope.actorId, scope.runId];
  if (identities.some((value) => typeof value !== "string" || !value.trim() || value.length > 256)) {
    throw new Error("Local Computer recovery requires an exact tenant, actor and run scope.");
  }
  return createHash("sha256").update(JSON.stringify(["local-computer-recovery:v1", ...identities])).digest("hex");
}

const savedFailureSchema = z.object({
  schemaVersion: z.literal(1), code: z.string().max(64),
  phase: z.string().max(64), reason: z.string().max(80),
}).strict().transform((value, context) => {
  const failure = readLocalComputerFailureMetadata(value);
  if (!failure || failure.phase !== value.phase || failure.reason !== value.reason) {
    context.addIssue({ code: "custom", message: "Invalid saved native refusal." });
    return z.NEVER;
  }
  return failure;
});
const snapshotSchema = z.object({
  schemaVersion: z.literal(1), scopeSha256: z.string().regex(revisionPattern),
  consecutiveRefusals: z.number().int().min(0).max(maximumConsecutiveRefusals),
  observationRequired: z.boolean(), refusedRevision: z.string().regex(revisionPattern).optional(),
  latestObservationRevision: z.string().regex(revisionPattern).optional(), stopped: z.boolean(),
  failedTargets: z.array(z.object({
    fingerprint: z.string().regex(revisionPattern), refusals: z.number().int().min(1).max(2),
    failure: savedFailureSchema,
  }).strict()).max(maximumRememberedTargets),
}).strict();

export function snapshotLocalComputerRecovery(
  state: LocalComputerRecoveryState,
  scope: LocalComputerRecoveryScope,
) {
  return {
    schemaVersion: 1 as const, scopeSha256: scopeDigest(scope),
    consecutiveRefusals: state.consecutiveRefusals,
    observationRequired: state.observationRequired,
    ...(state.refusedRevision ? { refusedRevision: state.refusedRevision } : {}),
    ...(state.latestObservationRevision ? { latestObservationRevision: state.latestObservationRevision } : {}),
    stopped: state.stopped,
    failedTargets: state.failedTargets.map((entry) => ({
      fingerprint: entry.fingerprint, refusals: entry.refusals,
      failure: {
        schemaVersion: 1 as const, code: entry.failure.code,
        phase: entry.failure.phase, reason: entry.failure.reason,
      },
    })),
  };
}

/** Saved state is metadata, not replay permission; mismatches fail closed. */
export function restoreLocalComputerRecoveryState(
  value: unknown,
  scope: LocalComputerRecoveryScope,
): LocalComputerRecoveryState {
  const expectedScope = scopeDigest(scope);
  if (value === undefined) return createLocalComputerRecoveryState();
  const parsed = snapshotSchema.safeParse(value);
  if (!parsed.success || parsed.data.scopeSha256 !== expectedScope) {
    throw new Error("Local Computer recovery state does not match this tenant, actor and run.");
  }
  const { scopeSha256: _scopeSha256, ...state } = parsed.data;
  void _scopeSha256;
  return state;
}

function revision(value: unknown): string | undefined {
  return typeof value === "string" && revisionPattern.test(value) ? value : undefined;
}

/** Hash bounded target/action input. Neither page text nor typed text is retained. */
function targetFingerprint(toolId: string, input: Record<string, unknown>): string {
  // The executor's receipt contains audited input. Normalize proposed input
  // identically so redaction cannot turn a replay into a different target.
  const audited = redactSensitive(input) as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const key of Object.keys(audited).sort()) {
    // Refreshing a snapshot or relabeling its purpose is not a different action.
    if (key === "snapshotRevision" || key === "interactionPurpose") continue;
    const value = audited[key];
    const element = key === "elementId" && typeof value === "string"
      ? /^e:([a-f0-9]{12}):([1-9][0-9]*)$/.exec(value) : null;
    // Real helper IDs embed the observation revision. Keep a conservative
    // snapshot-slot identity for denial only; an ordinal is never evidence
    // that the same semantic control is still present or authorized.
    target[key] = element && revision(audited.snapshotRevision)?.startsWith(element[1])
      ? `snapshot-slot:${element[2]}` : value;
  }
  const encoded = JSON.stringify(target);
  // Invalid/oversized calls still go through the ordinary input validator;
  // they cannot create unbounded recovery state or new target identities here.
  return createHash("sha256").update(toolId).update("\0")
    .update(encoded.length <= 64_000 ? encoded : "oversized_input").digest("hex");
}

export type LocalComputerRecoveryDecision =
  | { allowed: true }
  | { allowed: false; code: "fresh_observation_required" | "unchanged_target_refused" |
      "recovery_limit_reached" | "approval_required" | "unknown_refusal"; guidance: string };

/** A permitted result means only that this recovery fence did not deny the call. */
export function checkLocalComputerRecovery(
  state: LocalComputerRecoveryState,
  next: { toolId: string; input: Record<string, unknown> },
): LocalComputerRecoveryDecision {
  if (!next.toolId.startsWith("local.macos.") ||
      ["local.macos.observe", "local.macos.list_apps"].includes(next.toolId)) return { allowed: true };
  if (state.stopped) {
    return { allowed: false, code: "unknown_refusal", guidance:
      "Stop automatic input after the unclassified refusal. Read the current state and report what is unknown; do not replay the action or claim completion." };
  }
  if (state.consecutiveRefusals >= maximumConsecutiveRefusals) {
    return { allowed: false, code: "recovery_limit_reached", guidance:
      "Three input attempts were refused without a completed input delivery. Stop automatic input and report the blocker. Observation remains available; do not change coordinates or tools to evade this limit." };
  }
  if (!snapshotActions.has(next.toolId)) return { allowed: true };
  const prior = state.failedTargets.find((entry) =>
    entry.fingerprint === targetFingerprint(next.toolId, next.input));
  if (prior?.failure.recovery.nextAction === "request_approval") {
    return { allowed: false, code: "approval_required", guidance: prior.failure.recovery.guidance };
  }
  if (state.observationRequired ||
      (state.refusedRevision && revision(next.input.snapshotRevision) !== state.latestObservationRevision) ||
      (state.refusedRevision && next.input.snapshotRevision === state.refusedRevision)) {
    return { allowed: false, code: "fresh_observation_required", guidance:
      "Observe the selected Mac again and use that successful observation's exact new snapshot revision before another input action. A requested or failed observation does not refresh the target." };
  }
  if (prior && (prior.refusals >= prior.failure.recovery.maximumSameTargetRefusals ||
      prior.failure.phase === "element_hit_test" ||
      prior.failure.code === "task_target_unresolved" ||
      prior.failure.recovery.nextAction === "observe_then_reconcile")) {
    return { allowed: false, code: "unchanged_target_refused", guidance:
      "Do not replay this unchanged refused action. Reconcile the fresh state and choose a verified alternative, such as an exposed semantic Press for the requested control, through the governed executor; otherwise report the blocker." };
  }
  return { allowed: true };
}

/**
 * Feed actual governed results, never model-asserted observations. No automatic
 * action is performed. Observation clears only the freshness fence, not the
 * refusal counters. A newly executed input receipt ends the consecutive-refusal
 * episode: native input delivery completed, but the user's intended outcome is
 * not thereby verified. The caller deduplicates cached execution receipts.
 */
export function recordLocalComputerRecovery(
  state: LocalComputerRecoveryState,
  result: {
    toolId: string;
    input: Record<string, unknown>;
    status: string;
    failure?: unknown;
    observationRevision?: string;
  },
): void {
  if (!result.toolId.startsWith("local.macos.")) return;
  if (result.status === "executed") {
    const observed = revision(result.observationRevision);
    if (observed && observed !== state.refusedRevision) {
      state.latestObservationRevision = observed;
      state.observationRequired = false;
    }
    if (snapshotActions.has(result.toolId)) {
      state.consecutiveRefusals = 0;
      state.failedTargets = [];
      state.refusedRevision = undefined;
      state.stopped = false;
    }
    return;
  }
  if (result.status !== "failed" || !snapshotActions.has(result.toolId)) return;
  const failure = readLocalComputerFailureMetadata(result.failure) ??
    localComputerFailureMetadata("unknown_refusal");
  state.consecutiveRefusals = Math.min(maximumConsecutiveRefusals, state.consecutiveRefusals + 1);
  state.refusedRevision = revision(result.input.snapshotRevision);
  state.latestObservationRevision = undefined;
  state.observationRequired = failure.recovery.observeBeforeAction;
  if (failure.recovery.nextAction === "stop") state.stopped = true;
  const fingerprint = targetFingerprint(result.toolId, result.input);
  const existing = state.failedTargets.find((entry) => entry.fingerprint === fingerprint);
  if (existing) {
    existing.refusals = Math.min(2, existing.refusals + 1);
    existing.failure = failure;
  } else {
    state.failedTargets.push({ fingerprint, refusals: 1, failure });
    if (state.failedTargets.length > maximumRememberedTargets) state.failedTargets.shift();
  }
}
