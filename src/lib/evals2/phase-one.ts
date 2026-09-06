import {
  MUTATION_EVENT_CONTRACTS,
  MUTATION_EVENT_REGISTRY_SCHEMA_VERSION,
  evaluateMutationProjectionReplay,
  validateMutationEventRegistry,
  type MutationEventContract,
} from "@/lib/events/mutation-registry";
import { runOutcomeContractGate } from "@/lib/evals2/outcome-contracts";
import { CLAIM_EVIDENCE_MAP_SCHEMA_VERSION } from "@/lib/rag/claim-evidence-map";
import { buildRuntimeClaimEvidenceV1 } from "@/lib/rag/claim-evidence-runtime";
import {
  RUN_CHECKPOINT_SCHEMA_VERSION,
  buildRunCheckpointV1,
} from "@/lib/runs/checkpoints";
import {
  RUN_FORK_LINEAGE_SCHEMA_VERSION,
  RUN_FORK_PURPOSE,
  buildRunForkEventPrefixV1,
  buildRunForkLineageV1,
  parseRunForkLineageV1,
} from "@/lib/runs/forks";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  EFFECT_RECEIPT_SCHEMA_VERSION,
  buildEffectReceiptEventPayloadV1,
  buildEffectReceiptV1,
  memoryEffectTargetIdV1,
  parseEffectReceiptV1,
} from "@/lib/tools/effect-receipt";

export const PHASE_ONE_GATE_SCHEMA_VERSION = 1 as const;
export const PHASE_ONE_GATE_SUITE_ID = "p1-production-phase-gate-v1" as const;

const FIXED_AT = "2026-09-06T00:00:00.000Z";

type PhaseOneGateId =
  | "p1.1"
  | "p1.2"
  | "p1.3"
  | "p1.4"
  | "p1.5"
  | "p1.6"
  | "p1.7";

export type PhaseOneGateObservation = Readonly<{
  gateId: PhaseOneGateId;
  passed: boolean;
  evidenceCount: number;
  contractVersion: number;
}>;

type PhaseOneGateDependencies = Readonly<{
  mutationContracts: readonly MutationEventContract[];
  outcomeGate: typeof runOutcomeContractGate;
}>;

const defaultDependencies: PhaseOneGateDependencies = Object.freeze({
  mutationContracts: MUTATION_EVENT_CONTRACTS,
  outcomeGate: runOutcomeContractGate,
});

/**
 * Fixed, metadata-only aggregate gate for P1.1-P1.7. It creates contract
 * fixtures in memory and grants no model, tool, persistence, or effect
 * authority.
 */
