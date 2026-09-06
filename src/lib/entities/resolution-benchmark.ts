import { z } from "zod";

import {
  ASAEL_ONTOLOGY_EFFECTIVE_AT,
  entityTypeIdSchema,
} from "@/lib/entities/ontology";
import {
  ENTITY_REGISTRY_RESOLVER_VERSION_ID,
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityRecord,
  resolveEntityIdentity,
  transitionEntityRecord,
  type EntityAccessBinding,
  type EntityRecord,
} from "@/lib/entities/registry";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const P52_BENCHMARK_SCHEMA_VERSION = 1 as const;
export const P52_BENCHMARK_SCORER_VERSION_ID =
  "p5.2-entity-resolution-scorer:1" as const;
export const P52_BENCHMARK_DIGEST_DOMAIN =
  "asael:p5.2:entity-resolution-suite:v1\u0000" as const;

const idSchema = z.string().min(1).max(160).regex(
  /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/,
);
const basisPointsSchema = z.number().int().min(0).max(10_000);
const candidateScopeSchema = z.enum([
  "owner",
  "sibling_actor",
  "alternate_access",
  "other_tenant",
]);
const benchmarkDimensionSchema = z.enum([
  "canonical_exact",
  "alias_exact",
  "normalization",
  "ambiguous_exact",
  "fuzzy_review",
  "new_identity",
  "actor_isolation",
  "access_isolation",
  "tenant_isolation",
  "type_isolation",
  "lifecycle",
]);

const benchmarkCandidateSchema = z.object({
  entityId: idSchema,
  entityTypeId: entityTypeIdSchema,
  canonicalLabel: z.string().trim().min(1).max(320),
  aliases: z.array(z.string().trim().min(1).max(320)).max(12).default([]),
  scope: candidateScopeSchema,
  state: z.enum(["active", "retired"]).default("active"),
}).strict();

const expectedDecisionSchema = z.object({
  decision: z.enum(["auto_link", "review_required", "create_new"]),
  selectedEntityId: idSchema.nullable(),
  candidateEntityIds: z.array(idSchema).max(32),
  matchMethod: z.enum([
    "exact_canonical_label",
    "exact_alias",
    "ambiguous_exact",
    "fuzzy_candidate",
    "none",
  ]),
}).strict().superRefine((value, context) => {
  if ((value.decision === "auto_link") !== (value.selectedEntityId !== null)) {
    context.addIssue({
      code: "custom",
      path: ["selectedEntityId"],
      message: "Only an expected auto-link may select an entity.",
    });
  }
});

const benchmarkCaseSchema = z.object({
  caseId: idSchema,
  dimension: benchmarkDimensionSchema,
  entityTypeId: entityTypeIdSchema,
  inputLabel: z.string().trim().min(1).max(320),
  expected: expectedDecisionSchema,
}).strict();

const benchmarkSuiteSchema = z.object({
  schemaVersion: z.literal(P52_BENCHMARK_SCHEMA_VERSION),
  suiteId: idSchema,
  dataClassification: z.literal("synthetic"),
  sideEffectPolicy: z.literal("none"),
  resolverVersionId: z.literal(ENTITY_REGISTRY_RESOLVER_VERSION_ID),
  scorerVersionId: z.literal(P52_BENCHMARK_SCORER_VERSION_ID),
  observedAt: z.string().datetime({ offset: true }),
  thresholds: z.object({
    autoLinkPrecisionBasisPoints: basisPointsSchema,
    autoLinkRecallBasisPoints: basisPointsSchema,
    reviewRecallBasisPoints: basisPointsSchema,
    decisionAccuracyBasisPoints: basisPointsSchema,
    maximumFalseAutoMerges: z.literal(0),
    maximumScopeLeaks: z.literal(0),
    maximumNondeterministicCases: z.literal(0),
  }).strict(),
  candidates: z.array(benchmarkCandidateSchema).min(1).max(128),
  cases: z.array(benchmarkCaseSchema).min(1).max(128),
}).strict().superRefine((value, context) => {
  addDuplicateIssues(
    value.candidates.map((candidate) => candidate.entityId),
    context,
    "candidates",
  );
  addDuplicateIssues(
    value.cases.map((testCase) => testCase.caseId),
    context,
    "cases",
  );
  addMissingCoverageIssues(
    benchmarkDimensionSchema.options,
    value.cases.map((testCase) => testCase.dimension),
    context,
    "cases",
  );
  addMissingCoverageIssues(
    candidateScopeSchema.options,
    value.candidates.map((candidate) => candidate.scope),
    context,
    "candidates",
  );
  addMissingCoverageIssues(
    ["auto_link", "review_required", "create_new"] as const,
    value.cases.map((testCase) => testCase.expected.decision),
    context,
    "cases",
  );
  if (!value.candidates.some((candidate) => candidate.state === "retired")) {
    context.addIssue({
      code: "custom",
      path: ["candidates"],
      message: "Benchmark coverage requires a retired candidate.",
    });
  }
});

