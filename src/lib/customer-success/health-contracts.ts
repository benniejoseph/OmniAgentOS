import { z } from "zod";

import { customerFactKindSchema } from "@/lib/customer-success/contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const CUSTOMER_HEALTH_CONTRACT_VERSION =
  "p10.12-customer-health:1" as const;
export const CUSTOMER_HEALTH_POLICY_VERSION =
  "asael-customer-health:1" as const;

export const CUSTOMER_HEALTH_FACTOR_KEYS = Object.freeze([
  "adoption",
  "support",
  "engagement",
  "commercial",
] as const);

const opaqueIdSchema = z.string().trim().min(1).max(240).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const workspaceIdSchema = opaqueIdSchema.regex(
  /^workspace:[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const accountIdSchema = z.string().regex(/^customer-account:[a-f0-9]{64}$/);
const factIdSchema = z.string().regex(/^customer-fact:[a-f0-9]{64}$/);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  { message: "Timestamp must use canonical UTC ISO format." },
);
const basisPointsSchema = z.number().int().min(0).max(10_000);

export const customerHealthFactorKeySchema = z.enum(CUSTOMER_HEALTH_FACTOR_KEYS);

const customerHealthPolicyFactorSchema = z.object({
  factorKey: customerHealthFactorKeySchema,
  label: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(500),
  weightBasisPoints: z.number().int().min(1).max(10_000),
  acceptedFactKinds: z.array(customerFactKindSchema).min(1).max(12),
  healthDimensions: z.array(z.string().regex(/^[a-z0-9_-]{1,80}$/)).max(20),
  aggregation: z.literal("confidence_weighted_mean"),
  missingInputBehavior: z.literal("exclude_score_lower_confidence"),
}).strict().superRefine((value, context) => {
  requireUnique(value.acceptedFactKinds, context, "acceptedFactKinds");
  requireUnique(value.healthDimensions, context, "healthDimensions");
});

const customerHealthPolicyBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(CUSTOMER_HEALTH_CONTRACT_VERSION),
  policyVersion: z.literal(CUSTOMER_HEALTH_POLICY_VERSION),
  name: z.string().trim().min(1).max(180),
  factors: z.array(customerHealthPolicyFactorSchema)
    .length(CUSTOMER_HEALTH_FACTOR_KEYS.length),
  freshnessConfidenceMultipliers: z.object({
    fresh: basisPointsSchema,
    stale: basisPointsSchema,
    future: z.literal(0),
    expired: z.literal(0),
    unknown: basisPointsSchema,
  }).strict(),
  conflictingEvidenceMultiplierBasisPoints: basisPointsSchema,
  statusThresholds: z.object({
    healthyMinimumBasisPoints: basisPointsSchema,
    watchMinimumBasisPoints: basisPointsSchema,
  }).strict().refine(
    (value) => value.healthyMinimumBasisPoints > value.watchMinimumBasisPoints,
    { message: "Healthy threshold must be greater than watch threshold." },
  ),
}).strict().superRefine((value, context) => {
  requireUnique(value.factors.map((factor) => factor.factorKey), context, "factors");
  if (value.factors.reduce((sum, factor) => sum + factor.weightBasisPoints, 0) !== 10_000) {
    context.addIssue({
      code: "custom",
      path: ["factors"],
      message: "Customer health factor weights must total 10,000 basis points.",
    });
  }
});

export const customerHealthPolicySchema = customerHealthPolicyBodySchema.extend({
  policyId: z.string().regex(/^customer-health-policy:[a-f0-9]{64}$/),
  policySha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { policyId, policySha256, ...body } = value;
  const expectedSha256 = canonicalJsonSha256(body);
  if (policySha256 !== expectedSha256) {
    context.addIssue({ code: "custom", path: ["policySha256"], message: "Health policy digest does not match." });
  }
  if (policyId !== `customer-health-policy:${expectedSha256}`) {
    context.addIssue({ code: "custom", path: ["policyId"], message: "Health policy identity does not match." });
  }
});

