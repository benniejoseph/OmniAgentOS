import { z } from "zod";
import { normalizeCapabilityQuery } from "@/lib/capabilities/catalog";
import type { CapabilityDescriptor } from "@/lib/capabilities/types";
import type { AgentMode } from "@/lib/orchestration/types";
import type {
  SupervisorAgentId,
  SupervisorDecision,
} from "@/lib/orchestration/supervisor";

export const SEMANTIC_INTENT_SCHEMA_VERSION = 1 as const;
export const SEMANTIC_INTENT_POLICY_VERSION =
  "semantic-intent-policy-v1" as const;

export const semanticIntentCandidateSchema = z.object({
  intent: z.enum([
    "question",
    "summarize",
    "retrieve",
    "create",
    "update",
    "delete",
    "communicate",
    "execute",
    "recurring",
    "research",
    "unknown",
  ]),
  executionShape: z.enum([
    "conversational",
    "single_action",
    "multi_step",
    "background",
    "recurring",
  ]),
  workKinds: z.array(z.enum([
    "research",
    "build",
    "memory",
    "verify",
    "coordinate",
  ])).max(5),
  consequential: z.boolean(),
  needsClarification: z.boolean(),
  entities: z.array(z.object({
    kind: z.string().trim().min(1).max(80),
    reference: z.string().trim().min(1).max(240),
    resolution: z.enum(["exact", "descriptive", "referential", "missing"]),
  }).strict()).max(12),
  capabilityQueries: z.array(z.string().trim().min(1).max(120)).max(8),
  candidateCapabilityIds: z.array(z.string().trim().min(1).max(512)).max(12),
  confidence: z.number().min(0).max(1),
}).strict();

export type SemanticIntentCandidate = z.infer<
  typeof semanticIntentCandidateSchema
>;

export type SemanticIntentSource =
  | "model"
  | "deterministic_invariant"
  | "deterministic_fallback";

export type SemanticIntentReceipt = Readonly<{
  schemaVersion: typeof SEMANTIC_INTENT_SCHEMA_VERSION;
  policyVersion: typeof SEMANTIC_INTENT_POLICY_VERSION;
  source: SemanticIntentSource;
  intent: SemanticIntentCandidate["intent"] | "not_evaluated";
  executionShape:
    | SemanticIntentCandidate["executionShape"]
    | "not_evaluated";
  confidence: number | null;
  entityCount: number;
  unresolvedEntityCount: number;
  capabilityQuery: string;
  matchedCapabilityIds: readonly string[];
  route: SupervisorDecision["route"];
  requiresApproval: boolean;
  clarificationAdvisory: boolean;
  model?: Readonly<{
    provider: string;
    model: string;
    usageReceiptId?: string;
    usageReceiptRecorded: boolean;
  }>;
  fallbackReasonCode?:
    | "deterministic_invariant"
    | "model_unavailable"
    | "model_output_invalid"
    | "model_usage_unrecorded";
}>;

export type SemanticSupervisorResolution = Readonly<{
  decision: SupervisorDecision;
  receipt: SemanticIntentReceipt;
  capabilitySearchQuery: string;
}>;

