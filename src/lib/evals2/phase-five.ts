import {
  buildGraphRelationshipPaths,
  type ResolvedLineageEvidence,
} from "@/lib/entities/graph-retrieval";
import {
  POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID,
  readGraphStorageSnapshot,
  type GraphStorageAdapter,
} from "@/lib/entities/graph-storage-adapter";
import {
  summarizeGraphQueryTelemetry,
} from "@/lib/entities/graph-query-telemetry";
import {
  ASAEL_ONTOLOGY_SCHEMA_VERSION,
  asaelOntologyV1,
  parseOntologyRegistry,
} from "@/lib/entities/ontology";
import {
  reconcileRelationProjectionState,
  relationProjectionActiveStateSha256,
} from "@/lib/entities/relation-reconciliation";
import {
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
  type EntityAccessBinding,
  type EntityRecord,
} from "@/lib/entities/registry";
import {
  P52_BENCHMARK_SCHEMA_VERSION,
  scoreP52EntityResolutionBenchmark,
} from "@/lib/entities/resolution-benchmark";
import {
  buildTemporalRelationClaim,
  relationClaimIsVisibleAt,
  reviseTemporalRelationClaim,
  TEMPORAL_RELATION_CLAIM_SCHEMA_VERSION,
  type TemporalRelationClaimRecord,
  type TemporalRelationClaimRevision,
} from "@/lib/entities/temporal-claims";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const PHASE_FIVE_GATE_SCHEMA_VERSION = 1 as const;
export const PHASE_FIVE_GATE_SUITE_ID =
  "p5-production-phase-gate-v1" as const;

const FIXED_AT = "2026-09-07T00:00:00.000Z";
const VALID_FROM = "2026-01-01T00:00:00.000Z";
const VALID_AT = "2026-02-15T00:00:00.000Z";
const RECORDED_AT = "2026-02-01T00:00:00.000Z";
const SUPERSEDED_AT = "2026-03-01T00:00:00.000Z";
const VALID_TO = "2026-04-01T00:00:00.000Z";

type PhaseFiveGateId =
  | "p5.1"
  | "p5.2"
  | "p5.3"
  | "p5.4"
  | "p5.5"
  | "p5.6";

export type PhaseFiveGateObservation = Readonly<{
  gateId: PhaseFiveGateId;
  passed: boolean;
  evidenceCount: number;
  contractVersion: number;
}>;

/**
 * Fixed, content-free aggregate gate for P5.1-P5.6. The gate runs the actual
 * graph contracts over synthetic fixtures and grants no persistence, model,
 * governed-tool, or external-effect authority.
 */
