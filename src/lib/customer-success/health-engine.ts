import {
  customerAccount360Schema,
  type CustomerFactValue,
  type CustomerFactView,
} from "@/lib/customer-success/contracts";
import {
  buildDefaultCustomerHealthPolicy,
  customerHealthPolicySchema,
  customerHealthSuggestionSchema,
  sealCustomerHealthScore,
  type CustomerHealthEvidenceReference,
  type CustomerHealthFactorKey,
  type CustomerHealthFactorResult,
  type CustomerHealthPolicy,
  type CustomerHealthScore,
  type CustomerHealthSuggestion,
} from "@/lib/customer-success/health-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export class CustomerHealthEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CustomerHealthEvidenceError";
  }
}

export function evaluateCustomerHealth(input: {
  account360: unknown;
  revision: number;
  evaluationId: string;
  evaluatedByActorId: string;
  evaluatedAt: string;
  policy?: CustomerHealthPolicy;
  suggestions?: readonly CustomerHealthSuggestion[];
}): CustomerHealthScore {
  const account360 = customerAccount360Schema.parse(input.account360);
  const evaluatedAt = new Date(input.evaluatedAt).toISOString();
  const policy = customerHealthPolicySchema.parse(
    input.policy || buildDefaultCustomerHealthPolicy(),
  );
  const suggestions = validateSuggestions(
    input.suggestions || [],
    account360.facts,
  );
  const factors = policy.factors.map((factor) => {
    const matching = account360.facts.filter((view) =>
      factor.acceptedFactKinds.includes(view.fact.kind) &&
      factMatchesFactor(view, factor.factorKey, factor.healthDimensions)
    );
    const evidence = matching.map((view) => evidenceReference(view, policy, evaluatedAt));
    return factorResult({
      factorKey: factor.factorKey,
      label: factor.label,
      weightBasisPoints: factor.weightBasisPoints,
      evidence,
    });
  });
  const scoredFactors = factors.filter(
    (factor): factor is CustomerHealthFactorResult & { scoreBasisPoints: number } =>
      factor.scoreBasisPoints !== null,
  );
  const coverageBasisPoints = scoredFactors.reduce(
    (sum, factor) => sum + factor.weightBasisPoints,
    0,
  );
  const scoreBasisPoints = coverageBasisPoints === 0
    ? null
    : roundBasisPoints(
      scoredFactors.reduce(
        (sum, factor) => sum + factor.scoreBasisPoints * factor.weightBasisPoints,
        0,
      ) / coverageBasisPoints,
    );
  const confidenceBasisPoints = roundBasisPoints(
    factors.reduce(
      (sum, factor) => sum + factor.confidenceBasisPoints * factor.weightBasisPoints,
      0,
    ) / 10_000,
  );
  const scoreId = `customer-health-score:${canonicalJsonSha256({
    tenantId: account360.account.tenantId,
    workspaceId: account360.account.workspaceId,
    accountId: account360.account.accountId,
  })}`;
  const inputSha256 = canonicalJsonSha256({
    accountRevisionId: account360.account.revisionId,
    accountSha256: account360.account.accountSha256,
    policySha256: policy.policySha256,
    evaluatedAt,
    facts: account360.facts.map((view) => ({
      factRevisionId: view.fact.factRevisionId,
      factSha256: view.fact.factSha256,
      freshness: view.freshness.status,
      conflict: view.conflict.state,
    })),
  });
  return sealCustomerHealthScore({
    schemaVersion: 1,
    contractVersion: "p10.12-customer-health:1",
    tenantId: account360.account.tenantId,
    workspaceId: account360.account.workspaceId,
    accountId: account360.account.accountId,
    scoreId,
    scoreRevisionId: `${scoreId}:v${input.revision}`,
    revision: input.revision,
    previousScoreRevisionId: input.revision === 1
      ? null
      : `${scoreId}:v${input.revision - 1}`,
    evaluationId: input.evaluationId,
    accountRevisionId: account360.account.revisionId,
    accountSha256: account360.account.accountSha256,
    inputSha256,
    policy,
    scoreBasisPoints,
    status: healthStatus(scoreBasisPoints, policy),
    confidenceBasisPoints,
    coverageBasisPoints,
    factors,
    suggestions,
    authority: "deterministic_policy",
    evaluatedByActorId: input.evaluatedByActorId,
    evaluatedAt,
  });
}

