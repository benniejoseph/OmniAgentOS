import {
  ARCHITECTURE_DECISION_REGISTRY_VERSION,
  REQUIRED_ARCHITECTURE_DECISIONS,
  type ArchitectureDecision,
} from "@/lib/architecture/decision-registry";
import { observeP05Suite } from "@/lib/evals2/p05-observer";
import { scoreP05Suite } from "@/lib/evals2/p05";
import {
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
} from "@/lib/orchestration/loop-v2";
import {
  buildInitialShadowRunContract,
  resolveShadowRunContract,
} from "@/lib/runs/contract-runtime";
import {
  RUN_CONTRACT_SCHEMA_VERSION,
  buildLegacyTerminalReceiptV1,
} from "@/lib/runs/contracts";
import {
  TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION,
  tenantCapabilityRolloutSchema,
  type TenantCapabilityRollout,
} from "@/lib/rollouts/tenant-capability-rollouts";
import {
  EXECUTION_SCOPE_VERSION,
  assertExecutionScopeTenant,
  createExecutionScope,
  deriveExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
} from "@/lib/security/execution-scope";
import {
  CANONICAL_STATUSES,
  CANONICAL_STATUS_SCHEMA_VERSION,
  canonicalStatusForAgentRun,
  canonicalStatusForTerminalReceipt,
  canonicalStatusForToolExecution,
  canonicalStatusForWorkflowPlan,
} from "@/lib/status/canonical";
import { sourceContractSha256 } from "@/lib/sources/contracts";

export const PHASE_ZERO_GATE_SCHEMA_VERSION = 1 as const;
export const PHASE_ZERO_GATE_SUITE_ID = "p0-production-phase-gate-v1" as const;

export const P0_SCOPE_BOUNDARY_IDS = Object.freeze([
  "memory_rag",
  "agent_runs",
  "delegation",
  "governed_tools",
  "workflows",
  "mcp_connectors",
  "openapi_connectors",
  "capture_assets",
  "event_log",
  "projections",
] as const);

type PhaseZeroGateId = "p0.1" | "p0.2" | "p0.3" | "p0.4" | "p0.5" | "p0.6";

export type PhaseZeroGateObservation = Readonly<{
  gateId: PhaseZeroGateId;
  passed: boolean;
  evidenceCount: number;
  contractVersion: number;
}>;

type PhaseZeroGateDependencies = Readonly<{
  decisions: readonly Readonly<{
    id: string;
    topic: string;
    status: string;
  }>[];
}>;

const defaultDependencies: PhaseZeroGateDependencies = Object.freeze({
  decisions: REQUIRED_ARCHITECTURE_DECISIONS,
});