export const customerHealthEvidenceReferenceSchema = z.object({
  factId: factIdSchema,
  factRevisionId: opaqueIdSchema,
  factSha256: sha256Schema,
  sourceRevisionId: opaqueIdSchema,
  sourceRevisionSha256: sha256Schema,
  valueSha256: sha256Schema,
  freshnessStatus: z.enum(["fresh", "stale", "future", "expired", "unknown"]),
  rawScoreBasisPoints: basisPointsSchema.nullable(),
  sourceConfidenceBasisPoints: basisPointsSchema,
  freshnessMultiplierBasisPoints: basisPointsSchema,
  conflictMultiplierBasisPoints: basisPointsSchema,
  effectiveConfidenceBasisPoints: basisPointsSchema,
}).strict();

export const customerHealthSuggestionSchema = z.object({
  suggestionId: z.string().regex(/^customer-health-suggestion:[a-f0-9]{64}$/),
  suggestionKind: z.enum(["next_action", "factor_review", "input_gap"]),
  statement: z.string().trim().min(1).max(1_000),
  citedFactRevisionIds: z.array(opaqueIdSchema).min(1).max(20),
  citedFactSha256s: z.array(sha256Schema).min(1).max(20),
  confidenceBasisPoints: basisPointsSchema,
  origin: z.object({
    kind: z.literal("model"),
    providerId: opaqueIdSchema,
    modelId: opaqueIdSchema,
    promptSha256: sha256Schema,
  }).strict(),
  authoritative: z.literal(false),
  createdAt: timestampSchema,
}).strict().superRefine((value, context) => {
  requireUnique(value.citedFactRevisionIds, context, "citedFactRevisionIds");
  requireUnique(value.citedFactSha256s, context, "citedFactSha256s");
  if (value.citedFactRevisionIds.length !== value.citedFactSha256s.length) {
    context.addIssue({
      code: "custom",
      path: ["citedFactSha256s"],
      message: "Suggestion citation identities and digests must align.",
    });
  }
  const expectedId = `customer-health-suggestion:${canonicalJsonSha256({
    suggestionKind: value.suggestionKind,
    statement: value.statement,
    citedFactRevisionIds: value.citedFactRevisionIds,
    citedFactSha256s: value.citedFactSha256s,
    confidenceBasisPoints: value.confidenceBasisPoints,
    origin: value.origin,
    authoritative: false,
    createdAt: value.createdAt,
  })}`;
  if (value.suggestionId !== expectedId) {
    context.addIssue({ code: "custom", path: ["suggestionId"], message: "Suggestion identity does not match its evidence." });
  }
});

export const customerHealthFactorResultSchema = z.object({
  factorKey: customerHealthFactorKeySchema,
  label: z.string().trim().min(1).max(120),
  weightBasisPoints: z.number().int().min(1).max(10_000),
  scoreBasisPoints: basisPointsSchema.nullable(),
  confidenceBasisPoints: basisPointsSchema,
  evidenceState: z.enum(["available", "missing", "unscorable", "stale_only"]),
  evidence: z.array(customerHealthEvidenceReferenceSchema).max(5_000),
}).strict().superRefine((value, context) => {
  if ((value.scoreBasisPoints === null) !== ["missing", "unscorable"].includes(value.evidenceState)) {
    context.addIssue({ code: "custom", path: ["scoreBasisPoints"], message: "Factor score and evidence state are inconsistent." });
  }
  if (value.scoreBasisPoints === null && value.confidenceBasisPoints !== 0) {
    context.addIssue({ code: "custom", path: ["confidenceBasisPoints"], message: "A missing factor cannot claim confidence." });
  }
  if (value.evidenceState === "missing" && value.evidence.length !== 0) {
    context.addIssue({ code: "custom", path: ["evidence"], message: "Missing factors cannot contain evidence." });
  }
});