export async function runPhaseOneGate(
  input: {
    tenantId: string;
    actorId: string;
    correlationId: string;
  },
  dependencies: Partial<PhaseOneGateDependencies> = {},
) {
  const resolvedDependencies = { ...defaultDependencies, ...dependencies };
  const registry = validateMutationEventRegistry(
    resolvedDependencies.mutationContracts,
  );
  const replay = evaluateMutationProjectionReplay(
    resolvedDependencies.mutationContracts,
  );
  const outcomes = resolvedDependencies.outcomeGate(input);
  const effectReceipt = evaluateEffectReceipt(input);
  const claimEvidence = await evaluateClaimEvidence(input);
  const checkpoint = evaluateCheckpoint(input);
  const fork = evaluateFork(input, checkpoint.value);

  const observations: PhaseOneGateObservation[] = [
    Object.freeze({
      gateId: "p1.1",
      passed: registry.passed,
      evidenceCount: registry.eventedDomainCount,
      contractVersion: MUTATION_EVENT_REGISTRY_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p1.2",
      passed: registry.passed && replay.passed,
      evidenceCount: replay.matchedProjectionCount,
      contractVersion: MUTATION_EVENT_REGISTRY_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p1.3",
      passed:
        outcomes.report.passed &&
        outcomes.report.falseSuccessCount === 0 &&
        outcomes.report.effectCount === 0,
      evidenceCount: outcomes.report.passedCaseCount,
      contractVersion: outcomes.report.schemaVersion,
    }),
    Object.freeze({
      gateId: "p1.4",
      passed: effectReceipt.passed,
      evidenceCount: effectReceipt.passed ? 1 : 0,
      contractVersion: EFFECT_RECEIPT_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p1.5",
      passed: claimEvidence.passed,
      evidenceCount: claimEvidence.claimCount,
      contractVersion: CLAIM_EVIDENCE_MAP_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p1.6",
      passed: checkpoint.passed,
      evidenceCount: checkpoint.passed ? 1 : 0,
      contractVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p1.7",
      passed: fork.passed,
      evidenceCount: fork.passed ? 1 : 0,
      contractVersion: RUN_FORK_LINEAGE_SCHEMA_VERSION,
    }),
  ];
  const failedGateIds = observations
    .filter((observation) => !observation.passed)
    .map((observation) => observation.gateId);
  const report = Object.freeze({
    schemaVersion: PHASE_ONE_GATE_SCHEMA_VERSION,
    suiteId: PHASE_ONE_GATE_SUITE_ID,
    suiteSha256: sourceContractSha256({
      schemaVersion: PHASE_ONE_GATE_SCHEMA_VERSION,
      registrySha256: registry.registrySha256,
      outcomeSuiteSha256: outcomes.report.suiteSha256,
      effectReceiptSchemaVersion: EFFECT_RECEIPT_SCHEMA_VERSION,
      claimEvidenceSchemaVersion: CLAIM_EVIDENCE_MAP_SCHEMA_VERSION,
      checkpointSchemaVersion: RUN_CHECKPOINT_SCHEMA_VERSION,
      forkLineageSchemaVersion: RUN_FORK_LINEAGE_SCHEMA_VERSION,
    }),
    gateCount: observations.length,
    passedGateCount: observations.length - failedGateIds.length,
    failedGateIds: Object.freeze(failedGateIds),
    mutationDomainCount: registry.domainCount,
    eventedMutationDomainCount: registry.eventedDomainCount,
    noMutationSurfaceCount: registry.noMutationSurfaceCount,
    mutationEventTypeCount: registry.eventTypeCount,
    projectionCount: replay.projectionCount,
    matchedProjectionCount: replay.matchedProjectionCount,
    projectionReplayBasisPoints: replay.parityBasisPoints,
    outcomeCaseCount: outcomes.report.caseCount,
    outcomePassedCaseCount: outcomes.report.passedCaseCount,
    negativeOutcomeCaseCount: outcomes.report.negativeCaseCount,
    falseSuccessCount: outcomes.report.falseSuccessCount,
    effectReceiptContractCount: effectReceipt.passed ? 1 : 0,
    claimEvidenceMapCount: claimEvidence.passed ? 1 : 0,
    materialClaimCount: claimEvidence.claimCount,
    unsupportedClaimCount: claimEvidence.unsupportedClaimCount,
    checkpointContractCount: checkpoint.passed ? 1 : 0,
    forkLineageContractCount: fork.passed ? 1 : 0,
    effectCount: 0,
    passed: failedGateIds.length === 0,
  });

  return Object.freeze({
    report,
    observations: Object.freeze(observations),
  });
}

function evaluateEffectReceipt(input: {
  tenantId: string;
  actorId: string;
}) {
  const binding = {
    executionId: "p1-phase-effect-execution",
    tenantId: input.tenantId,
    actorId: input.actorId,
    executingPrincipalType: "system" as const,
    executingPrincipalId: "workflow:p1-phase-workflow",
    workflowRunId: "p1-phase-workflow",
    planId: "p1-phase-plan",
    planSha256: "1".repeat(64),
    planNodeId: "p1-phase-node",
    toolId: "memory.write" as const,
    toolContractSha256: "2".repeat(64),
    inputSha256: "3".repeat(64),
    idempotencyKeySha256: "4".repeat(64),
  };
  const targetId = memoryEffectTargetIdV1(binding);
  const receipt = buildEffectReceiptV1({
    ...binding,
    effectMode: "live",
    reversible: true,
    targetType: "memory",
    targetId,
    providerAcknowledgement: "first_party_store_commit",
    providerAcknowledgementId: targetId,
    providerAcknowledgementSha256: "5".repeat(64),
    verificationMethod: "read_after_write",
    verificationState: "verified",
    verificationReasonCode: "state_matched",
    expectedTargetStateSha256: "6".repeat(64),
    observedTargetStateSha256: "6".repeat(64),
  });
  const parsed = parseEffectReceiptV1(receipt, binding);
  const eventPayload = buildEffectReceiptEventPayloadV1(receipt);
  return {
    passed: Boolean(
      parsed &&
      parsed.receiptSha256 === receipt.receiptSha256 &&
      parsed.verificationState === "verified" &&
      eventPayload.effectReceiptId === receipt.effectReceiptId &&
      eventPayload.idempotencyKeySha256 === binding.idempotencyKeySha256,
    ),
  };
}