export async function runPhaseFiveGate(input: {
  tenantId: string;
  actorId: string;
  correlationId: string;
  entityResolutionSuite: unknown;
}) {
  const ontology = evaluateOntology();
  const resolution = scoreP52EntityResolutionBenchmark(
    input.entityResolutionSuite,
  );
  const fixture = buildFixture(input);
  const temporal = evaluateTemporalClaims(fixture);
  const projection = evaluateProjection(fixture);
  const retrieval = evaluateRetrieval(fixture);
  const storage = await evaluateStorage(fixture);

  const observations: PhaseFiveGateObservation[] = [
    Object.freeze({
      gateId: "p5.1",
      passed: ontology.passed,
      evidenceCount: ontology.entityTypeCount + ontology.relationTypeCount,
      contractVersion: ASAEL_ONTOLOGY_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p5.2",
      passed:
        resolution.passed &&
        resolution.falseAutoMerges === 0 &&
        resolution.scopeLeaks === 0 &&
        resolution.nondeterministicCases === 0,
      evidenceCount: resolution.passedCases,
      contractVersion: P52_BENCHMARK_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p5.3",
      passed: temporal.passedCaseCount === temporal.caseCount,
      evidenceCount: temporal.passedCaseCount,
      contractVersion: TEMPORAL_RELATION_CLAIM_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p5.4",
      passed:
        projection.rebuildParityBasisPoints === 10_000 &&
        projection.orphanEvidenceCount === 0 &&
        projection.deletionPropagationPassed,
      evidenceCount: projection.comparisonCount,
      contractVersion: TEMPORAL_RELATION_CLAIM_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p5.5",
      passed:
        retrieval.multiHopPathCount > 0 &&
        retrieval.unevidencedHopCount === 0 &&
        retrieval.crossScopeLeakCount === 0 &&
        retrieval.crossScopeRejectionCount > 0,
      evidenceCount: retrieval.evidencedHopCount,
      contractVersion: 1,
    }),
    Object.freeze({
      gateId: "p5.6",
      passed:
        storage.storageParityBasisPoints === 10_000 &&
        storage.shadowState === "matched" &&
        storage.primaryAdapterId === POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID &&
        storage.disposition === "collect_more_telemetry" &&
        !storage.shadowPromotionReady,
      evidenceCount: storage.comparisonCount,
      contractVersion: 1,
    }),
  ];
  const failedGateIds = observations
    .filter((observation) => !observation.passed)
    .map((observation) => observation.gateId);
  const reportBody = {
    schemaVersion: PHASE_FIVE_GATE_SCHEMA_VERSION,
    suiteId: PHASE_FIVE_GATE_SUITE_ID,
    gateCount: observations.length,
    passedGateCount: observations.length - failedGateIds.length,
    failedGateIds: Object.freeze(failedGateIds),
    ontologyEntityTypeCount: ontology.entityTypeCount,
    ontologyRelationTypeCount: ontology.relationTypeCount,
    entityResolutionCaseCount: resolution.totalCases,
    entityResolutionPassedCaseCount: resolution.passedCases,
    entityResolutionPrecisionBasisPoints:
      resolution.autoLinkPrecisionBasisPoints,
    entityResolutionScopeLeakCount: resolution.scopeLeaks,
    entityResolutionFalseAutoMergeCount: resolution.falseAutoMerges,
    temporalCaseCount: temporal.caseCount,
    temporalPassedCaseCount: temporal.passedCaseCount,
    orphanEvidenceCount: projection.orphanEvidenceCount,
    projectionComparisonCount: projection.comparisonCount,
    rebuildParityBasisPoints: projection.rebuildParityBasisPoints,
    deletionPropagationPassed: projection.deletionPropagationPassed,
    relationshipPathCount: retrieval.pathCount,
    multiHopPathCount: retrieval.multiHopPathCount,
    relationshipHopCount: retrieval.hopCount,
    evidencedRelationshipHopCount: retrieval.evidencedHopCount,
    unevidencedRelationshipHopCount: retrieval.unevidencedHopCount,
    crossScopeRejectionCount: retrieval.crossScopeRejectionCount,
    crossScopeLeakCount: retrieval.crossScopeLeakCount,
    storagePrimaryAdapterId: storage.primaryAdapterId,
    storageShadowState: storage.shadowState,
    storageParityBasisPoints: storage.storageParityBasisPoints,
    storageDisposition: storage.disposition,
    graphDatabasePromotionReady: storage.shadowPromotionReady,
    effectCount: 0,
    passed: failedGateIds.length === 0,
  };
  const suiteSha256 = sourceContractSha256({
    schemaVersion: PHASE_FIVE_GATE_SCHEMA_VERSION,
    suiteId: PHASE_FIVE_GATE_SUITE_ID,
    ontologySha256: asaelOntologyV1.ontologySha256,
    entityResolutionSuiteSha256: resolution.suiteSha256,
    temporalEvidenceSha256: temporal.evidenceSha256,
    projectionEvidenceSha256: projection.evidenceSha256,
    retrievalReceiptSha256: retrieval.receiptSha256,
    storageComparisonSha256: storage.comparisonSha256,
    storageDecisionSha256: storage.decisionSha256,
  });

  return Object.freeze({
    report: Object.freeze({ ...reportBody, suiteSha256 }),
    observations: Object.freeze(observations),
  });
}

function evaluateOntology() {
  const ontology = parseOntologyRegistry(asaelOntologyV1);
  const definitions = [
    ...ontology.entityTypes,
    ...ontology.relationTypes,
  ];
  return {
    entityTypeCount: ontology.entityTypes.length,
    relationTypeCount: ontology.relationTypes.length,
    passed:
      ontology.entityTypes.length === 17 &&
      ontology.relationTypes.length === 13 &&
      definitions.every((definition) =>
        definition.scope === "required" &&
        definition.sensitivity === "required" &&
        definition.allowedPurposeIds === "required" &&
        definition.lineage === "required"
      ),
  };
}

type PhaseFiveFixture = ReturnType<typeof buildFixture>;

