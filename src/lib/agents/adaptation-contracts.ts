import { z } from "zod";

import { sourceContractSha256 } from "@/lib/sources/contracts";

export const AGENT_ADAPTATION_SCHEMA_VERSION = 1 as const;
export const AGENT_ADAPTATION_VERSION = "p7.6-agent-adaptation:1" as const;
export const AGENT_ADAPTATION_EVALUATION_VERSION =
  "p7.6-agent-adaptation-evaluation:1" as const;
export const AGENT_ADAPTATION_POLICY_VERSION =
  "agent-adaptation-policy:1" as const;
export const AGENT_ADAPTATION_PROPOSAL_REVIEW_VERSION =
  "p7.7-agent-adaptation-proposal-review:1" as const;

const idSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });
const positiveVersionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const confidenceSchema = z.number().min(0).max(1);

export const agentAdaptationEvidenceV1Schema = z.object({
  evidenceId: idSchema,
  kind: z.enum([
    "run_feedback",
    "project_artifact",
    "delegated_task",
    "scheduled_trigger",
  ]),
  sourceId: idSchema,
  sourceSha256: sha256Schema,
  verdict: z.enum(["useful", "needs_work"]),
  groundingStatus: z.enum(["verified", "not_required"]),
  observedAt: timestampSchema,
}).strict();

const adaptationIdentityPinSchema = z.object({
  agentId: idSchema,
  definitionVersion: positiveVersionSchema,
  definitionSha256: sha256Schema,
  principalId: idSchema,
  principalGeneration: positiveVersionSchema,
  principalSha256: sha256Schema,
}).strict();

const adaptationSentinelRuntimePinSchema = adaptationIdentityPinSchema.extend({
  agentId: z.literal("sentinel"),
  provider: z.enum(["openai", "google", "anthropic", "aws_bedrock"]),
  model: idSchema,
  tier: z.literal("reasoning"),
  routeSource: z.enum(["tenant_assignment", "deployment_environment"]),
  assignmentId: idSchema.nullable(),
  assignmentRevision: positiveVersionSchema.nullable(),
  assignmentConfigurationSha256: sha256Schema.nullable(),
}).strict().superRefine((value, context) => {
  const assignmentPinned = value.routeSource === "tenant_assignment";
  if (
    assignmentPinned !== Boolean(
      value.assignmentId && value.assignmentRevision &&
        value.assignmentConfigurationSha256,
    )
  ) {
    context.addIssue({
      code: "custom",
      path: ["assignmentId"],
      message: "Sentinel assignment coordinates are inconsistent.",
    });
  }
});

export const agentAdaptationProposalReviewV1Schema = z.object({
  version: z.literal(AGENT_ADAPTATION_PROPOSAL_REVIEW_VERSION),
  targetIdentity: adaptationIdentityPinSchema,
  sentinelRuntime: adaptationSentinelRuntimePinSchema,
  evidenceSetSha256: sha256Schema,
  baselineEffectSha256: sha256Schema.nullable(),
  proposalSha256: sha256Schema,
  shadowComparisonSha256: sha256Schema,
  review: z.object({
    verdict: z.literal("passed"),
    score: z.number().min(0.75).max(1),
    findings: z.array(z.enum([
      "evidence_bound",
      "definition_bound",
      "non_authority",
      "measurable",
      "no_material_change",
    ])).min(3).max(5).refine(
      (values) => new Set(values).size === values.length,
      "Sentinel findings must be unique.",
    ),
    reviewSha256: sha256Schema,
  }).strict(),
  generatedAt: timestampSchema,
  reviewedAt: timestampSchema,
  authorityImpact: z.literal("none"),
}).strict().superRefine((value, context) => {
  const { reviewSha256, ...reviewBody } = value.review;
  if (
    sourceContractSha256(reviewBody) !== reviewSha256 ||
    value.review.findings.includes("no_material_change")
  ) {
    context.addIssue({
      code: "custom",
      path: ["review"],
      message: "Sentinel proposal review integrity is invalid.",
    });
  }
});

export const agentAdaptationEffectV1Schema = z.object({
  kind: z.literal("instruction_guidance"),
  guidance: z.string().trim().min(3).max(1_000),
  guidanceSha256: sha256Schema,
  authorityImpact: z.literal("none"),
  proposalReview: agentAdaptationProposalReviewV1Schema.optional(),
  effectSha256: sha256Schema,
}).strict();

export const agentAdaptationEvaluationV1Schema = z.object({
  version: z.literal(AGENT_ADAPTATION_EVALUATION_VERSION),
  policyVersionId: z.literal(AGENT_ADAPTATION_POLICY_VERSION),
  definitionVersion: positiveVersionSchema,
  checks: z.object({
    evidenceIntegrity: z.literal(true),
    ownerBinding: z.literal(true),
    exactDefinitionVersion: z.literal(true),
    nonAuthorityEffect: z.literal(true),
    confidenceThreshold: z.boolean(),
  }).strict(),
  verdict: z.enum(["passed", "held"]),
  evaluatedAt: timestampSchema,
  evaluationSha256: sha256Schema,
}).strict();