async function evaluateClaimEvidence(input: {
  tenantId: string;
  actorId: string;
  correlationId: string;
}) {
  const result = await buildRuntimeClaimEvidenceV1({
    runId: "p1-phase-claim-run",
    answerText: "The synthetic launch date is 1 October 2026.",
    executionScope: createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: input.correlationId,
      purpose: "evaluation.p1.phase_gate.claim_evidence",
    }),
    citationSources: [],
    evaluatedAt: FIXED_AT,
  });
  const claims = result.claimEvidenceMap.claims;
  const unsupportedClaimCount = claims.filter(
    (claim) => claim.supportState === "unsupported",
  ).length;
  return {
    claimCount: claims.length,
    unsupportedClaimCount,
    passed:
      claims.length > 0 &&
      unsupportedClaimCount === claims.length &&
      result.claimEvidenceMap.evidenceUnits.length === 0 &&
      result.structuralVerification.verificationState === "verified",
  };
}

function evaluateCheckpoint(input: {
  tenantId: string;
  actorId: string;
  correlationId: string;
}) {
  const scope = createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: input.correlationId,
    purpose: "evaluation.p1.phase_gate.checkpoint",
  });
  const value = buildRunCheckpointV1({
    runId: "p1-phase-checkpoint-run",
    executionScope: scope,
    boundary: {
      kind: "model",
      phase: "before",
      boundaryId: "p1-phase-model",
      attempt: 1,
    },
    sequence: 0,
    parent: null,
    enginePin: {
      rolloutCapabilityId: "agent_run_checkpoints",
      engineVersionId: "agent_approval_continuation_v1",
      contractVersionId: "run_checkpoint_v1",
      configurationSha256: "7".repeat(64),
      runContractEnvelopeId: "p1-phase-envelope",
      runContractEnvelopeSha256: "8".repeat(64),
      harnessManifestId: "p1-phase-harness",
      harnessManifestSha256: "9".repeat(64),
      rolloutMode: "canary",
      rolloutLifecycleStatus: "active",
      rolloutGeneration: 1,
      rolloutLifecycleRevision: 1,
    },
    stateReferences: [
      {
        kind: "run_record",
        referenceId: "p1-phase-checkpoint-run",
        referenceSha256: "a".repeat(64),
        versionId: "agent_run_v1",
      },
      {
        kind: "model_turn",
        referenceId: "p1-phase-model",
        referenceSha256: "b".repeat(64),
        versionId: "model_turn_v1",
      },
    ],
    toolBinding: null,
    resourceUsage: {
      modelCallCount: 0,
      modelInputTokenCount: 0,
      modelOutputTokenCount: 0,
      cachedInputTokenCount: 0,
      toolCallCount: 0,
      toolResultByteCount: 0,
      externalEffectCount: 0,
      boundaryExternalEffectCount: 0,
      elapsedMs: 0,
    },
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: FIXED_AT,
  });
  return {
    value,
    passed:
      value.schemaVersion === RUN_CHECKPOINT_SCHEMA_VERSION &&
      value.executionScope.initiatingActorId === input.actorId &&
      value.resourceUsage.externalEffectCount === 0,
  };
}

function evaluateFork(
  input: {
    tenantId: string;
    actorId: string;
    correlationId: string;
  },
  checkpoint: ReturnType<typeof buildRunCheckpointV1>,
) {
  const eventPrefix = buildRunForkEventPrefixV1([
    {
      id: "p1-phase-scope-event",
      seq: 1,
      type: "run.scope_bound",
      payload: { schemaVersion: 1 },
      at: FIXED_AT,
    },
    {
      id: "p1-phase-checkpoint-event",
      seq: 2,
      type: "run.checkpoint.recorded",
      payload: {
        checkpointId: checkpoint.checkpointId,
        checkpointSha256: checkpoint.checkpointSha256,
      },
      at: FIXED_AT,
    },
  ], checkpoint);
  const build = () => buildRunForkLineageV1({
    checkpoint,
    executionScope: createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: `${input.correlationId}:fork`,
      causationId: checkpoint.checkpointId,
      contextGrantIds: [],
      capabilityGrantIds: [],
      purpose: RUN_FORK_PURPOSE,
    }),
    correction: "Use the corrected synthetic fixture.",
    idempotencyKey: "p1-phase-fork",
    eventPrefix,
    createdAt: FIXED_AT,
  });
  const first = build();
  const second = build();
  const parsed = parseRunForkLineageV1(first);
  return {
    passed:
      sourceContractSha256(first) === sourceContractSha256(second) &&
      parsed.target.approvalInheritance === "none" &&
      parsed.target.continuationInheritance === "none" &&
      parsed.source.checkpointId === checkpoint.checkpointId,
  };
}