export function applySemanticIntentPolicy(input: {
  baseline: SupervisorDecision;
  candidate: SemanticIntentCandidate;
  mode: AgentMode;
  preferredAgentId?: SupervisorAgentId;
  capabilityCandidates: readonly CapabilityDescriptor[];
}): SemanticSupervisorResolution {
  const candidate = semanticIntentCandidateSchema.parse(input.candidate);
  const capabilityById = new Map(
    input.capabilityCandidates.map((capability) => [capability.id, capability]),
  );
  const matchedCapabilities = [...new Set(candidate.candidateCapabilityIds)]
    .map((id) => capabilityById.get(id))
    .filter((capability): capability is CapabilityDescriptor =>
      Boolean(capability)
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const capabilitySearchQuery = buildSemanticCapabilityQuery(
    candidate,
    matchedCapabilities,
  );

  if (
    input.baseline.route === "clarify" ||
    input.baseline.procedure
  ) {
    return {
      decision: input.baseline,
      capabilitySearchQuery,
      receipt: buildReceipt({
        source: "deterministic_invariant",
        candidate,
        capabilitySearchQuery,
        matchedCapabilities,
        decision: input.baseline,
        fallbackReasonCode: "deterministic_invariant",
      }),
    };
  }

  const team = semanticAgentTeam(
    candidate,
    input.mode,
    input.preferredAgentId,
  );
  const route = semanticRoute(candidate);
  const requiresCapabilityApproval = matchedCapabilities.some(
    (capability) =>
      capability.approvalRequired || capability.riskLevel >= 2,
  );
  const requiresApproval =
    input.baseline.requiresApproval ||
    candidate.consequential ||
    requiresCapabilityApproval;
  const decision: SupervisorDecision = {
    route,
    score: semanticRouteScore(candidate),
    reasons: semanticDecisionReasons({
      candidate,
      route,
      baselineRequiresApproval: input.baseline.requiresApproval,
      requiresCapabilityApproval,
    }),
    requiresApproval,
    ambiguity: input.baseline.ambiguity,
    ...team,
  };

  return {
    decision,
    capabilitySearchQuery,
    receipt: buildReceipt({
      source: "model",
      candidate,
      capabilitySearchQuery,
      matchedCapabilities,
      decision,
    }),
  };
}

export function deterministicSemanticFallback(input: {
  baseline: SupervisorDecision;
  reasonCode:
    | "model_unavailable"
    | "model_output_invalid"
    | "model_usage_unrecorded";
}): SemanticSupervisorResolution {
  return {
    decision: input.baseline,
    capabilitySearchQuery: "",
    receipt: {
      schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
      policyVersion: SEMANTIC_INTENT_POLICY_VERSION,
      source: input.baseline.route === "clarify" || input.baseline.procedure
        ? "deterministic_invariant"
        : "deterministic_fallback",
      intent: "not_evaluated",
      executionShape: "not_evaluated",
      confidence: null,
      entityCount: 0,
      unresolvedEntityCount: 0,
      capabilityQuery: "",
      matchedCapabilityIds: [],
      route: input.baseline.route,
      requiresApproval: input.baseline.requiresApproval,
      clarificationAdvisory: false,
      fallbackReasonCode:
        input.baseline.route === "clarify" || input.baseline.procedure
          ? "deterministic_invariant"
          : input.reasonCode,
    },
  };
}

export function attachSemanticModelReceipt(
  resolution: SemanticSupervisorResolution,
  model: NonNullable<SemanticIntentReceipt["model"]>,
): SemanticSupervisorResolution {
  return {
    ...resolution,
    receipt: {
      ...resolution.receipt,
      model,
    },
  };
}

function semanticRoute(
  candidate: SemanticIntentCandidate,
): SupervisorDecision["route"] {
  if (
    candidate.executionShape === "recurring" ||
    candidate.executionShape === "background"
  ) {
    return "durable_workflow";
  }
  if (
    candidate.executionShape === "multi_step" &&
    candidate.workKinds.includes("coordinate")
  ) {
    return "durable_workflow";
  }
  return "direct";
}

function semanticRouteScore(candidate: SemanticIntentCandidate) {
  if (candidate.executionShape === "recurring") return 5;
  if (candidate.executionShape === "background") return 4;
  if (candidate.executionShape === "multi_step") return 3;
  if (candidate.executionShape === "single_action") return 1;
  return 0;
}

function semanticDecisionReasons(input: {
  candidate: SemanticIntentCandidate;
  route: SupervisorDecision["route"];
  baselineRequiresApproval: boolean;
  requiresCapabilityApproval: boolean;
}) {
  const reasons = [
    input.route === "durable_workflow"
      ? `Semantic intent resolution identified ${input.candidate.executionShape.replaceAll("_", " ")} work that requires persisted execution.`
      : `Semantic intent resolution identified ${input.candidate.executionShape.replaceAll("_", " ")} work that can stay on the direct path.`,
  ];
  if (input.baselineRequiresApproval) {
    reasons.push("Deterministic policy detected a consequential external effect.");
  } else if (input.requiresCapabilityApproval) {
    reasons.push("A catalog-validated capability candidate requires approval.");
  }
  if (input.candidate.needsClarification) {
    reasons.push(
      "Semantic ambiguity was recorded as advisory; only deterministic ambiguity policy can pause execution.",
    );
  }
  return reasons;
}

function semanticAgentTeam(
  candidate: SemanticIntentCandidate,
  mode: AgentMode,
  preferredAgentId?: SupervisorAgentId,
) {
  const workKinds = new Set(candidate.workKinds);
  if (mode === "research") workKinds.add("research");
  if (mode === "execute") workKinds.add("build");
  if (mode === "learn") workKinds.add("memory");

  const inferred: SupervisorAgentId = workKinds.has("memory")
    ? "mnemosyne"
    : workKinds.has("build")
      ? "forge"
      : workKinds.has("research")
        ? "scout"
        : "atlas";
  const primaryAgentId = preferredAgentId || inferred;
  const specialistIds = new Set<SupervisorAgentId>([primaryAgentId]);
  if (preferredAgentId && inferred !== "atlas") specialistIds.add(inferred);
  if (workKinds.has("research")) specialistIds.add("scout");
  if (workKinds.has("build")) specialistIds.add("forge");
  if (workKinds.has("memory")) specialistIds.add("mnemosyne");
  if (workKinds.has("coordinate") && primaryAgentId !== "atlas") {
    specialistIds.add("atlas");
  }
  if (
    workKinds.has("verify") ||
    candidate.consequential ||
    specialistIds.size > 1
  ) {
    specialistIds.add("sentinel");
  }
  return { primaryAgentId, specialistIds: [...specialistIds] };
}

function buildSemanticCapabilityQuery(
  candidate: SemanticIntentCandidate,
  matchedCapabilities: readonly CapabilityDescriptor[],
) {
  return normalizeCapabilityQuery([
    ...candidate.capabilityQueries,
    ...matchedCapabilities.flatMap((capability) => [
      capability.name,
      capability.description,
    ]),
  ].join(" "));
}

function buildReceipt(input: {
  source: SemanticIntentSource;
  candidate: SemanticIntentCandidate;
  capabilitySearchQuery: string;
  matchedCapabilities: readonly CapabilityDescriptor[];
  decision: SupervisorDecision;
  fallbackReasonCode?: SemanticIntentReceipt["fallbackReasonCode"];
}): SemanticIntentReceipt {
  return {
    schemaVersion: SEMANTIC_INTENT_SCHEMA_VERSION,
    policyVersion: SEMANTIC_INTENT_POLICY_VERSION,
    source: input.source,
    intent: input.candidate.intent,
    executionShape: input.candidate.executionShape,
    confidence: input.candidate.confidence,
    entityCount: input.candidate.entities.length,
    unresolvedEntityCount: input.candidate.entities.filter((entity) =>
      entity.resolution === "referential" || entity.resolution === "missing"
    ).length,
    capabilityQuery: input.capabilitySearchQuery,
    matchedCapabilityIds: input.matchedCapabilities.map((capability) =>
      capability.id
    ),
    route: input.decision.route,
    requiresApproval: input.decision.requiresApproval,
    clarificationAdvisory: input.candidate.needsClarification,
    ...(input.fallbackReasonCode
      ? { fallbackReasonCode: input.fallbackReasonCode }
      : {}),
  };
}