export const agentAdaptationV1Schema = z.object({
  schemaVersion: z.literal(AGENT_ADAPTATION_SCHEMA_VERSION),
  version: z.literal(AGENT_ADAPTATION_VERSION),
  adaptationId: idSchema,
  agentId: idSchema,
  ownerBindingSha256: sha256Schema,
  observedDefinitionVersion: positiveVersionSchema,
  state: z.enum(["observed", "evaluated", "active", "rolled_back"]),
  lifecycleRevision: z.number().int().min(0).max(3),
  evidence: z.array(agentAdaptationEvidenceV1Schema).min(1).max(10),
  evidenceSha256: sha256Schema,
  confidence: confidenceSchema,
  effect: agentAdaptationEffectV1Schema,
  evaluation: agentAdaptationEvaluationV1Schema.nullable(),
  activationVersion: positiveVersionSchema.nullable(),
  activatedAt: timestampSchema.nullable(),
  rolledBackAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  const stateValid = value.state === "observed"
    ? value.lifecycleRevision === 0 && value.evaluation === null &&
      value.activationVersion === null && value.activatedAt === null &&
      value.rolledBackAt === null
    : value.state === "evaluated"
      ? value.lifecycleRevision === 1 && value.evaluation !== null &&
        value.activationVersion === null && value.activatedAt === null &&
        value.rolledBackAt === null
      : value.state === "active"
        ? value.lifecycleRevision === 2 && value.evaluation?.verdict === "passed" &&
          value.activationVersion !== null && value.activatedAt !== null &&
          value.rolledBackAt === null
        : value.lifecycleRevision === 3 && value.evaluation?.verdict === "passed" &&
          value.activationVersion !== null && value.activatedAt !== null &&
          value.rolledBackAt !== null;
  if (!stateValid) {
    context.addIssue({
      code: "custom",
      path: ["state"],
      message: "Agent adaptation lifecycle coordinates are inconsistent.",
    });
  }
  const evidence = canonicalEvidence(value.evidence);
  const { effectSha256, ...effectBody } = value.effect;
  if (
    JSON.stringify(evidence) !== JSON.stringify(value.evidence) ||
    sourceContractSha256(evidence) !== value.evidenceSha256 ||
    sourceContractSha256(effectBody) !== effectSha256 ||
    sourceContractSha256(value.effect.guidance) !== value.effect.guidanceSha256 ||
    value.adaptationId !== `agent-adaptation:${sourceContractSha256({
      agentId: value.agentId,
      ownerBindingSha256: value.ownerBindingSha256,
      observedDefinitionVersion: value.observedDefinitionVersion,
      evidenceSha256: value.evidenceSha256,
      effectSha256: value.effect.effectSha256,
    })}`
  ) {
    context.addIssue({
      code: "custom",
      path: ["adaptationId"],
      message: "Agent adaptation integrity is invalid.",
    });
  }
  if (value.evaluation) {
    const { evaluationSha256, ...body } = value.evaluation;
    if (
      sourceContractSha256(body) !== evaluationSha256 ||
      value.evaluation.verdict !==
        (value.evaluation.checks.confidenceThreshold ? "passed" : "held")
    ) {
      context.addIssue({
        code: "custom",
        path: ["evaluation"],
        message: "Agent adaptation evaluation integrity is invalid.",
      });
    }
  }
});

export type AgentAdaptationEvidenceV1 = Readonly<
  z.infer<typeof agentAdaptationEvidenceV1Schema>
>;
export type AgentAdaptationEffectV1 = Readonly<
  z.infer<typeof agentAdaptationEffectV1Schema>
>;
export type AgentAdaptationProposalReviewV1 = Readonly<
  z.infer<typeof agentAdaptationProposalReviewV1Schema>
>;
export type AgentAdaptationEvaluationV1 = Readonly<
  z.infer<typeof agentAdaptationEvaluationV1Schema>
>;
export type AgentAdaptationV1 = Readonly<
  z.infer<typeof agentAdaptationV1Schema>
>;