export function runPhaseZeroGate(
  input: {
    p05Suite: unknown;
    tenantId: string;
    actorId: string;
    correlationId: string;
    currentRollout: TenantCapabilityRollout | null;
  },
  dependencies: PhaseZeroGateDependencies = defaultDependencies,
) {
  const scopeEvidence = evaluateExecutionScope(input);
  const contractEvidence = evaluateRunContracts(scopeEvidence.scope);
  const rolloutEvidence = evaluateRollout(input.currentRollout, input.tenantId);
  const statusEvidence = evaluateCanonicalStatuses();
  const baselineScore = scoreP05Suite(
    input.p05Suite,
    observeP05Suite(input.p05Suite),
  );
  const decisionEvidence = evaluateArchitectureDecisions(dependencies.decisions);

  const observations: PhaseZeroGateObservation[] = [
    Object.freeze({
      gateId: "p0.1",
      passed: scopeEvidence.passed && scopeCategoryPassed(baselineScore),
      evidenceCount: P0_SCOPE_BOUNDARY_IDS.length,
      contractVersion: EXECUTION_SCOPE_VERSION,
    }),
    Object.freeze({
      gateId: "p0.2",
      passed: contractEvidence.passed,
      evidenceCount: contractEvidence.contractCount,
      contractVersion: RUN_CONTRACT_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p0.3",
      passed: rolloutEvidence.passed,
      evidenceCount: rolloutEvidence.passed ? 1 : 0,
      contractVersion: TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p0.4",
      passed: statusEvidence.passed,
      evidenceCount: statusEvidence.observedStatusCount,
      contractVersion: CANONICAL_STATUS_SCHEMA_VERSION,
    }),
    Object.freeze({
      gateId: "p0.5",
      passed: baselineScore.passed && !baselineScore.hardFailure,
      evidenceCount: baselineScore.passedCases,
      contractVersion: baselineScore.schemaVersion,
    }),
    Object.freeze({
      gateId: "p0.6",
      passed: decisionEvidence.passed,
      evidenceCount: decisionEvidence.acceptedDecisionCount,
      contractVersion: ARCHITECTURE_DECISION_REGISTRY_VERSION,
    }),
  ];
  const failedGateIds = observations
    .filter((observation) => !observation.passed)
    .map((observation) => observation.gateId);
  const report = Object.freeze({
    schemaVersion: PHASE_ZERO_GATE_SCHEMA_VERSION,
    suiteId: PHASE_ZERO_GATE_SUITE_ID,
    suiteSha256: sourceContractSha256({
      schemaVersion: PHASE_ZERO_GATE_SCHEMA_VERSION,
      scopeBoundaryIds: P0_SCOPE_BOUNDARY_IDS,
      runContractSchemaVersion: RUN_CONTRACT_SCHEMA_VERSION,
      rolloutSchemaVersion: TENANT_CAPABILITY_ROLLOUT_SCHEMA_VERSION,
      canonicalStatusSchemaVersion: CANONICAL_STATUS_SCHEMA_VERSION,
      p05SuiteSha256: baselineScore.suiteSha256,
      architectureDecisionIds: dependencies.decisions.map(({ id }) => id),
    }),
    gateCount: observations.length,
    passedGateCount: observations.length - failedGateIds.length,
    failedGateIds: Object.freeze(failedGateIds),
    scopeBoundaryCount: P0_SCOPE_BOUNDARY_IDS.length,
    scopedBoundaryCount: scopeEvidence.passed
      ? P0_SCOPE_BOUNDARY_IDS.length
      : 0,
    runContractCount: contractEvidence.contractCount,
    currentRolloutGeneration: rolloutEvidence.generation,
    currentRolloutStatus: rolloutEvidence.status,
    canonicalStatusCount: CANONICAL_STATUSES.length,
    observedCanonicalStatusCount: statusEvidence.observedStatusCount,
    baselineCaseCount: baselineScore.totalCases,
    baselinePassedCaseCount: baselineScore.passedCases,
    baselineScoreBasisPoints: baselineScore.scoreBasisPoints,
    acceptedArchitectureDecisionCount: decisionEvidence.acceptedDecisionCount,
    unresolvedArchitectureDecisionCount: decisionEvidence.unresolvedDecisionCount,
    effectCount: 0,
    passed: failedGateIds.length === 0,
  });

  return Object.freeze({ report, observations: Object.freeze(observations) });
}

function evaluateExecutionScope(input: {
  tenantId: string;
  actorId: string;
  correlationId: string;
}) {
  const scope = createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "user",
    executingPrincipalId: input.actorId,
    correlationId: input.correlationId,
    contextGrantIds: ["context-a", "context-b"],
    capabilityGrantIds: ["capability-a", "capability-b"],
    purpose: "evaluation.p0.phase_gate",
  });
  const child = deriveExecutionScope(scope, {
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    contextGrantIds: ["context-a"],
    capabilityGrantIds: ["capability-a"],
    purpose: "evaluation.p0.phase_gate.child",
  });
  const parsed = parsePersistedExecutionScope(
    JSON.parse(JSON.stringify(child)) as unknown,
  );
  let mismatchRejected = false;
  let wideningRejected = false;
  try {
    assertExecutionScopeTenant(scope, `${input.tenantId}:other`);
  } catch {
    mismatchRejected = true;
  }
  try {
    deriveExecutionScope(scope, {
      contextGrantIds: ["context-a", "context-c"],
      purpose: "evaluation.p0.phase_gate.invalid",
    });
  } catch {
    wideningRejected = true;
  }
  const passed = Boolean(
    parsed &&
    executionScopesEqual(parsed, child) &&
    child.tenantId === scope.tenantId &&
    child.initiatingActorId === scope.initiatingActorId &&
    child.correlationId === scope.correlationId &&
    child.contextGrantIds.length === 1 &&
    child.capabilityGrantIds.length === 1 &&
    mismatchRejected &&
    wideningRejected,
  );
  return { scope, passed };
}

