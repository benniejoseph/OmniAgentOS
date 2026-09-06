import { z } from "zod";
import type { MemoryType } from "@/lib/memory/types";

export const MEMORY_TIER_POLICY_VERSION = 1 as const;

export const memoryTierSchema = z.enum([
  "working",
  "episodic",
  "semantic",
  "procedural",
  "preference",
  "decision",
  "commitment",
  "summary",
]);

export type MemoryTier = z.infer<typeof memoryTierSchema>;

export const memoryFormationReasonSchema = z.enum([
  "manual_user_entry",
  "explicit_user_request",
  "canonical_source_observation",
  "verified_effect",
  "assistant_inference_candidate",
  "correction",
  "project_reflection",
  "project_artifact",
  "workflow_output",
  "maintenance_promotion",
  "portable_restore",
  "legacy_record",
]);

export type MemoryFormationReason = z.infer<
  typeof memoryFormationReasonSchema
>;

export type MemoryTierPolicyV1 = Readonly<{
  version: typeof MEMORY_TIER_POLICY_VERSION;
  tier: MemoryTier;
  retention: Readonly<{
    mode:
      | "time_bounded"
      | "source_policy"
      | "until_invalidated"
      | "obligation_lifecycle";
    defaultDays: number | null;
    expiredRecordsAreRetrievable: false;
  }>;
  promotion: Readonly<{
    targets: readonly MemoryTier[];
    automatic: false;
    minimumVerifiedOccurrences: number;
    review: "user_or_governed_evidence_review" | "not_promotable";
  }>;
  correction: Readonly<{
    strategy: "superseding_revision";
    preserveHistory: true;
    confidenceIncreaseRequiresEvidence: true;
  }>;
  retrieval: Readonly<{
    requiresActiveClaim: true;
    requiresTemporalValidity: true;
    requiresAuthorizedScope: true;
    sessionAffinityRequired: boolean;
    priorityWeight: number;
  }>;
}>;

const sharedCorrection = Object.freeze({
  strategy: "superseding_revision" as const,
  preserveHistory: true as const,
  confidenceIncreaseRequiresEvidence: true as const,
});

function policy(
  tier: MemoryTier,
  input: {
    retention: MemoryTierPolicyV1["retention"];
    targets: readonly MemoryTier[];
    minimumVerifiedOccurrences?: number;
    priorityWeight: number;
    sessionAffinityRequired?: boolean;
  },
): MemoryTierPolicyV1 {
  return Object.freeze({
    version: MEMORY_TIER_POLICY_VERSION,
    tier,
    retention: Object.freeze(input.retention),
    promotion: Object.freeze({
      targets: Object.freeze([...input.targets]),
      automatic: false,
      minimumVerifiedOccurrences: input.minimumVerifiedOccurrences ?? 1,
      review: input.targets.length
        ? "user_or_governed_evidence_review"
        : "not_promotable",
    }),
    correction: sharedCorrection,
    retrieval: Object.freeze({
      requiresActiveClaim: true,
      requiresTemporalValidity: true,
      requiresAuthorizedScope: true,
      sessionAffinityRequired: input.sessionAffinityRequired ?? false,
      priorityWeight: input.priorityWeight,
    }),
  });
}

export const memoryTierPoliciesV1 = Object.freeze({
  working: policy("working", {
    retention: {
      mode: "time_bounded",
      defaultDays: 7,
      expiredRecordsAreRetrievable: false,
    },
    targets: ["episodic", "semantic", "decision", "commitment", "summary"],
    priorityWeight: 1.12,
    sessionAffinityRequired: true,
  }),
  episodic: policy("episodic", {
    retention: {
      mode: "time_bounded",
      defaultDays: 30,
      expiredRecordsAreRetrievable: false,
    },
    targets: ["semantic", "procedural", "summary"],
    minimumVerifiedOccurrences: 2,
    priorityWeight: 1,
  }),
  semantic: policy("semantic", {
    retention: {
      mode: "source_policy",
      defaultDays: 365,
      expiredRecordsAreRetrievable: false,
    },
    targets: ["summary"],
    minimumVerifiedOccurrences: 2,
    priorityWeight: 1.06,
  }),
  procedural: policy("procedural", {
    retention: {
      mode: "until_invalidated",
      defaultDays: null,
      expiredRecordsAreRetrievable: false,
    },
    targets: ["summary"],
    minimumVerifiedOccurrences: 2,
    priorityWeight: 1.1,
  }),
  preference: policy("preference", {
    retention: {
      mode: "until_invalidated",
      defaultDays: null,
      expiredRecordsAreRetrievable: false,
    },
    targets: [],
    priorityWeight: 1.08,
  }),
  decision: policy("decision", {
    retention: {
      mode: "until_invalidated",
      defaultDays: null,
      expiredRecordsAreRetrievable: false,
    },
    targets: ["summary"],
    priorityWeight: 1.08,
  }),
  commitment: policy("commitment", {
    retention: {
      mode: "obligation_lifecycle",
      defaultDays: null,
      expiredRecordsAreRetrievable: false,
    },
    targets: ["episodic", "summary"],
    priorityWeight: 1.15,
  }),
  summary: policy("summary", {
    retention: {
      mode: "time_bounded",
      defaultDays: 365,
      expiredRecordsAreRetrievable: false,
    },
    targets: [],
    priorityWeight: 0.96,
  }),
} satisfies Record<MemoryTier, MemoryTierPolicyV1>);