function validateSuggestions(
  input: readonly CustomerHealthSuggestion[],
  facts: readonly CustomerFactView[],
) {
  const evidence = new Map(
    facts.map((view) => [view.fact.factRevisionId, view.fact.factSha256]),
  );
  return input.map((candidate) => {
    const suggestion = customerHealthSuggestionSchema.parse(candidate);
    suggestion.citedFactRevisionIds.forEach((revisionId, index) => {
      if (evidence.get(revisionId) !== suggestion.citedFactSha256s[index]) {
        throw new CustomerHealthEvidenceError(
          "A model suggestion cites evidence outside the current Account 360 projection.",
        );
      }
    });
    return suggestion;
  });
}

function evidenceReference(
  view: CustomerFactView,
  policy: CustomerHealthPolicy,
  evaluatedAt: string,
): CustomerHealthEvidenceReference {
  const freshnessMultiplierBasisPoints =
    policy.freshnessConfidenceMultipliers[view.freshness.status];
  const conflictMultiplierBasisPoints = view.conflict.state === "conflicting"
    ? policy.conflictingEvidenceMultiplierBasisPoints
    : 10_000;
  const effectiveConfidenceBasisPoints = roundBasisPoints(
    view.fact.confidenceBasisPoints *
      freshnessMultiplierBasisPoints *
      conflictMultiplierBasisPoints /
      100_000_000,
  );
  return {
    factId: view.fact.factId,
    factRevisionId: view.fact.factRevisionId,
    factSha256: view.fact.factSha256,
    sourceRevisionId: view.fact.source.sourceRevisionId,
    sourceRevisionSha256: view.fact.source.sourceRevisionSha256,
    valueSha256: view.fact.valueSha256,
    freshnessStatus: view.freshness.status,
    rawScoreBasisPoints: rawFactScore(view.fact.value, evaluatedAt),
    sourceConfidenceBasisPoints: view.fact.confidenceBasisPoints,
    freshnessMultiplierBasisPoints,
    conflictMultiplierBasisPoints,
    effectiveConfidenceBasisPoints,
  };
}

function factorResult(input: {
  factorKey: CustomerHealthFactorKey;
  label: string;
  weightBasisPoints: number;
  evidence: CustomerHealthEvidenceReference[];
}): CustomerHealthFactorResult {
  if (input.evidence.length === 0) {
    return {
      ...input,
      scoreBasisPoints: null,
      confidenceBasisPoints: 0,
      evidenceState: "missing",
    };
  }
  const scorable = input.evidence.filter(
    (reference): reference is CustomerHealthEvidenceReference & { rawScoreBasisPoints: number } =>
      reference.rawScoreBasisPoints !== null &&
      reference.effectiveConfidenceBasisPoints > 0,
  );
  const confidenceWeight = scorable.reduce(
    (sum, reference) => sum + reference.effectiveConfidenceBasisPoints,
    0,
  );
  if (confidenceWeight === 0) {
    return {
      ...input,
      scoreBasisPoints: null,
      confidenceBasisPoints: 0,
      evidenceState: "unscorable",
    };
  }
  const scoreBasisPoints = roundBasisPoints(
    scorable.reduce(
      (sum, reference) =>
        sum + reference.rawScoreBasisPoints * reference.effectiveConfidenceBasisPoints,
      0,
    ) / confidenceWeight,
  );
  const confidenceBasisPoints = roundBasisPoints(confidenceWeight / scorable.length);
  const staleOnly = scorable.every((reference) => reference.freshnessStatus === "stale");
  return {
    ...input,
    scoreBasisPoints,
    confidenceBasisPoints,
    evidenceState: staleOnly ? "stale_only" : "available",
  };
}