const customerHealthScoreBodySchema = z.object({
  schemaVersion: z.literal(1),
  contractVersion: z.literal(CUSTOMER_HEALTH_CONTRACT_VERSION),
  tenantId: opaqueIdSchema,
  workspaceId: workspaceIdSchema,
  accountId: accountIdSchema,
  scoreId: z.string().regex(/^customer-health-score:[a-f0-9]{64}$/),
  scoreRevisionId: z.string().regex(/^customer-health-score:[a-f0-9]{64}:v[1-9][0-9]*$/),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  previousScoreRevisionId: z.string().regex(/^customer-health-score:[a-f0-9]{64}:v[1-9][0-9]*$/).nullable(),
  evaluationId: z.string().regex(/^customer-health-evaluation:[a-f0-9]{64}$/),
  accountRevisionId: opaqueIdSchema,
  accountSha256: sha256Schema,
  inputSha256: sha256Schema,
  policy: customerHealthPolicySchema,
  scoreBasisPoints: basisPointsSchema.nullable(),
  status: z.enum(["healthy", "watch", "at_risk", "unknown"]),
  confidenceBasisPoints: basisPointsSchema,
  coverageBasisPoints: basisPointsSchema,
  factors: z.array(customerHealthFactorResultSchema)
    .length(CUSTOMER_HEALTH_FACTOR_KEYS.length),
  suggestions: z.array(customerHealthSuggestionSchema).max(20),
  authority: z.literal("deterministic_policy"),
  evaluatedByActorId: opaqueIdSchema,
  evaluatedAt: timestampSchema,
}).strict().superRefine((value, context) => {
  requireUnique(value.factors.map((factor) => factor.factorKey), context, "factors");
  requireUnique(value.suggestions.map((suggestion) => suggestion.suggestionId), context, "suggestions");
  const expectedScoreId = customerHealthScoreId({
    tenantId: value.tenantId,
    workspaceId: value.workspaceId,
    accountId: value.accountId,
  });
  if (value.scoreId !== expectedScoreId) {
    context.addIssue({ code: "custom", path: ["scoreId"], message: "Health score identity does not match its account." });
  }
  if (value.scoreRevisionId !== `${value.scoreId}:v${value.revision}`) {
    context.addIssue({ code: "custom", path: ["scoreRevisionId"], message: "Health score revision identity is inconsistent." });
  }
  const expectedPrevious = value.revision === 1 ? null : `${value.scoreId}:v${value.revision - 1}`;
  if (value.previousScoreRevisionId !== expectedPrevious) {
    context.addIssue({ code: "custom", path: ["previousScoreRevisionId"], message: "Health score lineage is inconsistent." });
  }
  if ((value.scoreBasisPoints === null) !== (value.status === "unknown")) {
    context.addIssue({ code: "custom", path: ["status"], message: "Unknown health status must match an absent score." });
  }
});

export const customerHealthScoreSchema = customerHealthScoreBodySchema.extend({
  scoreSha256: sha256Schema,
}).strict().superRefine((value, context) => {
  const { scoreSha256, ...body } = value;
  if (scoreSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({ code: "custom", path: ["scoreSha256"], message: "Health score digest does not match." });
  }
});

export type CustomerHealthPolicy = z.infer<typeof customerHealthPolicySchema>;
export type CustomerHealthFactorKey = z.infer<typeof customerHealthFactorKeySchema>;
export type CustomerHealthEvidenceReference = z.infer<typeof customerHealthEvidenceReferenceSchema>;
export type CustomerHealthSuggestion = z.infer<typeof customerHealthSuggestionSchema>;
export type CustomerHealthFactorResult = z.infer<typeof customerHealthFactorResultSchema>;
export type CustomerHealthScore = z.infer<typeof customerHealthScoreSchema>;