export function memoryTierPolicy(tier: unknown): MemoryTierPolicyV1 {
  return memoryTierPoliciesV1[memoryTierSchema.parse(tier)];
}

export function defaultMemoryTier(type: MemoryType): MemoryTier {
  switch (type) {
    case "preference":
      return "preference";
    case "episode":
      return "episodic";
    case "procedure":
      return "procedural";
    case "decision":
      return "decision";
    case "task":
      return "commitment";
    case "fact":
    case "knowledge":
      return "semantic";
  }
}

export function resolveMemoryTier(
  tier: unknown,
  type: MemoryType,
): MemoryTier {
  return tier === undefined || tier === null || tier === ""
    ? defaultMemoryTier(type)
    : memoryTierSchema.parse(tier);
}

export function canPromoteMemoryTier(
  from: MemoryTier,
  to: MemoryTier,
  verifiedOccurrences: number,
) {
  const promotion = memoryTierPolicy(from).promotion;
  return promotion.targets.includes(to) &&
    verifiedOccurrences >= promotion.minimumVerifiedOccurrences;
}

export function memoryTierRetentionExpiresAt(
  tier: MemoryTier,
  formedAt: string,
  validTo?: string,
) {
  const retention = memoryTierPolicy(tier).retention;
  if (retention.mode === "obligation_lifecycle") {
    return normalizedTimestamp(validTo);
  }
  if (retention.mode !== "time_bounded" || retention.defaultDays === null) {
    return undefined;
  }
  const formedAtMs = Date.parse(formedAt);
  if (!Number.isFinite(formedAtMs)) {
    throw new Error("Memory formation time is invalid.");
  }
  return new Date(
    formedAtMs + retention.defaultDays * 24 * 60 * 60 * 1_000,
  ).toISOString();
}

export function inferMemoryFormationReason(input: {
  source?: string;
  formationOrigin?: string;
  supersedesId?: string;
}): MemoryFormationReason {
  if (input.supersedesId || input.source?.startsWith("correction:")) {
    return "correction";
  }
  switch (input.formationOrigin) {
    case "user_assertion":
      return "explicit_user_request";
    case "source_observation":
      return "canonical_source_observation";
    case "verified_effect":
      return "verified_effect";
    case "assistant_inference":
      return "assistant_inference_candidate";
  }
  const source = input.source || "manual";
  if (source === "manual") return "manual_user_entry";
  if (source.startsWith("portable-restore:")) return "portable_restore";
  if (source.includes("reflection")) return "project_reflection";
  if (source.includes("artifact")) return "project_artifact";
  if (source.includes("workflow")) return "workflow_output";
  if (source.startsWith("memory-promotion:")) return "maintenance_promotion";
  return "legacy_record";
}

export function memoryFormationReasonLabel(reason: MemoryFormationReason) {
  const labels: Record<MemoryFormationReason, string> = {
    manual_user_entry: "Added directly by the user.",
    explicit_user_request: "Saved because the user explicitly asked Asael to remember it.",
    canonical_source_observation: "Formed from canonical source evidence.",
    verified_effect: "Formed from a verified tool effect receipt.",
    assistant_inference_candidate: "Proposed from an assistant inference and awaiting confirmation.",
    correction: "Created as a traceable correction of an earlier memory.",
    project_reflection: "Formed from a project reflection.",
    project_artifact: "Formed from a project artifact.",
    workflow_output: "Formed from governed workflow output.",
    maintenance_promotion: "Promoted from repeated verified episodes after explicit review.",
    portable_restore: "Restored from a verified portable archive.",
    legacy_record: "Imported from a record created before tiered memory metadata.",
  };
  return labels[reason];
}

function normalizedTimestamp(value?: string) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