function evaluateRunContracts(
  executionScope: ReturnType<typeof createExecutionScope>,
) {
  const snapshot = buildInitialShadowRunContract({
    runId: "p0-phase-gate-run",
    tenantId: executionScope.tenantId,
    agentId: "atlas",
    executionScope,
    requestSha256: "1".repeat(64),
    requestedOutcomeSha256: "2".repeat(64),
    interactionMode: "orchestrate",
    executionMode: "live",
    autonomy: "governed",
    approvalPolicy: "risk_based",
    budget: {
      maxModelTurns: 1,
      maxToolCalls: 1,
      maxOutputTokens: 128,
      maxToolResultBytes: 4_096,
      maxExternalEffects: 0,
    },
  });
  const resolved = resolveShadowRunContract({
    active: snapshot,
    querySha256: "3".repeat(64),
    scopeDecision: "disabled",
    selectedContext: [],
    userInclusionIds: [],
    userExclusionIds: [],
    providerDisclosureBoundary: "none",
    modelProvider: "unassessed",
    modelTier: "unassessed",
    toolIds: [],
    skillIds: [],
    policyIds: [],
    instructionsSha256: "4".repeat(64),
    toolboxSha256: "5".repeat(64),
  });
  const terminalReceipt = buildLegacyTerminalReceiptV1({
    terminalReceiptId: "p0-phase-gate-terminal",
    runId: snapshot.envelope.runId,
    legacyStatus: "completed",
  });
  const contractVersions = [
    resolved.envelope.agentPrincipal.schemaVersion,
    resolved.envelope.intentSpec.schemaVersion,
    resolved.envelope.outcomeContract.schemaVersion,
    resolved.envelope.contextManifests[0]?.schemaVersion,
    resolved.envelope.harnessManifest.schemaVersion,
    terminalReceipt.schemaVersion,
  ];
  return {
    contractCount: 6,
    passed:
      contractVersions.every((version) => version === RUN_CONTRACT_SCHEMA_VERSION) &&
      resolved.envelope.terminalReceipt === null &&
      resolved.eventPayload.terminalState === "not_emitted" &&
      resolved.eventPayload.envelopeSha256 === resolved.envelopeSha256 &&
      terminalReceipt.disposition === "unverified",
  };
}

function evaluateRollout(
  rolloutValue: TenantCapabilityRollout | null,
  tenantId: string,
) {
  const parsed = tenantCapabilityRolloutSchema.safeParse(rolloutValue);
  if (!parsed.success) {
    return { passed: false, generation: null, status: null } as const;
  }
  const rollout = parsed.data;
  return {
    passed:
      rollout.tenantId === tenantId &&
      rollout.capabilityId === LOOP_V2_CAPABILITY_ID &&
      rollout.engineVersion === LOOP_V2_ENGINE_VERSION_ID &&
      rollout.contractVersionId === LOOP_V2_CONTRACT_VERSION_ID &&
      rollout.configurationSha256 === LOOP_V2_CONFIGURATION_SHA256 &&
      rollout.status === "active",
    generation: rollout.rolloutGeneration,
    status: rollout.status,
  } as const;
}

function evaluateCanonicalStatuses() {
  const statuses = new Set([
    canonicalStatusForWorkflowPlan("planned").status,
    canonicalStatusForAgentRun("running").status,
    canonicalStatusForAgentRun("queued").status,
    canonicalStatusForToolExecution("blocked").status,
    canonicalStatusForTerminalReceipt({
      disposition: "partial",
      executionMode: "live",
      source: "outcome_evaluator",
      verificationState: "partially_verified",
    }).status,
    canonicalStatusForAgentRun("completed").status,
    canonicalStatusForAgentRun("failed").status,
    canonicalStatusForAgentRun("canceled").status,
    canonicalStatusForTerminalReceipt({
      disposition: "succeeded",
      executionMode: "live",
      source: "outcome_evaluator",
      verificationState: "verified",
    }).status,
  ]);
  return {
    observedStatusCount: statuses.size,
    passed: CANONICAL_STATUSES.every((status) => statuses.has(status)),
  };
}

function evaluateArchitectureDecisions(
  decisions: PhaseZeroGateDependencies["decisions"],
) {
  const requiredIds = new Set(
    REQUIRED_ARCHITECTURE_DECISIONS.map((decision) => decision.id),
  );
  const accepted = decisions.filter(
    (decision): decision is ArchitectureDecision =>
      decision.status === "accepted" && requiredIds.has(
        decision.id as ArchitectureDecision["id"],
      ),
  );
  const uniqueAcceptedIds = new Set(accepted.map((decision) => decision.id));
  const unresolvedDecisionCount = decisions.filter(
    (decision) => decision.status !== "accepted",
  ).length;
  return {
    acceptedDecisionCount: uniqueAcceptedIds.size,
    unresolvedDecisionCount,
    passed:
      decisions.length === REQUIRED_ARCHITECTURE_DECISIONS.length &&
      uniqueAcceptedIds.size === REQUIRED_ARCHITECTURE_DECISIONS.length &&
      unresolvedDecisionCount === 0,
  };
}

function scopeCategoryPassed(score: ReturnType<typeof scoreP05Suite>) {
  return score.categoryResults.some(
    (result) =>
      result.category === "scope" &&
      result.scoreBasisPoints === 10_000 &&
      !result.hardFailure,
  );
}