export function buildDefaultCustomerHealthPolicy(): CustomerHealthPolicy {
  const body = customerHealthPolicyBodySchema.parse({
    schemaVersion: 1,
    contractVersion: CUSTOMER_HEALTH_CONTRACT_VERSION,
    policyVersion: CUSTOMER_HEALTH_POLICY_VERSION,
    name: "Asael evidence-first customer health",
    factors: [
      {
        factorKey: "adoption",
        label: "Adoption",
        description: "Product state, usage evidence, and explicit adoption health observations.",
        weightBasisPoints: 3_000,
        acceptedFactKinds: ["product", "usage", "health"],
        healthDimensions: ["adoption", "product", "usage", "overall"],
        aggregation: "confidence_weighted_mean",
        missingInputBehavior: "exclude_score_lower_confidence",
      },
      {
        factorKey: "support",
        label: "Support",
        description: "Cases, risks, and explicit support health observations.",
        weightBasisPoints: 2_500,
        acceptedFactKinds: ["case", "risk", "health"],
        healthDimensions: ["support", "service", "risk", "overall"],
        aggregation: "confidence_weighted_mean",
        missingInputBehavior: "exclude_score_lower_confidence",
      },
      {
        factorKey: "engagement",
        label: "Engagement",
        description: "Stakeholder state, interaction evidence, and explicit engagement health observations.",
        weightBasisPoints: 2_500,
        acceptedFactKinds: ["stakeholder", "interaction", "health"],
        healthDimensions: ["engagement", "relationship", "stakeholder", "overall"],
        aggregation: "confidence_weighted_mean",
        missingInputBehavior: "exclude_score_lower_confidence",
      },
      {
        factorKey: "commercial",
        label: "Commercial",
        description: "Renewal and opportunity evidence plus explicit commercial health observations.",
        weightBasisPoints: 2_000,
        acceptedFactKinds: ["renewal", "opportunity", "health"],
        healthDimensions: ["commercial", "renewal", "value", "overall"],
        aggregation: "confidence_weighted_mean",
        missingInputBehavior: "exclude_score_lower_confidence",
      },
    ],
    freshnessConfidenceMultipliers: {
      fresh: 10_000,
      stale: 4_000,
      future: 0,
      expired: 0,
      unknown: 7_000,
    },
    conflictingEvidenceMultiplierBasisPoints: 5_000,
    statusThresholds: {
      healthyMinimumBasisPoints: 7_500,
      watchMinimumBasisPoints: 4_500,
    },
  });
  const policySha256 = canonicalJsonSha256(body);
  return customerHealthPolicySchema.parse({
    ...body,
    policyId: `customer-health-policy:${policySha256}`,
    policySha256,
  });
}

export function customerHealthScoreId(input: {
  tenantId: string;
  workspaceId: string;
  accountId: string;
}) {
  return `customer-health-score:${canonicalJsonSha256(input)}`;
}

export function customerHealthEvaluationId(input: {
  accountId: string;
  idempotencyKey: string;
}) {
  return `customer-health-evaluation:${canonicalJsonSha256(input)}`;
}

export function buildCustomerHealthSuggestion(
  input: Omit<CustomerHealthSuggestion, "suggestionId" | "authoritative">,
): CustomerHealthSuggestion {
  const body = {
    ...input,
    citedFactRevisionIds: [...input.citedFactRevisionIds],
    citedFactSha256s: [...input.citedFactSha256s],
    authoritative: false as const,
    createdAt: canonicalTimestamp(input.createdAt),
  };
  return customerHealthSuggestionSchema.parse({
    ...body,
    suggestionId: `customer-health-suggestion:${canonicalJsonSha256(body)}`,
  });
}

export function sealCustomerHealthScore(
  input: z.input<typeof customerHealthScoreBodySchema>,
): CustomerHealthScore {
  const body = customerHealthScoreBodySchema.parse(input);
  return customerHealthScoreSchema.parse({
    ...body,
    scoreSha256: canonicalJsonSha256(body),
  });
}

function canonicalTimestamp(value: string) {
  return new Date(value).toISOString();
}

function requireUnique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: string,
) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: [path], message: `${path} must be unique.` });
  }
}