function buildFixture(input: {
  tenantId: string;
  actorId: string;
  correlationId: string;
}) {
  const binding = buildEntityAccessBinding({
    tenantId: input.tenantId,
    ownerActorId: input.actorId,
    visibility: "user_private",
    sensitivity: "confidential",
    allowedPurposeIds: ENTITY_PURPOSE_IDS,
    boundAt: FIXED_AT,
  });
  const foreignBinding = buildEntityAccessBinding({
    tenantId: input.tenantId,
    ownerActorId: `${input.actorId}:sibling`,
    visibility: "user_private",
    sensitivity: "confidential",
    allowedPurposeIds: ENTITY_PURPOSE_IDS,
    boundAt: FIXED_AT,
  });
  const memoryA = lineage("memory", "synthetic-memory-a", "a");
  const memoryB = lineage("memory", "synthetic-memory-b", "b");
  const foreignMemory = lineage("memory", "synthetic-memory-foreign", "c");
  const ada = entity("synthetic-entity-ada", "person", "Ada Lovelace", binding, memoryA);
  const acme = entity("synthetic-entity-acme", "organization", "Acme Labs", binding, memoryA);
  const phoenix = entity("synthetic-entity-phoenix", "project", "Project Phoenix", binding, memoryB);
  const analyticalSociety = entity(
    "synthetic-entity-analytical",
    "organization",
    "Analytical Society",
    binding,
    memoryB,
  );
  const foreignPerson = entity(
    "synthetic-entity-foreign-person",
    "person",
    "Private Sibling",
    foreignBinding,
    foreignMemory,
  );
  const foreignOrganization = entity(
    "synthetic-entity-foreign-organization",
    "organization",
    "Private Organization",
    foreignBinding,
    foreignMemory,
  );
  const affiliation = buildTemporalRelationClaim({
    claimId: "synthetic-claim-affiliation",
    relationTypeId: "affiliated_with",
    sourceEntity: ada,
    targetEntity: acme,
    epistemicKind: "asserted",
    confidenceBasisPoints: 10_000,
    accessBinding: binding,
    lineage: [memoryA],
    validFrom: VALID_FROM,
    recordedAt: RECORDED_AT,
  });
  const projectOwnership = buildTemporalRelationClaim({
    claimId: "synthetic-claim-project",
    relationTypeId: "belongs_to",
    sourceEntity: phoenix,
    targetEntity: acme,
    epistemicKind: "observed",
    confidenceBasisPoints: 9_500,
    accessBinding: binding,
    lineage: [memoryB],
    validFrom: VALID_FROM,
    recordedAt: RECORDED_AT,
  });
  const conflictingAffiliation = buildTemporalRelationClaim({
    claimId: "synthetic-claim-conflict",
    relationTypeId: "affiliated_with",
    sourceEntity: ada,
    targetEntity: analyticalSociety,
    epistemicKind: "observed",
    confidenceBasisPoints: 9_000,
    accessBinding: binding,
    lineage: [memoryB],
    validFrom: VALID_FROM,
    recordedAt: RECORDED_AT,
  });
  const foreignAffiliation = buildTemporalRelationClaim({
    claimId: "synthetic-claim-foreign",
    relationTypeId: "affiliated_with",
    sourceEntity: foreignPerson,
    targetEntity: foreignOrganization,
    epistemicKind: "asserted",
    confidenceBasisPoints: 10_000,
    accessBinding: foreignBinding,
    lineage: [foreignMemory],
    validFrom: VALID_FROM,
    recordedAt: RECORDED_AT,
  });
  const executionScope = createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "user",
    executingPrincipalId: input.actorId,
    correlationId: input.correlationId,
    purpose: "entity.read.v1",
  });
  const evidence = [memoryA, memoryB, foreignMemory].map(evidenceFor);

  return {
    binding,
    foreignBinding,
    executionScope,
    entities: [ada, acme, phoenix],
    foreignEntities: [foreignPerson, foreignOrganization],
    aliases: [buildEntityAlias({
      entity: ada,
      alias: "Countess Ada",
      lineage: memoryA,
      createdAt: FIXED_AT,
    })],
    claims: [affiliation, projectOwnership],
    conflictingAffiliation,
    foreignAffiliation,
    evidence,
  };
}