export type P52EntityResolutionBenchmarkSuite = z.infer<
  typeof benchmarkSuiteSchema
>;

export type P52EntityResolutionBenchmarkReport = Readonly<{
  schemaVersion: typeof P52_BENCHMARK_SCHEMA_VERSION;
  suiteId: string;
  suiteSha256: string;
  resolverVersionId: typeof ENTITY_REGISTRY_RESOLVER_VERSION_ID;
  scorerVersionId: typeof P52_BENCHMARK_SCORER_VERSION_ID;
  totalCases: number;
  passedCases: number;
  autoLinkPrecisionBasisPoints: number;
  autoLinkRecallBasisPoints: number;
  reviewRecallBasisPoints: number;
  decisionAccuracyBasisPoints: number;
  falseAutoMerges: number;
  scopeLeaks: number;
  nondeterministicCases: number;
  failedCaseIds: readonly string[];
  passed: boolean;
}>;

type BenchmarkCandidate = Readonly<{
  entity: EntityRecord;
  aliases: ReturnType<typeof buildEntityAlias>[];
  scope: z.infer<typeof candidateScopeSchema>;
}>;

export function parseP52EntityResolutionBenchmarkSuite(
  value: unknown,
): P52EntityResolutionBenchmarkSuite {
  return benchmarkSuiteSchema.parse(value);
}

export function scoreP52EntityResolutionBenchmark(
  value: unknown,
): P52EntityResolutionBenchmarkReport {
  const suite = parseP52EntityResolutionBenchmarkSuite(value);
  const ownerBinding = benchmarkBinding("owner");
  const candidates = suite.candidates.map((candidate) =>
    buildBenchmarkCandidate(candidate)
  );
  const forbiddenCandidateIds = new Set(candidates
    .filter((candidate) => candidate.scope !== "owner")
    .map((candidate) => candidate.entity.entityId));
  let correctAutoLinks = 0;
  let observedAutoLinks = 0;
  let expectedAutoLinks = 0;
  let correctReviews = 0;
  let expectedReviews = 0;
  let falseAutoMerges = 0;
  let scopeLeaks = 0;
  let nondeterministicCases = 0;
  const failedCaseIds: string[] = [];

  for (const testCase of suite.cases) {
    const forward = resolveCase(testCase, ownerBinding, candidates);
    const reverse = resolveCase(testCase, ownerBinding, [...candidates].reverse());
    const actual = decisionProjection(forward);
    const deterministic = sourceContractSha256(actual) ===
      sourceContractSha256(decisionProjection(reverse));
    const expected = testCase.expected;
    const correct = deterministic &&
      actual.decision === expected.decision &&
      actual.selectedEntityId === expected.selectedEntityId &&
      actual.matchMethod === expected.matchMethod &&
      sameIds(actual.candidateEntityIds, expected.candidateEntityIds);

    if (!deterministic) nondeterministicCases += 1;
    if (!correct) failedCaseIds.push(testCase.caseId);
    if (expected.decision === "auto_link") expectedAutoLinks += 1;
    if (expected.decision === "review_required") expectedReviews += 1;
    if (actual.decision === "auto_link") {
      observedAutoLinks += 1;
      if (
        expected.decision === "auto_link" &&
        actual.selectedEntityId === expected.selectedEntityId
      ) {
        correctAutoLinks += 1;
      } else {
        falseAutoMerges += 1;
      }
    }
    if (actual.decision === "review_required" && correct) correctReviews += 1;
    scopeLeaks += actual.candidateEntityIds.filter((entityId) =>
      forbiddenCandidateIds.has(entityId)
    ).length;
  }

  const passedCases = suite.cases.length - failedCaseIds.length;
  const autoLinkPrecisionBasisPoints = ratioBasisPoints(
    correctAutoLinks,
    observedAutoLinks,
  );
  const autoLinkRecallBasisPoints = ratioBasisPoints(
    correctAutoLinks,
    expectedAutoLinks,
  );
  const reviewRecallBasisPoints = ratioBasisPoints(
    correctReviews,
    expectedReviews,
  );
  const decisionAccuracyBasisPoints = ratioBasisPoints(
    passedCases,
    suite.cases.length,
  );
  const passed =
    autoLinkPrecisionBasisPoints >= suite.thresholds.autoLinkPrecisionBasisPoints &&
    autoLinkRecallBasisPoints >= suite.thresholds.autoLinkRecallBasisPoints &&
    reviewRecallBasisPoints >= suite.thresholds.reviewRecallBasisPoints &&
    decisionAccuracyBasisPoints >= suite.thresholds.decisionAccuracyBasisPoints &&
    falseAutoMerges <= suite.thresholds.maximumFalseAutoMerges &&
    scopeLeaks <= suite.thresholds.maximumScopeLeaks &&
    nondeterministicCases <= suite.thresholds.maximumNondeterministicCases;

  return Object.freeze({
    schemaVersion: P52_BENCHMARK_SCHEMA_VERSION,
    suiteId: suite.suiteId,
    suiteSha256: sourceContractSha256({
      domain: P52_BENCHMARK_DIGEST_DOMAIN,
      suite,
    }),
    resolverVersionId: ENTITY_REGISTRY_RESOLVER_VERSION_ID,
    scorerVersionId: P52_BENCHMARK_SCORER_VERSION_ID,
    totalCases: suite.cases.length,
    passedCases,
    autoLinkPrecisionBasisPoints,
    autoLinkRecallBasisPoints,
    reviewRecallBasisPoints,
    decisionAccuracyBasisPoints,
    falseAutoMerges,
    scopeLeaks,
    nondeterministicCases,
    failedCaseIds: Object.freeze(failedCaseIds),
    passed,
  });
}

