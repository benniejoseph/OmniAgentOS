import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  buildLoopV2PreExecutionRunContract,
  buildLoopV2TerminalRunContract,
} from "@/lib/orchestration/loop-v2-outcome";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  canonicalStatusForAgentRun,
  canonicalStatusForTerminalReceipt,
  type CanonicalStatus,
} from "@/lib/status/canonical";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import {
  buildWorkflowOutcomeContractBindingV1,
  buildWorkflowOutcomeEvaluationV1,
} from "@/lib/workflows/outcome-evaluator";
import type {
  WorkflowPlanNodeExecutionStatus,
  WorkflowRunDetail,
  WorkflowStepKey,
  WorkflowStepRecord,
} from "@/lib/workflows/types";

export const OUTCOME_CONTRACT_GATE_SCHEMA_VERSION = 1 as const;
export const OUTCOME_CONTRACT_GATE_SUITE_ID =
  "p1.3-outcome-contracts-v1" as const;

const FIXED_AT = "2026-09-06T00:00:00.000Z";
const DIRECT_RESPONSE = "Here are the recent runs.";

type GateOutcome = CanonicalStatus | "rejected";

type OutcomeContractGateCaseId =
  | "workflow_prebound_model_assertion"
  | "workflow_posthoc_model_assertion"
  | "workflow_waiting_approval"
  | "workflow_skipped_required"
  | "workflow_blocked"
  | "workflow_partial"
  | "workflow_dry_run"
  | "workflow_failed"
  | "workflow_tampered_prebinding"
  | "direct_verified_read"
  | "direct_model_unverified"
  | "direct_failed"
  | "direct_canceled"
  | "direct_detached_receipt"
  | "legacy_completed";

export type OutcomeContractGateObservation = Readonly<{
  caseId: OutcomeContractGateCaseId;
  expectedOutcome: GateOutcome;
  observedOutcome: GateOutcome;
  successEligible: boolean;
  passed: boolean;
}>;

/**
 * Fixed, content-free P1.3 release gate. It exercises the production outcome
 * evaluators without granting model, tool, mutation, or external-effect
 * authority.
 */
export function runOutcomeContractGate(input: {
  tenantId: string;
  actorId: string;
  correlationId: string;
}) {
  const observations = Object.freeze([
    workflowObservation(
      "workflow_prebound_model_assertion",
      "unverified",
      { binding: "pre_execution", statuses: ["completed"] },
    ),
    workflowObservation(
      "workflow_posthoc_model_assertion",
      "unverified",
      { binding: "posthoc", statuses: ["completed"] },
    ),
    workflowObservation(
      "workflow_waiting_approval",
      "waiting",
      { binding: "pre_execution", statuses: ["waiting_approval"] },
    ),
    workflowObservation(
      "workflow_skipped_required",
      "unverified",
      { binding: "pre_execution", statuses: ["skipped"], includeTool: false },
    ),
    workflowObservation(
      "workflow_blocked",
      "blocked",
      { binding: "pre_execution", statuses: ["blocked"] },
    ),
    workflowObservation(
      "workflow_partial",
      "partial",
      { binding: "pre_execution", statuses: ["completed", "skipped"] },
    ),
    workflowObservation(
      "workflow_dry_run",
      "partial",
      { binding: "pre_execution", statuses: ["completed"], dryRun: true },
    ),
    workflowObservation(
      "workflow_failed",
      "failed",
      { binding: "pre_execution", statuses: ["failed"] },
    ),
    rejectedWorkflowBindingObservation(),
    ...directObservations(input),
    observe("legacy_completed", "unverified", canonicalStatusForAgentRun(
      "completed",
    ).status),
  ] satisfies readonly OutcomeContractGateObservation[]);
  const failedCaseIds = observations
    .filter((observation) => !observation.passed)
    .map((observation) => observation.caseId);
  const falseSuccessCount = observations.filter(
    (observation) =>
      !observation.successEligible && observation.observedOutcome === "succeeded",
  ).length;
  const verifiedSuccessCount = observations.filter(
    (observation) => observation.observedOutcome === "succeeded",
  ).length;
  const rejectedTamperCount = observations.filter(
    (observation) => observation.observedOutcome === "rejected",
  ).length;
  const report = Object.freeze({
    schemaVersion: OUTCOME_CONTRACT_GATE_SCHEMA_VERSION,
    suiteId: OUTCOME_CONTRACT_GATE_SUITE_ID,
    suiteSha256: sourceContractSha256({
      schemaVersion: OUTCOME_CONTRACT_GATE_SCHEMA_VERSION,
      cases: observations.map(({ caseId, expectedOutcome, successEligible }) => ({
        caseId,
        expectedOutcome,
        successEligible,
      })),
    }),
    caseCount: observations.length,
    passedCaseCount: observations.length - failedCaseIds.length,
    negativeCaseCount: observations.filter(
      (observation) => !observation.successEligible,
    ).length,
    falseSuccessCount,
    verifiedSuccessCount,
    rejectedTamperCount,
    failedCaseIds: Object.freeze(failedCaseIds),
    effectCount: 0,
    passed: failedCaseIds.length === 0 && falseSuccessCount === 0,
  });
  return Object.freeze({ report, observations });
}