function evaluateTemporalClaims(fixture: PhaseFiveFixture) {
  const original = fixture.claims[0];
  const revision = reviseTemporalRelationClaim({
    current: original,
    validTo: VALID_TO,
    recordedAt: SUPERSEDED_AT,
  });
  const originalRecord = { claim: original, supersededAt: SUPERSEDED_AT };
  const revisedRecord = { claim: revision, supersededAt: null };
  const epistemicKinds = new Set([
    ...fixture.claims,
    fixture.conflictingAffiliation,
  ].map((claim) => claim.epistemicKind));
  let crossScopeRejected = false;
  try {
    buildTemporalRelationClaim({
      relationTypeId: "affiliated_with",
      sourceEntity: fixture.entities[0],
      targetEntity: fixture.foreignEntities[1],
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: fixture.binding,
      lineage: [fixture.claims[0].lineage[0]],
      validFrom: VALID_FROM,
      recordedAt: RECORDED_AT,
    });
  } catch {
    crossScopeRejected = true;
  }
  const cases = [
    epistemicKinds.has("asserted") && epistemicKinds.has("observed"),
    relationClaimIsVisibleAt(originalRecord, {
      validAt: VALID_AT,
      recordedAt: "2026-02-15T00:00:00.000Z",
    }),
    !relationClaimIsVisibleAt(originalRecord, {
      validAt: VALID_AT,
      recordedAt: SUPERSEDED_AT,
    }),
    relationClaimIsVisibleAt(revisedRecord, {
      validAt: VALID_AT,
      recordedAt: SUPERSEDED_AT,
    }),
    !relationClaimIsVisibleAt(revisedRecord, {
      validAt: VALID_TO,
      recordedAt: SUPERSEDED_AT,
    }),
    revision.previousRevisionId === original.revisionId,
    fixture.conflictingAffiliation.claimId !== original.claimId &&
      fixture.conflictingAffiliation.target.entityId !== original.target.entityId,
    crossScopeRejected,
  ];
  return {
    caseCount: cases.length,
    passedCaseCount: cases.filter(Boolean).length,
    evidenceSha256: sourceContractSha256({
      caseResults: cases,
      originalClaimSha256: original.claimSha256,
      revisionClaimSha256: revision.claimSha256,
      conflictClaimSha256: fixture.conflictingAffiliation.claimSha256,
    }),
  };
}

function evaluateProjection(fixture: PhaseFiveFixture) {
  const initial = reconcileRelationProjectionState({
    desiredClaims: fixture.claims,
    currentRecords: [],
    reconciledAt: SUPERSEDED_AT,
  });
  const replay = reconcileRelationProjectionState({
    desiredClaims: fixture.claims,
    currentRecords: fixture.claims.map(activeRecord),
    reconciledAt: "2026-03-02T00:00:00.000Z",
  });
  const deleted = reconcileRelationProjectionState({
    desiredClaims: [],
    currentRecords: fixture.claims.map(activeRecord),
    reconciledAt: "2026-03-03T00:00:00.000Z",
  });
  const comparisons = [
    initial.stateSha256 === replay.stateSha256,
    replay.stateSha256 === relationProjectionActiveStateSha256(fixture.claims),
    replay.appendedRevisions.length === 0,
    deleted.stateSha256 === relationProjectionActiveStateSha256([]),
  ];
  const evidenceKeys = new Set(fixture.evidence.map((candidate) =>
    evidenceKey(
      candidate.referenceKind,
      candidate.referenceId,
      candidate.referenceSha256,
    )
  ));
  const orphanEvidenceCount = fixture.claims.flatMap((claim) => claim.lineage)
    .filter((reference) => !evidenceKeys.has(evidenceKey(
      reference.kind,
      reference.referenceId,
      reference.referenceSha256,
    ))).length;
  const matched = comparisons.filter(Boolean).length;
  return {
    comparisonCount: comparisons.length,
    rebuildParityBasisPoints: ratioBasisPoints(matched, comparisons.length),
    orphanEvidenceCount,
    deletionPropagationPassed:
      deleted.retractedCount === fixture.claims.length &&
      deleted.activeClaims.length === 0,
    evidenceSha256: sourceContractSha256({
      comparisons,
      initialStateSha256: initial.stateSha256,
      replayStateSha256: replay.stateSha256,
      deletedStateSha256: deleted.stateSha256,
      orphanEvidenceCount,
    }),
  };
}