function factMatchesFactor(
  view: CustomerFactView,
  factorKey: CustomerHealthFactorKey,
  healthDimensions: readonly string[],
) {
  if (view.fact.value.kind !== "health") return factFactor(view.fact.value.kind) === factorKey;
  const dimension = normalizedToken(view.fact.value.dimension);
  return healthDimensions.includes(dimension);
}

function factFactor(kind: CustomerFactValue["kind"]): CustomerHealthFactorKey | undefined {
  if (["product", "usage"].includes(kind)) return "adoption";
  if (["case", "risk"].includes(kind)) return "support";
  if (["stakeholder", "interaction"].includes(kind)) return "engagement";
  if (["renewal", "opportunity"].includes(kind)) return "commercial";
  return undefined;
}

function rawFactScore(value: CustomerFactValue, evaluatedAt: string): number | null {
  switch (value.kind) {
    case "health":
      return value.scoreBasisPoints ?? ({
        healthy: 9_000,
        watch: 5_500,
        at_risk: 2_000,
        unknown: null,
      } as const)[value.status];
    case "product":
      return ({ active: 9_000, trial: 7_000, paused: 3_500, ended: 1_000, unknown: null } as const)[value.status];
    case "stakeholder":
      return ({ champion: 9_500, supportive: 8_000, neutral: 5_500, detractor: 1_500, unknown: null } as const)[value.stance];
    case "risk":
      if (value.status === "resolved") return 9_500;
      return riskScore(value.severity, value.status === "mitigating");
    case "case":
      if (["closed", "resolved"].includes(normalizedToken(value.status))) return 9_500;
      return ({ low: 7_500, medium: 5_500, high: 2_500, critical: 0, unknown: null } as const)[value.severity];
    case "renewal":
      return ({ renewed: 9_500, committed: 8_500, proposed: 7_000, planning: 6_000, unplanned: 3_500, lost: 0 } as const)[value.status];
    case "opportunity":
      return opportunityScore(value.stage);
    case "interaction":
      return interactionScore(value.occurredAt, evaluatedAt);
    default:
      return null;
  }
}

function riskScore(
  severity: "low" | "medium" | "high" | "critical",
  mitigating: boolean,
) {
  const open = { low: 7_000, medium: 5_000, high: 2_500, critical: 0 } as const;
  const mitigated = { low: 8_000, medium: 7_000, high: 6_000, critical: 4_500 } as const;
  return (mitigating ? mitigated : open)[severity];
}

function opportunityScore(stage: string) {
  const scores: Record<string, number> = {
    closed_won: 9_500,
    won: 9_500,
    negotiation_review: 7_500,
    negotiation: 7_500,
    proposal_price_quote: 6_500,
    proposal: 6_500,
    value_proposition: 6_000,
    needs_analysis: 5_500,
    qualification: 5_500,
    discovery: 5_500,
    prospecting: 4_500,
    closed_lost: 0,
    lost: 0,
  };
  return scores[normalizedToken(stage)] ?? null;
}

function interactionScore(occurredAt: string, evaluatedAt: string) {
  const ageDays = Math.max(
    0,
    (new Date(evaluatedAt).getTime() - new Date(occurredAt).getTime()) / 86_400_000,
  );
  if (ageDays <= 14) return 9_000;
  if (ageDays <= 30) return 7_500;
  if (ageDays <= 60) return 5_500;
  if (ageDays <= 90) return 3_500;
  return 1_500;
}

function healthStatus(
  scoreBasisPoints: number | null,
  policy: CustomerHealthPolicy,
) {
  if (scoreBasisPoints === null) return "unknown" as const;
  if (scoreBasisPoints >= policy.statusThresholds.healthyMinimumBasisPoints) {
    return "healthy" as const;
  }
  if (scoreBasisPoints >= policy.statusThresholds.watchMinimumBasisPoints) {
    return "watch" as const;
  }
  return "at_risk" as const;
}

function normalizedToken(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function roundBasisPoints(value: number) {
  return Math.max(0, Math.min(10_000, Math.round(value)));
}