function workflowObservation(
  caseId: OutcomeContractGateCaseId,
  expectedOutcome: CanonicalStatus,
  options: WorkflowFixtureOptions,
) {
  const fixture = workflowFixture(caseId, options);
  const evaluation = buildWorkflowOutcomeEvaluationV1(fixture);
  return observe(
    caseId,
    expectedOutcome,
    canonicalStatusForTerminalReceipt(
      evaluation.terminalReceipt,
      "workflow_run",
    ).status,
  );
}

function rejectedWorkflowBindingObservation(): OutcomeContractGateObservation {
  const fixture = workflowFixture("workflow_tampered_prebinding", {
    binding: "pre_execution",
    statuses: ["completed"],
  });
  const planStep = fixture.detail.steps.find((step) => step.stepKey === "plan");
  const output = planStep?.output as Record<string, unknown>;
  const binding = output.outcomeContractBinding as Record<string, unknown>;
  output.outcomeContractBinding = {
    ...binding,
    outcomeContractSha256: "0".repeat(64),
  };
  let observedOutcome: GateOutcome = "unverified";
  try {
    buildWorkflowOutcomeEvaluationV1(fixture);
  } catch {
    observedOutcome = "rejected";
  }
  return observe(
    "workflow_tampered_prebinding",
    "rejected",
    observedOutcome,
  );
}

function directObservations(input: {
  tenantId: string;
  actorId: string;
  correlationId: string;
}): OutcomeContractGateObservation[] {
  const read = directFixture(input, "read");
  const verificationReceipt = {
    executionId: "p13-read-execution-v1",
    operationClass: "read_only" as const,
    effectReceiptPresent: false as const,
    responseSha256: sourceContractSha256(DIRECT_RESPONSE),
  };
  const readTerminal = terminalCheckpoint(
    read.root,
    read.scope,
    "succeeded",
    verificationReceipt,
  );
  const readReceipt = buildLoopV2TerminalRunContract({
    preExecution: read.preExecution,
    terminalCheckpoint: readTerminal,
    response: DIRECT_RESPONSE,
    verificationReceipt,
  }).envelope.terminalReceipt!;

  const model = directFixture(input, "model");
  const modelTerminal = terminalCheckpoint(
    model.root,
    model.scope,
    "succeeded",
    { responseSha256: sourceContractSha256(DIRECT_RESPONSE) },
  );
  const modelReceipt = buildLoopV2TerminalRunContract({
    preExecution: model.preExecution,
    terminalCheckpoint: modelTerminal,
    response: DIRECT_RESPONSE,
  }).envelope.terminalReceipt!;

  const failedTerminal = terminalCheckpoint(
    read.root,
    read.scope,
    "failed",
    { reason: "bounded_failure" },
  );
  const failedReceipt = buildLoopV2TerminalRunContract({
    preExecution: read.preExecution,
    terminalCheckpoint: failedTerminal,
  }).envelope.terminalReceipt!;
  const canceledTerminal = terminalCheckpoint(
    read.root,
    read.scope,
    "canceled",
    { reason: "authorized_cancellation" },
  );
  const canceledReceipt = buildLoopV2TerminalRunContract({
    preExecution: read.preExecution,
    terminalCheckpoint: canceledTerminal,
  }).envelope.terminalReceipt!;

  let detachedOutcome: GateOutcome = "unverified";
  try {
    buildLoopV2TerminalRunContract({
      preExecution: read.preExecution,
      terminalCheckpoint: readTerminal,
      response: "Detached response",
      verificationReceipt,
    });
  } catch {
    detachedOutcome = "rejected";
  }

  return [
    observe(
      "direct_verified_read",
      "succeeded",
      canonicalStatusForTerminalReceipt(readReceipt, "agent_run").status,
      true,
    ),
    observe(
      "direct_model_unverified",
      "unverified",
      canonicalStatusForTerminalReceipt(modelReceipt, "agent_run").status,
    ),
    observe(
      "direct_failed",
      "failed",
      canonicalStatusForTerminalReceipt(failedReceipt, "agent_run").status,
    ),
    observe(
      "direct_canceled",
      "canceled",
      canonicalStatusForTerminalReceipt(canceledReceipt, "agent_run").status,
    ),
    observe("direct_detached_receipt", "rejected", detachedOutcome),
  ];
}