function evaluateRetrieval(fixture: PhaseFiveFixture) {
  const result = buildGraphRelationshipPaths({
    query: "What project is Countess Ada connected to?",
    accessBinding: fixture.binding,
    entities: [...fixture.entities, ...fixture.foreignEntities],
    aliases: fixture.aliases,
    relations: [
      ...fixture.claims.map(activeRecord),
      activeRecord(fixture.foreignAffiliation),
    ],
    evidence: fixture.evidence,
    maxHops: 2,
    limit: 12,
    asOfTime: VALID_AT,
  });
  const hops = result.paths.flatMap((path) => path.hops);
  const foreignEntityIds = new Set(
    fixture.foreignEntities.map((entity) => entity.entityId),
  );
  const returnedEntityIds = result.paths.flatMap((path) => [
    path.anchor.entityId,
    path.terminal.entityId,
    ...path.hops.flatMap((hop) => [
      hop.source.entityId,
      hop.target.entityId,
    ]),
  ]);
  return {
    pathCount: result.paths.length,
    multiHopPathCount: result.paths.filter((path) => path.hopCount > 1).length,
    hopCount: hops.length,
    evidencedHopCount: hops.filter((hop) => hop.evidence.length > 0).length,
    unevidencedHopCount: hops.filter((hop) => hop.evidence.length === 0).length,
    crossScopeRejectionCount: result.receipt.rejectedRelationCount,
    crossScopeLeakCount: returnedEntityIds.filter((entityId) =>
      foreignEntityIds.has(entityId)
    ).length,
    receiptSha256: result.receipt.receiptSha256,
  };
}

async function evaluateStorage(fixture: PhaseFiveFixture) {
  const snapshotBody = {
    entities: fixture.entities,
    aliases: fixture.aliases,
    relations: fixture.claims.map(activeRecord),
    entityCount: fixture.entities.length,
    aliasCount: fixture.aliases.length,
    relationCount: fixture.claims.length,
    relationLimitSaturated: false,
  };
  const primary: GraphStorageAdapter = Object.freeze({
    adapterId: POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID,
    async readSnapshot() {
      return snapshotBody;
    },
  });
  const shadow: GraphStorageAdapter = Object.freeze({
    adapterId: "synthetic-shadow:1",
    async readSnapshot() {
      return snapshotBody;
    },
  });
  const comparison = await readGraphStorageSnapshot({
    read: {
      accessBinding: fixture.binding,
      executionScope: fixture.executionScope,
      asOfTime: VALID_AT,
      relationLimit: 32,
    },
    primary,
    shadow,
  });
  const decision = summarizeGraphQueryTelemetry([], {
    windowHours: 168,
    generatedAt: FIXED_AT,
    primaryAdapterId: POSTGRES_TEMPORAL_GRAPH_ADAPTER_ID,
    correlationId: fixture.executionScope.correlationId,
  });
  return {
    primaryAdapterId: comparison.shadow.primaryAdapterId,
    shadowState: comparison.shadow.state,
    storageParityBasisPoints:
      comparison.shadow.state === "matched" ? 10_000 : 0,
    disposition: decision.disposition,
    shadowPromotionReady: decision.shadowPromotionReady,
    comparisonCount: 1,
    comparisonSha256: comparison.shadow.comparisonSha256,
    decisionSha256: decision.reportSha256,
  };
}

function entity(
  entityId: string,
  entityTypeId: EntityRecord["entityTypeId"],
  canonicalLabel: string,
  accessBinding: EntityAccessBinding,
  entityLineage: EntityRecord["lineage"][number],
) {
  return buildEntityRecord({
    entityId,
    entityTypeId,
    canonicalLabel,
    accessBinding,
    lineage: [entityLineage],
    createdAt: FIXED_AT,
  });
}

function lineage(
  kind: "memory",
  referenceId: string,
  digestCharacter: string,
) {
  return {
    kind,
    referenceId,
    referenceSha256: digestCharacter.repeat(64),
  } as const;
}

function evidenceFor(
  reference: ReturnType<typeof lineage>,
): ResolvedLineageEvidence {
  return {
    referenceKind: reference.kind,
    referenceId: reference.referenceId,
    referenceSha256: reference.referenceSha256,
    evidence: {
      evidenceId: `synthetic:${sourceContractSha256(reference).slice(0, 32)}`,
      kind: "memory",
      title: "Synthetic evidence",
      excerpt: "Synthetic explicit assertion.",
      source: "synthetic",
      observedAt: FIXED_AT,
    },
  };
}

function activeRecord(
  claim: TemporalRelationClaimRevision,
): TemporalRelationClaimRecord {
  return { claim, supersededAt: null };
}

function evidenceKey(kind: string, id: string, sha256: string) {
  return `${kind}:${id}:${sha256}`;
}

function ratioBasisPoints(numerator: number, denominator: number) {
  return denominator > 0
    ? Math.round((numerator * 10_000) / denominator)
    : 0;
}