export function buildObservedAgentAdaptationV1(input: {
  tenantId: string;
  ownerActorId: string;
  agentId: string;
  definitionVersion: number;
  evidence: readonly AgentAdaptationEvidenceV1[];
  guidance: string;
  confidence: number;
  proposalReview?: AgentAdaptationProposalReviewV1;
  observedAt?: string;
}) {
  const ownerBindingSha256 = sourceContractSha256({
    tenantId: requiredText(input.tenantId),
    ownerActorId: requiredText(input.ownerActorId),
    agentId: requiredText(input.agentId),
  });
  const evidence = canonicalEvidence(input.evidence);
  const evidenceSha256 = sourceContractSha256(evidence);
  const guidance = input.guidance.trim();
  const guidanceSha256 = sourceContractSha256(guidance);
  const effectBody = {
    kind: "instruction_guidance" as const,
    guidance,
    guidanceSha256,
    authorityImpact: "none" as const,
    ...(input.proposalReview
      ? {
          proposalReview: agentAdaptationProposalReviewV1Schema.parse(
            input.proposalReview,
          ),
        }
      : {}),
  };
  const effect = {
    ...effectBody,
    effectSha256: sourceContractSha256(effectBody),
  };
  const adaptationId = `agent-adaptation:${sourceContractSha256({
    agentId: input.agentId,
    ownerBindingSha256,
    observedDefinitionVersion: input.definitionVersion,
    evidenceSha256,
    effectSha256: effect.effectSha256,
  })}`;
  const observedAt = canonicalTimestamp(input.observedAt || Date.now());
  return parseAgentAdaptationV1({
    schemaVersion: AGENT_ADAPTATION_SCHEMA_VERSION,
    version: AGENT_ADAPTATION_VERSION,
    adaptationId,
    agentId: input.agentId,
    ownerBindingSha256,
    observedDefinitionVersion: input.definitionVersion,
    state: "observed",
    lifecycleRevision: 0,
    evidence,
    evidenceSha256,
    confidence: boundedConfidence(input.confidence),
    effect,
    evaluation: null,
    activationVersion: null,
    activatedAt: null,
    rolledBackAt: null,
    createdAt: observedAt,
    updatedAt: observedAt,
  });
}

export function evaluateAgentAdaptationV1(
  adaptation: AgentAdaptationV1,
  definitionVersion: number,
  evaluatedAt?: string,
) {
  const current = parseAgentAdaptationV1(adaptation);
  if (current.state !== "observed") {
    throw new Error("Only an observed Agent adaptation can be evaluated.");
  }
  if (definitionVersion !== current.observedDefinitionVersion) {
    throw new Error("Agent adaptation evaluation requires the observed definition.");
  }
  const body = {
    version: AGENT_ADAPTATION_EVALUATION_VERSION,
    policyVersionId: AGENT_ADAPTATION_POLICY_VERSION,
    definitionVersion,
    checks: {
      evidenceIntegrity: true as const,
      ownerBinding: true as const,
      exactDefinitionVersion: true as const,
      nonAuthorityEffect: true as const,
      confidenceThreshold: current.confidence >= 0.75,
    },
    verdict: current.confidence >= 0.75 ? "passed" as const : "held" as const,
    evaluatedAt: canonicalTimestamp(evaluatedAt || Date.now()),
  };
  return parseAgentAdaptationV1({
    ...current,
    state: "evaluated",
    lifecycleRevision: 1,
    evaluation: {
      ...body,
      evaluationSha256: sourceContractSha256(body),
    },
    updatedAt: body.evaluatedAt,
  });
}

export function activateAgentAdaptationV1(
  adaptation: AgentAdaptationV1,
  activationVersion: number,
  activatedAt?: string,
) {
  const current = parseAgentAdaptationV1(adaptation);
  if (current.state !== "evaluated" || current.evaluation?.verdict !== "passed") {
    throw new Error("Only a passed Agent adaptation evaluation can be activated.");
  }
  const timestamp = canonicalTimestamp(activatedAt || Date.now());
  return parseAgentAdaptationV1({
    ...current,
    state: "active",
    lifecycleRevision: 2,
    activationVersion,
    activatedAt: timestamp,
    updatedAt: timestamp,
  });
}

export function rollbackAgentAdaptationV1(
  adaptation: AgentAdaptationV1,
  rolledBackAt?: string,
) {
  const current = parseAgentAdaptationV1(adaptation);
  if (current.state !== "active") {
    throw new Error("Only an active Agent adaptation can be rolled back.");
  }
  const timestamp = canonicalTimestamp(rolledBackAt || Date.now());
  return parseAgentAdaptationV1({
    ...current,
    state: "rolled_back",
    lifecycleRevision: 3,
    rolledBackAt: timestamp,
    updatedAt: timestamp,
  });
}

export function parseAgentAdaptationV1(value: unknown): AgentAdaptationV1 {
  return deepFreeze(agentAdaptationV1Schema.parse(value));
}

function canonicalEvidence(values: readonly AgentAdaptationEvidenceV1[]) {
  return values.map((value) => agentAdaptationEvidenceV1Schema.parse(value))
    .sort((left, right) => left.evidenceId.localeCompare(right.evidenceId));
}

function boundedConfidence(value: number) {
  if (!Number.isFinite(value)) throw new Error("Adaptation confidence is invalid.");
  return Math.round(Math.min(1, Math.max(0, value)) * 1_000) / 1_000;
}

function canonicalTimestamp(value: string | number) {
  return new Date(value).toISOString();
}

function requiredText(value: string) {
  const text = value.trim();
  if (!text) throw new Error("Adaptation owner binding is required.");
  return text;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
  }
  return value;
}