function observe(
  caseId: OutcomeContractGateCaseId,
  expectedOutcome: GateOutcome,
  observedOutcome: GateOutcome,
  successEligible = false,
): OutcomeContractGateObservation {
  return Object.freeze({
    caseId,
    expectedOutcome,
    observedOutcome,
    successEligible,
    passed: observedOutcome === expectedOutcome,
  });
}

type WorkflowFixtureOptions = Readonly<{
  binding: "pre_execution" | "posthoc";
  statuses: WorkflowPlanNodeExecutionStatus[];
  includeTool?: boolean;
  dryRun?: boolean;
}>;

function workflowFixture(
  caseId: OutcomeContractGateCaseId,
  options: WorkflowFixtureOptions,
) {
  const runId = `p13-${caseId}`;
  const planId = `${runId}:plan:v1`;
  const goal = "Produce the declared synthetic outcome.";
  const includeTool = options.includeTool !== false;
  const plan = {
    acceptanceCriteria: ["The declared synthetic outcome exists."],
    nodes: options.statuses.map((_status, index) => ({
      id: `${runId}:node:${index + 1}`,
      policy: options.dryRun && index === 0 ? "dry_run" : "auto",
      acceptanceCriteria: index === 0
        ? ["Complete the required synthetic work unit."]
        : [],
    })),
  };
  const nodeExecutions = options.statuses.map((status, index) => {
    const toolExecutions = includeTool && index === 0
      ? [{
          id: `${runId}:tool-execution:v1`,
          toolId: "connector.synthetic.write",
          status: status === "waiting_approval"
            ? "approval_required"
            : status === "blocked"
              ? "blocked"
              : status === "failed"
                ? "failed"
                : options.dryRun
                  ? "dry_run"
                  : status === "completed"
                    ? "executed"
                    : "not_run",
          dryRun: options.dryRun === true,
        }]
      : [];
    return {
      id: `${runId}:node-execution:${index + 1}`,
      workflowRunId: runId,
      planId,
      nodeId: `${runId}:node:${index + 1}`,
      status,
      toolExecutionIds: toolExecutions.map((tool) => tool.id),
      output: { dryRunOnly: options.dryRun === true, toolExecutions },
    };
  });
  const count = (status: WorkflowPlanNodeExecutionStatus) =>
    options.statuses.filter((value) => value === status).length;
  const executionStatus = count("failed") > 0
    ? "failed"
    : count("blocked") > 0
      ? "blocked"
      : count("waiting_approval") > 0
        ? "waiting_approval"
        : "completed";
  const toolExecutions = nodeExecutions.flatMap(
    (execution) => execution.output.toolExecutions,
  );
  const planOutput: Record<string, unknown> = {
    id: planId,
    planner: "deterministic",
    plan,
  };
  if (options.binding === "pre_execution") {
    planOutput.outcomeContractBinding = buildWorkflowOutcomeContractBindingV1({
      workflowRunId: runId,
      goal,
      planId,
      plan,
    });
  }
  const result = {
    report: "Synthetic outcome report.",
    dynamicPlanId: planId,
    planExecutionStatus: executionStatus,
  };
  const detail: WorkflowRunDetail = {
    run: {
      id: runId,
      tenantId: "p13-synthetic-tenant",
      workflowType: "agent_goal",
      status: "running",
      goal,
      input: { goal, mode: "orchestrate" },
      attempt: 1,
      maxAttempts: 1,
      approvalRequired: false,
      result,
      createdAt: FIXED_AT,
      updatedAt: FIXED_AT,
    },
    steps: [
      workflowStep(runId, "plan", planOutput),
      workflowStep(runId, "execute", {
        planExecution: {
          workflowRunId: runId,
          planId,
          status: executionStatus,
          totalNodes: options.statuses.length,
          completedNodes: count("completed"),
          failedNodes: count("failed"),
          blockedNodes: count("blocked"),
          skippedNodes: count("skipped"),
          waitingApprovalNodes: count("waiting_approval"),
          toolExecutions: toolExecutions.length,
          dryRunTools: toolExecutions.filter((tool) => tool.dryRun).length,
          executedTools: toolExecutions.filter(
            (tool) => tool.status === "executed",
          ).length,
          nodeExecutions,
        },
      }),
      workflowStep(runId, "verify", {
        passed: true,
        mechanicalPassed: true,
        modelVerdict: { passed: true, score: 1 },
      }),
      workflowStep(runId, "persist_report", result),
    ],
    events: [],
  };
  return { detail, result };
}