function resolveCase(
  testCase: P52EntityResolutionBenchmarkSuite["cases"][number],
  accessBinding: EntityAccessBinding,
  candidates: readonly BenchmarkCandidate[],
) {
  return resolveEntityIdentity({
    entityTypeId: testCase.entityTypeId,
    label: testCase.inputLabel,
    accessBinding,
    candidates,
    decidedAt: benchmarkTimestamp(testCase.caseId),
  });
}

function buildBenchmarkCandidate(
  candidate: P52EntityResolutionBenchmarkSuite["candidates"][number],
): BenchmarkCandidate {
  const accessBinding = benchmarkBinding(candidate.scope);
  const lineage = {
    kind: "evidence_unit" as const,
    referenceId: `synthetic:${candidate.entityId}`,
    referenceSha256: sourceContractSha256(`synthetic:${candidate.entityId}`),
  };
  const active = buildEntityRecord({
    entityId: candidate.entityId,
    entityTypeId: candidate.entityTypeId,
    canonicalLabel: candidate.canonicalLabel,
    accessBinding,
    lineage: [lineage],
    createdAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
  });
  const entity = candidate.state === "retired"
    ? transitionEntityRecord({
        entity: active,
        state: "retired",
        updatedAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
      })
    : active;
  return Object.freeze({
    entity,
    aliases: candidate.aliases.map((alias) => buildEntityAlias({
      entity: active,
      alias,
      lineage,
      createdAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
    })),
    scope: candidate.scope,
  });
}

function benchmarkBinding(
  scope: z.infer<typeof candidateScopeSchema>,
): EntityAccessBinding {
  return buildEntityAccessBinding({
    tenantId: scope === "other_tenant"
      ? "synthetic:tenant-other"
      : "synthetic:tenant-benchmark",
    ownerActorId: scope === "sibling_actor"
      ? "synthetic:actor-sibling"
      : "synthetic:actor-owner",
    visibility: "user_private",
    sensitivity: scope === "alternate_access" ? "restricted" : "confidential",
    allowedPurposeIds: scope === "alternate_access"
      ? ["entity.read.v1", "entity.resolve.v1", "entity.review.v1"]
      : [
          "entity.read.v1",
          "entity.resolve.v1",
          "entity.review.v1",
          "entity.write.v1",
        ],
    boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
  });
}

function decisionProjection(
  decision: ReturnType<typeof resolveEntityIdentity>,
) {
  return {
    decision: decision.decision,
    selectedEntityId: decision.selectedEntityId,
    candidateEntityIds: decision.candidateEntityIds,
    matchMethod: decision.matchMethod,
    scoreBasisPoints: decision.scoreBasisPoints,
  };
}

function ratioBasisPoints(numerator: number, denominator: number) {
  return denominator === 0 ? 0 : Math.round(numerator / denominator * 10_000);
}

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function benchmarkTimestamp(caseId: string) {
  const seconds = Number.parseInt(sourceContractSha256(caseId).slice(0, 6), 16);
  return new Date(Date.parse(ASAEL_ONTOLOGY_EFFECTIVE_AT) + seconds).toISOString();
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: "candidates" | "cases",
) {
  const seen = new Set<string>();
  values.forEach((value, index) => {
    if (seen.has(value)) {
      context.addIssue({
        code: "custom",
        path: [path, index],
        message: `Duplicate benchmark identifier: ${value}`,
      });
    }
    seen.add(value);
  });
}

function addMissingCoverageIssues(
  required: readonly string[],
  observed: readonly string[],
  context: z.RefinementCtx,
  path: "candidates" | "cases",
) {
  const observedSet = new Set(observed);
  for (const value of required) {
    if (!observedSet.has(value)) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: `Benchmark coverage is missing: ${value}`,
      });
    }
  }
}