function workflowStep(
  runId: string,
  stepKey: WorkflowStepKey,
  output: Record<string, unknown>,
): WorkflowStepRecord {
  return {
    id: `${runId}:step:${stepKey}`,
    workflowRunId: runId,
    stepKey,
    label: stepKey,
    status: "completed",
    attempt: 1,
    maxAttempts: 1,
    input: {},
    output,
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
    completedAt: FIXED_AT,
  };
}

function directFixture(
  input: { tenantId: string; actorId: string; correlationId: string },
  kind: "read" | "model",
) {
  const runId = `p13-direct-${kind}`;
  const scope = createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: input.correlationId,
    purpose: kind === "read"
      ? "agent.loop.v2.read_only_canary"
      : "agent.loop.v2.model_text_canary",
  });
  const root = createInitialLoopV2Checkpoint({
    tenantId: input.tenantId,
    runId,
    ownerActorId: input.actorId,
    executionScope: scope,
    enginePin: buildLoopV2EnginePin(directRollout(input, kind)),
    transitionedAt: FIXED_AT,
  });
  const preExecution = buildLoopV2PreExecutionRunContract({
    rootCheckpoint: root,
    executionScope: scope,
    requestSha256: sourceContractSha256({ kind, request: "synthetic" }),
    requestedOutcomeSha256: sourceContractSha256({ kind, outcome: "synthetic" }),
    agentId: "atlas",
  });
  return { root, scope, preExecution };
}

function directRollout(
  input: { tenantId: string; actorId: string },
  kind: "read" | "model",
): TenantCapabilityRollout {
  const model = kind === "model";
  return {
    schemaVersion: 1,
    tenantId: input.tenantId,
    capabilityId: model
      ? LOOP_V2_MODEL_TEXT_CAPABILITY_ID
      : LOOP_V2_CAPABILITY_ID,
    rolloutGeneration: 1,
    engineVersion: model
      ? LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID
      : LOOP_V2_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: model
      ? LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256
      : LOOP_V2_CONFIGURATION_SHA256,
    mode: "canary",
    status: "active",
    lifecycleRevision: 1,
    createdByActorId: input.actorId,
    activatedByActorId: input.actorId,
    activatedAt: FIXED_AT,
    createdAt: FIXED_AT,
    updatedAt: FIXED_AT,
  };
}

function terminalCheckpoint(
  root: LoopV2Checkpoint,
  scope: ReturnType<typeof createExecutionScope>,
  disposition: "succeeded" | "failed" | "canceled",
  receipt: unknown,
) {
  if (disposition !== "succeeded") {
    return advanceLoopV2Checkpoint({
      current: root,
      executionScope: scope,
      trigger: disposition === "failed" ? "budget_exhausted" : "canceled",
      outputReceiptSha256: sourceContractSha256(receipt),
      transitionedAt: "2026-09-06T00:01:00.000Z",
    });
  }
  let current = advanceLoopV2Checkpoint({
    current: root,
    executionScope: scope,
    trigger: "plan_bound",
    outputReceiptSha256: sourceContractSha256("plan"),
    transitionedAt: "2026-09-06T00:01:00.000Z",
  });
  for (const [trigger, minute] of [
    ["action_started", 2],
    ["action_succeeded", 3],
    ["observation_recorded", 4],
  ] as const) {
    current = advanceLoopV2Checkpoint({
      current,
      executionScope: scope,
      trigger,
      outputReceiptSha256: sourceContractSha256(trigger),
      transitionedAt: `2026-09-06T00:0${minute}:00.000Z`,
    });
  }
  return advanceLoopV2Checkpoint({
    current,
    executionScope: scope,
    trigger: "verification_passed",
    outputReceiptSha256: sourceContractSha256(receipt),
    transitionedAt: "2026-09-06T00:05:00.000Z",
  });
}
