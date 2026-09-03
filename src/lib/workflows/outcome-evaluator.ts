import { createHash } from "node:crypto";
import { z } from "zod";
import {
  MAX_OUTCOME_REQUIREMENTS,
  buildOutcomeContractV1,
  buildTerminalReceiptV1,
  outcomeContractV1Schema,
  runContractIdSchema,
  runContractSha256Schema,
  runExecutionModeSchema,
  terminalDispositionSchema,
  terminalReasonCodeSchema,
  terminalReceiptSourceSchema,
  terminalReceiptV1Schema,
  terminalVerificationStateSchema,
  verificationMethodSchema,
  type OutcomeContractV1,
  type RequirementVerificationV1,
  type TerminalReceiptV1,
} from "@/lib/runs/contracts";
import type {
  WorkflowPlanNodeExecutionStatus,
  WorkflowRunDetail,
  WorkflowStepKey,
} from "@/lib/workflows/types";

export const WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION = 1 as const;

const MAX_METADATA_IDS = MAX_OUTCOME_REQUIREMENTS * 3;
const MAX_COUNT = 1_000_000_000;
const workflowPlanExecutionStatusSchema = z.enum([
  "running",
  "completed",
  "waiting_approval",
  "blocked",
  "failed",
  "unassessed",
]);

const bindingStateSchema = z.enum([
  "matched",
  "single_source",
  "missing",
  "mismatched",
  "invalid",
]);

const verificationEvidenceSourceSchema = z.enum([
  "strong_receipts",
  "model_assertion",
  "generated_summary",
  "unassessed",
]);

const boundedCountSchema = z.number().int().min(0).max(MAX_COUNT);

function uniqueIdList(max = MAX_METADATA_IDS) {
  return z.array(runContractIdSchema).max(max).superRefine((ids, context) => {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          message: "IDs must be unique.",
          path: [index],
        });
      }
      seen.add(id);
    });
  });
}

/**
 * This is the complete evidence projection retained by the evaluator. It has
 * hashes, opaque IDs, enums, booleans, and counts only. Raw goals, reports,
 * model output, tool output, and error text never cross this boundary.
 */
export const workflowOutcomeEvidenceV1Schema = z.object({
  schemaVersion: z.literal(WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION),
  workflowRunId: runContractIdSchema,
  intendedLegacyStatus: z.literal("completed"),
  sourceRunStatus: z.literal("running"),
  goalSha256: runContractSha256Schema,
  planId: runContractIdSchema.nullable(),
  planSha256: runContractSha256Schema.nullable(),
  planBindingState: bindingStateSchema,
  outcomeContractBindingState: z.literal("posthoc"),
  executionWorkflowRunId: runContractIdSchema.nullable(),
  executionPlanId: runContractIdSchema.nullable(),
  planExecutionSha256: runContractSha256Schema.nullable(),
  planExecutionStatus: workflowPlanExecutionStatusSchema,
  planExecutionBindingState: bindingStateSchema,
  verificationEvidenceSource: verificationEvidenceSourceSchema,
  criterionVerificationMethod: verificationMethodSchema,
  verificationPassed: z.boolean().nullable(),
  mechanicalVerificationPassed: z.boolean().nullable(),
  criteriaOverflow: z.boolean(),
  reportSha256: runContractSha256Schema.nullable(),
  memoryId: runContractIdSchema.nullable(),
  completedStepCount: boundedCountSchema,
  totalNodeCount: boundedCountSchema,
  completedNodeCount: boundedCountSchema,
  failedNodeCount: boundedCountSchema,
  blockedNodeCount: boundedCountSchema,
  skippedNodeCount: boundedCountSchema,
  waitingApprovalNodeCount: boundedCountSchema,
  pendingNodeCount: boundedCountSchema,
  dryRunNodeCount: boundedCountSchema,
  executedToolCount: boundedCountSchema,
  dryRunToolCount: boundedCountSchema,
  failedToolCount: boundedCountSchema,
  pendingApprovalIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  blockingDependencyIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  artifactReceiptIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  effectReceiptIds: uniqueIdList(MAX_OUTCOME_REQUIREMENTS),
  verifierReceiptIds: uniqueIdList(MAX_METADATA_IDS),
  usefulWorkUnitCount: boundedCountSchema,
}).strict().superRefine((value, context) => {
  const terminalNodeCount =
    value.completedNodeCount +
    value.failedNodeCount +
    value.blockedNodeCount +
    value.skippedNodeCount +
    value.waitingApprovalNodeCount +
    value.pendingNodeCount;
  if (terminalNodeCount > value.totalNodeCount) {
    context.addIssue({
      code: "custom",
      message: "Node-state counts cannot exceed the total node count.",
      path: ["totalNodeCount"],
    });
  }
  if (
    value.planBindingState === "matched" &&
    (value.planId === null || value.planSha256 === null)
  ) {
    context.addIssue({
      code: "custom",
      message: "A matched plan binding requires a plan ID and digest.",
      path: ["planBindingState"],
    });
  }
  if (
    value.planExecutionBindingState === "matched" &&
    (
      value.executionWorkflowRunId === null ||
      value.executionPlanId === null ||
      value.planExecutionSha256 === null
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "A matched execution binding requires run, plan, and digest pins.",
      path: ["planExecutionBindingState"],
    });
  }
  if (
    value.verificationEvidenceSource === "model_assertion" &&
    value.criterionVerificationMethod !== "model_assertion"
  ) {
    context.addIssue({
      code: "custom",
      message: "Model evidence must remain labeled as a model assertion.",
      path: ["criterionVerificationMethod"],
    });
  }
  if (
    value.verificationEvidenceSource === "generated_summary" &&
    value.criterionVerificationMethod !== "generated_summary"
  ) {
    context.addIssue({
      code: "custom",
      message: "Summary evidence must remain labeled as generated summary.",
      path: ["criterionVerificationMethod"],
    });
  }
  if (
    value.verificationEvidenceSource === "unassessed" &&
    value.criterionVerificationMethod !== "unassessed"
  ) {
    context.addIssue({
      code: "custom",
      message: "Unassessed evidence cannot claim an assessed verification method.",
      path: ["criterionVerificationMethod"],
    });
  }
});

export type WorkflowOutcomeEvidenceV1 = z.infer<
  typeof workflowOutcomeEvidenceV1Schema
>;

const workflowOutcomeEvaluationBaseSchema = z.object({
  schemaVersion: z.literal(WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION),
  evaluationId: runContractIdSchema,
  workflowRunId: runContractIdSchema,
  outcomeContractBindingState: z.literal("posthoc"),
  evidence: workflowOutcomeEvidenceV1Schema,
  evidenceSha256: runContractSha256Schema,
  outcomeContract: outcomeContractV1Schema,
  outcomeContractSha256: runContractSha256Schema,
  terminalReceipt: terminalReceiptV1Schema,
  terminalReceiptSha256: runContractSha256Schema,
}).strict();

export const workflowOutcomeEvaluationV1Schema =
  workflowOutcomeEvaluationBaseSchema.superRefine((value, context) => {
    validateEvaluationBindings(value, context);
  });

export type WorkflowOutcomeEvaluationV1 = z.infer<
  typeof workflowOutcomeEvaluationV1Schema
>;

export type BuildWorkflowOutcomeEvaluationV1Input = Readonly<{
  detail: WorkflowRunDetail;
  result?: Record<string, unknown>;
}>;

/**
 * Evaluates the existing completed-workflow seam without upgrading its legacy
 * state. Current workflow verification is weak, so normal legacy completions
 * remain unverified unless a later schema supplies bound strong receipts.
 */
export function buildWorkflowOutcomeEvaluationV1({
  detail,
  result = detail.run.result || {},
}: BuildWorkflowOutcomeEvaluationV1Input): WorkflowOutcomeEvaluationV1 {
  const workflowRunId = runContractIdSchema.parse(detail.run.id);
  if (detail.run.status !== "running") {
    throw new Error(
      "Workflow outcome evaluation requires the runner's pre-completion running seam.",
    );
  }
  const goal = detail.run.goal.trim();
  const goalSha256 = sha256Text(goal);
  const planOutput = recordValue(stepOutput(detail, "plan"));
  const plan = recordValue(planOutput?.plan);
  const stepPlanId = stringValue(planOutput?.id);
  const resultPlanId = stringValue(result.dynamicPlanId);
  const planBindingState = plan
    ? bindingState(stepPlanId, resultPlanId)
    : stepPlanId || resultPlanId
      ? "invalid"
      : "missing";
  const selectedPlanId = resultPlanId || stepPlanId;
  const planId = selectedPlanId
    ? opaqueReferenceId("workflow-plan", selectedPlanId)
    : null;
  const planSha256 = plan
    ? sha256Json({ id: stepPlanId || null, plan })
    : null;

  const executeOutput = recordValue(stepOutput(detail, "execute"));
  const execution = recordValue(executeOutput?.planExecution);
  const executionProjection = projectExecutionEvidence(execution, plan);
  const rawExecutionWorkflowRunId = stringValue(execution?.workflowRunId);
  const rawExecutionPlanId = stringValue(execution?.planId);
  const executionWorkflowRunId = rawExecutionWorkflowRunId
    ? opaqueReferenceId("workflow-run", rawExecutionWorkflowRunId)
    : null;
  const executionPlanId = rawExecutionPlanId
    ? opaqueReferenceId("workflow-plan", rawExecutionPlanId)
    : null;
  const planExecutionSha256 = execution ? sha256Json(execution) : null;
  const resultExecutionStatus = planExecutionStatus(result.planExecutionStatus);
  const detailExecutionStatus = planExecutionStatus(execution?.status);
  const planExecutionBindingState = executionBindingState(
    result.planExecutionStatus,
    execution?.status,
    resultExecutionStatus,
    detailExecutionStatus,
    {
      expectedRunId: workflowRunId,
      expectedPlanId: planId,
      executionRunId: executionWorkflowRunId,
      executionPlanId,
      hasExecution: Boolean(execution),
      hasPlan: Boolean(plan),
    },
  );
  const effectiveExecutionStatus = strongestExecutionStatus([
    resultExecutionStatus,
    detailExecutionStatus,
    executionProjection.inferredStatus,
  ]);

  const verifyOutput = recordValue(stepOutput(detail, "verify"));
  const modelVerdict = recordValue(verifyOutput?.modelVerdict);
  const verificationPassed = booleanValue(verifyOutput?.passed);
  const mechanicalVerificationPassed = booleanValue(
    verifyOutput?.mechanicalPassed,
  );
  const verificationEvidenceSource: WorkflowOutcomeEvidenceV1["verificationEvidenceSource"] =
    modelVerdict
      ? "model_assertion"
      : "unassessed";
  const criterionVerificationMethod: WorkflowOutcomeEvidenceV1["criterionVerificationMethod"] =
    verificationEvidenceSource === "model_assertion"
      ? "model_assertion"
      : "unassessed";

  const report = stringValue(result.report);
  const reportSha256 = report ? sha256Text(report) : null;
  const rawMemoryId = stringValue(result.memoryId);
  const memoryId = rawMemoryId
    ? opaqueReferenceId("workflow-memory", rawMemoryId)
    : null;
  const artifactReceiptIds: string[] = [];

  const rawCriteria = declaredCriteria(detail.run.goal, plan);
  const criteriaOverflow = rawCriteria.length > MAX_OUTCOME_REQUIREMENTS;
  const criteria = rawCriteria.slice(0, MAX_OUTCOME_REQUIREMENTS);
  const acceptanceCriteria: OutcomeContractV1["acceptanceCriteria"] =
    criteria.map((criterion, index) => {
      const criterionSha256 = sha256Text(criterion);
      return {
        criterionId: opaqueDerivedId(
          "workflow-criterion",
          workflowRunId,
          String(index),
          criterionSha256,
        ),
        criterionSha256,
        requirementLevel: "required",
        verificationMethod: criterionVerificationMethod,
        verifierId: null,
      };
    });

  const outcomeContract = buildOutcomeContractV1({
    outcomeContractId: workflowOutcomeContractId(
      workflowRunId,
      goalSha256,
      planSha256,
    ),
    runId: workflowRunId,
    intentSpecId: workflowIntentSpecId(workflowRunId, goalSha256),
    contractState: "declared",
    acceptanceCriteria,
    artifactRequirements: [],
    effectRequirements: [],
  });

  const pendingApprovalIds = executionProjection.pendingApprovalIds.length
    ? executionProjection.pendingApprovalIds
    : effectiveExecutionStatus === "waiting_approval"
      ? [opaqueDerivedId("workflow-approval", workflowRunId, planId || "no-plan")]
      : [];
  const blockingDependencyIds = executionProjection.blockingDependencyIds.length
    ? executionProjection.blockingDependencyIds
    : effectiveExecutionStatus === "blocked"
      ? [opaqueDerivedId("workflow-blocker", workflowRunId, planId || "no-plan")]
      : [];

  const completedStepCount = detail.steps.filter(
    (step) => step.status === "completed",
  ).length;
  const usefulWorkUnitCount = boundedSum([
    executionProjection.executedToolCount,
    executionProjection.dryRunToolCount,
  ]);

  const evidence = workflowOutcomeEvidenceV1Schema.parse({
    schemaVersion: WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION,
    workflowRunId,
    intendedLegacyStatus: "completed",
    sourceRunStatus: detail.run.status,
    goalSha256,
    planId,
    planSha256,
    planBindingState,
    outcomeContractBindingState: "posthoc",
    executionWorkflowRunId,
    executionPlanId,
    planExecutionSha256,
    planExecutionStatus: effectiveExecutionStatus,
    planExecutionBindingState,
    verificationEvidenceSource,
    criterionVerificationMethod,
    verificationPassed,
    mechanicalVerificationPassed,
    criteriaOverflow,
    reportSha256,
    memoryId,
    completedStepCount,
    totalNodeCount: executionProjection.totalNodeCount,
    completedNodeCount: executionProjection.completedNodeCount,
    failedNodeCount: executionProjection.failedNodeCount,
    blockedNodeCount: executionProjection.blockedNodeCount,
    skippedNodeCount: executionProjection.skippedNodeCount,
    waitingApprovalNodeCount: executionProjection.waitingApprovalNodeCount,
    pendingNodeCount: executionProjection.pendingNodeCount,
    dryRunNodeCount: executionProjection.dryRunNodeCount,
    executedToolCount: executionProjection.executedToolCount,
    dryRunToolCount: executionProjection.dryRunToolCount,
    failedToolCount: executionProjection.failedToolCount,
    pendingApprovalIds,
    blockingDependencyIds,
    artifactReceiptIds,
    effectReceiptIds: [],
    verifierReceiptIds: [],
    usefulWorkUnitCount,
  });
  const evidenceSha256 = sha256Json(evidence);
  const outcomeContractSha256 = sha256Json(outcomeContract);

  const requirementResults: RequirementVerificationV1[] =
    outcomeContract.acceptanceCriteria.map((criterion) => ({
      requirementId: criterion.criterionId,
      requirementKind: "criterion",
      requirementLevel: criterion.requirementLevel,
      state: verificationEvidenceSource === "model_assertion" &&
        verificationPassed === false
        ? "failed"
        : criterion.verificationMethod === "unassessed"
          ? "not_assessed"
          : "unverified",
      verificationMethod: criterion.verificationMethod,
      verifierId: criterion.verifierId,
      verificationReceiptId: null,
    }));

  const disposition = dispositionFor(evidence, requirementResults);
  const terminalReceipt = buildTerminalReceiptV1({
    terminalReceiptId: workflowTerminalReceiptId(
      workflowRunId,
      outcomeContractSha256,
      evidenceSha256,
    ),
    runId: workflowRunId,
    outcomeContractId: outcomeContract.outcomeContractId,
    source: "outcome_evaluator",
    legacyStatus: null,
    disposition: disposition.disposition,
    executionMode: executionModeFor(evidence),
    verificationState: disposition.verificationState,
    reasonCode: disposition.reasonCode,
    requirementResults,
    usefulWorkUnitCount,
    artifactReceiptIds,
    effectReceiptIds: [],
    verifierReceiptIds: [],
    pendingApprovalIds,
    blockingDependencyIds,
    outputSha256: reportSha256,
  });
  const terminalReceiptSha256 = sha256Json(terminalReceipt);

  return workflowOutcomeEvaluationV1Schema.parse({
    schemaVersion: WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION,
    evaluationId: workflowEvaluationId(
      workflowRunId,
      evidenceSha256,
      outcomeContractSha256,
      terminalReceiptSha256,
    ),
    workflowRunId,
    outcomeContractBindingState: "posthoc",
    evidence,
    evidenceSha256,
    outcomeContract,
    outcomeContractSha256,
    terminalReceipt,
    terminalReceiptSha256,
  });
}

/** A missing field is legacy compatibility; a present malformed value fails. */
export function parseWorkflowOutcomeEvaluationV1(
  value: unknown,
  expectedRunId?: string,
): WorkflowOutcomeEvaluationV1 | undefined {
  if (value === undefined) return undefined;
  const parsed = workflowOutcomeEvaluationV1Schema.parse(value);
  if (expectedRunId !== undefined) {
    const expected = runContractIdSchema.parse(expectedRunId);
    if (parsed.workflowRunId !== expected) {
      throw new Error("Workflow outcome evaluation is bound to a different run.");
    }
  }
  return parsed;
}

const workflowOutcomeEventPayloadV1Schema = z.object({
  schemaVersion: z.literal(WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION),
  payloadKind: z.literal("workflow_outcome_evaluation"),
  workflowRunId: runContractIdSchema,
  evaluationId: runContractIdSchema,
  evaluationSha256: runContractSha256Schema,
  evidenceSha256: runContractSha256Schema,
  outcomeContractId: runContractIdSchema,
  outcomeContractSha256: runContractSha256Schema,
  terminalReceiptId: runContractIdSchema,
  terminalReceiptSha256: runContractSha256Schema,
  terminalDisposition: terminalDispositionSchema,
  terminalExecutionMode: runExecutionModeSchema,
  terminalVerificationState: terminalVerificationStateSchema,
  terminalSource: terminalReceiptSourceSchema,
  terminalReasonCode: terminalReasonCodeSchema,
  outcomeContractBindingState: z.literal("posthoc"),
  legacyWorkflowStatus: z.literal("completed"),
  planId: runContractIdSchema.nullable(),
  planSha256: runContractSha256Schema.nullable(),
  executionWorkflowRunId: runContractIdSchema.nullable(),
  executionPlanId: runContractIdSchema.nullable(),
  planExecutionSha256: runContractSha256Schema.nullable(),
  reportSha256: runContractSha256Schema.nullable(),
  requiredRequirementCount: boundedCountSchema,
  verifiedRequirementCount: boundedCountSchema,
  failedRequirementCount: boundedCountSchema,
  unverifiedRequirementCount: boundedCountSchema,
  usefulWorkUnitCount: boundedCountSchema,
  artifactReceiptCount: boundedCountSchema,
  effectReceiptCount: boundedCountSchema,
  verifierReceiptCount: boundedCountSchema,
  pendingApprovalCount: boundedCountSchema,
  blockingDependencyCount: boundedCountSchema,
  completedNodeCount: boundedCountSchema,
  failedNodeCount: boundedCountSchema,
  blockedNodeCount: boundedCountSchema,
  skippedNodeCount: boundedCountSchema,
  waitingApprovalNodeCount: boundedCountSchema,
  dryRunNodeCount: boundedCountSchema,
  dryRunToolCount: boundedCountSchema,
}).strict();

export type WorkflowOutcomeEventPayloadV1 = z.infer<
  typeof workflowOutcomeEventPayloadV1Schema
>;

/** Builds a compact metadata projection and never spreads full contracts. */
export function workflowOutcomeEventPayloadV1(
  evaluation: WorkflowOutcomeEvaluationV1,
): WorkflowOutcomeEventPayloadV1 {
  const parsed = workflowOutcomeEvaluationV1Schema.parse(evaluation);
  const receipt = parsed.terminalReceipt;
  return workflowOutcomeEventPayloadV1Schema.parse({
    schemaVersion: WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION,
    payloadKind: "workflow_outcome_evaluation",
    workflowRunId: parsed.workflowRunId,
    evaluationId: parsed.evaluationId,
    evaluationSha256: sha256Json(parsed),
    evidenceSha256: parsed.evidenceSha256,
    outcomeContractId: parsed.outcomeContract.outcomeContractId,
    outcomeContractSha256: parsed.outcomeContractSha256,
    terminalReceiptId: receipt.terminalReceiptId,
    terminalReceiptSha256: parsed.terminalReceiptSha256,
    terminalDisposition: receipt.disposition,
    terminalExecutionMode: receipt.executionMode,
    terminalVerificationState: receipt.verificationState,
    terminalSource: receipt.source,
    terminalReasonCode: receipt.reasonCode,
    outcomeContractBindingState: parsed.outcomeContractBindingState,
    legacyWorkflowStatus: parsed.evidence.intendedLegacyStatus,
    planId: parsed.evidence.planId,
    planSha256: parsed.evidence.planSha256,
    executionWorkflowRunId: parsed.evidence.executionWorkflowRunId,
    executionPlanId: parsed.evidence.executionPlanId,
    planExecutionSha256: parsed.evidence.planExecutionSha256,
    reportSha256: parsed.evidence.reportSha256,
    requiredRequirementCount: receipt.requiredRequirementCount,
    verifiedRequirementCount: receipt.verifiedRequirementCount,
    failedRequirementCount: receipt.failedRequirementCount,
    unverifiedRequirementCount: receipt.unverifiedRequirementCount,
    usefulWorkUnitCount: receipt.usefulWorkUnitCount,
    artifactReceiptCount: receipt.artifactReceiptIds.length,
    effectReceiptCount: receipt.effectReceiptIds.length,
    verifierReceiptCount: receipt.verifierReceiptIds.length,
    pendingApprovalCount: receipt.pendingApprovalIds.length,
    blockingDependencyCount: receipt.blockingDependencyIds.length,
    completedNodeCount: parsed.evidence.completedNodeCount,
    failedNodeCount: parsed.evidence.failedNodeCount,
    blockedNodeCount: parsed.evidence.blockedNodeCount,
    skippedNodeCount: parsed.evidence.skippedNodeCount,
    waitingApprovalNodeCount: parsed.evidence.waitingApprovalNodeCount,
    dryRunNodeCount: parsed.evidence.dryRunNodeCount,
    dryRunToolCount: parsed.evidence.dryRunToolCount,
  });
}

type EvaluationBase = z.infer<typeof workflowOutcomeEvaluationBaseSchema>;

function validateEvaluationBindings(
  value: EvaluationBase,
  context: z.RefinementCtx,
) {
  const addIssue = (message: string, path: Array<string | number>) => {
    context.addIssue({ code: "custom", message, path });
  };
  if (value.evidence.workflowRunId !== value.workflowRunId) {
    addIssue("Evidence is bound to a different workflow run.", ["evidence", "workflowRunId"]);
  }
  if (
    value.evidence.planExecutionBindingState === "matched" &&
    value.evidence.executionWorkflowRunId !== value.workflowRunId
  ) {
    addIssue(
      "Plan execution is bound to a different workflow run.",
      ["evidence", "executionWorkflowRunId"],
    );
  }
  if (
    value.evidence.planExecutionBindingState === "matched" &&
    value.evidence.executionPlanId !== value.evidence.planId
  ) {
    addIssue(
      "Plan execution is bound to a different workflow plan.",
      ["evidence", "executionPlanId"],
    );
  }
  if (value.outcomeContract.runId !== value.workflowRunId) {
    addIssue("Outcome contract is bound to a different workflow run.", ["outcomeContract", "runId"]);
  }
  if (value.terminalReceipt.runId !== value.workflowRunId) {
    addIssue("Terminal receipt is bound to a different workflow run.", ["terminalReceipt", "runId"]);
  }
  if (
    value.outcomeContract.intentSpecId !==
    workflowIntentSpecId(value.workflowRunId, value.evidence.goalSha256)
  ) {
    addIssue("Outcome contract is bound to a different workflow intent.", ["outcomeContract", "intentSpecId"]);
  }
  if (
    value.outcomeContract.outcomeContractId !==
    workflowOutcomeContractId(
      value.workflowRunId,
      value.evidence.goalSha256,
      value.evidence.planSha256,
    )
  ) {
    addIssue("Outcome contract ID does not match its workflow evidence.", ["outcomeContract", "outcomeContractId"]);
  }
  if (
    value.terminalReceipt.outcomeContractId !==
    value.outcomeContract.outcomeContractId
  ) {
    addIssue("Terminal receipt is bound to a different outcome contract.", ["terminalReceipt", "outcomeContractId"]);
  }

  const expectedEvidenceSha256 = sha256Json(value.evidence);
  const expectedOutcomeSha256 = sha256Json(value.outcomeContract);
  const expectedReceiptSha256 = sha256Json(value.terminalReceipt);
  if (value.evidenceSha256 !== expectedEvidenceSha256) {
    addIssue("Evidence digest does not match the evidence projection.", ["evidenceSha256"]);
  }
  if (value.outcomeContractSha256 !== expectedOutcomeSha256) {
    addIssue("Outcome-contract digest does not match the contract.", ["outcomeContractSha256"]);
  }
  if (value.terminalReceiptSha256 !== expectedReceiptSha256) {
    addIssue("Terminal-receipt digest does not match the receipt.", ["terminalReceiptSha256"]);
  }
  if (
    value.terminalReceipt.terminalReceiptId !==
    workflowTerminalReceiptId(
      value.workflowRunId,
      expectedOutcomeSha256,
      expectedEvidenceSha256,
    )
  ) {
    addIssue("Terminal receipt ID does not match its bound evidence.", ["terminalReceipt", "terminalReceiptId"]);
  }
  if (
    value.evaluationId !== workflowEvaluationId(
      value.workflowRunId,
      expectedEvidenceSha256,
      expectedOutcomeSha256,
      expectedReceiptSha256,
    )
  ) {
    addIssue("Evaluation ID does not match its bound components.", ["evaluationId"]);
  }

  validateRequirementBindings(value, addIssue);
  validateReceiptEvidenceBindings(value, addIssue);
  validateSucceededEvaluation(value, addIssue);
}

function validateRequirementBindings(
  value: EvaluationBase,
  addIssue: (message: string, path: Array<string | number>) => void,
) {
  type DeclaredRequirement = {
    kind: RequirementVerificationV1["requirementKind"];
    level: RequirementVerificationV1["requirementLevel"];
    method: RequirementVerificationV1["verificationMethod"];
    verifierId: string | null;
    effectMode: OutcomeContractV1["effectRequirements"][number]["effectMode"] | null;
  };
  const declared = new Map<string, DeclaredRequirement>();
  value.outcomeContract.acceptanceCriteria.forEach((entry) => {
    declared.set(entry.criterionId, {
      kind: "criterion",
      level: entry.requirementLevel,
      method: entry.verificationMethod,
      verifierId: entry.verifierId,
      effectMode: null,
    });
  });
  value.outcomeContract.artifactRequirements.forEach((entry) => {
    declared.set(entry.artifactRequirementId, {
      kind: "artifact",
      level: entry.requirementLevel,
      method: entry.verificationMethod,
      verifierId: entry.verifierId,
      effectMode: null,
    });
  });
  value.outcomeContract.effectRequirements.forEach((entry) => {
    declared.set(entry.effectRequirementId, {
      kind: "effect",
      level: entry.requirementLevel,
      method: entry.verificationMethod,
      verifierId: entry.verifierId,
      effectMode: entry.effectMode,
    });
  });

  const results = new Map(
    value.terminalReceipt.requirementResults.map((result) => [
      result.requirementId,
      result,
    ]),
  );
  declared.forEach((requirement, requirementId) => {
    const result = results.get(requirementId);
    if (!result) {
      addIssue("Every declared requirement needs an explicit result.", ["terminalReceipt", "requirementResults"]);
      return;
    }
    if (
      result.requirementKind !== requirement.kind ||
      result.requirementLevel !== requirement.level ||
      result.verificationMethod !== requirement.method ||
      result.verifierId !== requirement.verifierId
    ) {
      addIssue("Requirement result does not match its declared requirement.", ["terminalReceipt", "requirementResults"]);
    }
  });
  results.forEach((_result, requirementId) => {
    if (!declared.has(requirementId)) {
      addIssue("Terminal receipt contains an undeclared requirement.", ["terminalReceipt", "requirementResults"]);
    }
  });
  if (declared.size !== results.size) {
    addIssue("Declared and evaluated requirement counts must match.", ["terminalReceipt", "requirementResults"]);
  }
}

function validateReceiptEvidenceBindings(
  value: EvaluationBase,
  addIssue: (message: string, path: Array<string | number>) => void,
) {
  const receipt = value.terminalReceipt;
  const evidence = value.evidence;
  const bindings: Array<[
    readonly string[],
    readonly string[],
    string,
    Array<string | number>,
  ]> = [
    [receipt.pendingApprovalIds, evidence.pendingApprovalIds, "Pending approval IDs", ["terminalReceipt", "pendingApprovalIds"]],
    [receipt.blockingDependencyIds, evidence.blockingDependencyIds, "Blocking dependency IDs", ["terminalReceipt", "blockingDependencyIds"]],
    [receipt.artifactReceiptIds, evidence.artifactReceiptIds, "Artifact receipt IDs", ["terminalReceipt", "artifactReceiptIds"]],
    [receipt.effectReceiptIds, evidence.effectReceiptIds, "Effect receipt IDs", ["terminalReceipt", "effectReceiptIds"]],
    [receipt.verifierReceiptIds, evidence.verifierReceiptIds, "Verifier receipt IDs", ["terminalReceipt", "verifierReceiptIds"]],
  ];
  bindings.forEach(([actual, expected, label, path]) => {
    if (!sameIds(actual, expected)) {
      addIssue(`${label} do not match the evidence projection.`, path);
    }
  });
  const boundVerifierReceiptIds = receipt.requirementResults
    .map((result) => result.verificationReceiptId)
    .filter((id): id is string => id !== null);
  if (!sameIds(receipt.verifierReceiptIds, boundVerifierReceiptIds)) {
    addIssue(
      "Verifier receipt IDs must exactly match the requirement results.",
      ["terminalReceipt", "verifierReceiptIds"],
    );
  }
  if (receipt.usefulWorkUnitCount !== evidence.usefulWorkUnitCount) {
    addIssue("Useful-work count does not match the evidence projection.", ["terminalReceipt", "usefulWorkUnitCount"]);
  }
  if (receipt.outputSha256 !== evidence.reportSha256) {
    addIssue("Output digest does not match the persisted report digest.", ["terminalReceipt", "outputSha256"]);
  }

  const expected = dispositionFor(evidence, receipt.requirementResults);
  if (receipt.disposition !== expected.disposition) {
    addIssue("Terminal disposition does not match workflow evidence.", ["terminalReceipt", "disposition"]);
  }
  if (receipt.reasonCode !== expected.reasonCode) {
    addIssue("Terminal reason does not match workflow evidence.", ["terminalReceipt", "reasonCode"]);
  }
  if (receipt.verificationState !== expected.verificationState) {
    addIssue("Verification state does not match workflow evidence.", ["terminalReceipt", "verificationState"]);
  }
  if (receipt.executionMode !== executionModeFor(evidence)) {
    addIssue("Execution mode does not match workflow evidence.", ["terminalReceipt", "executionMode"]);
  }
}

function validateSucceededEvaluation(
  value: EvaluationBase,
  addIssue: (message: string, path: Array<string | number>) => void,
) {
  if (value.terminalReceipt.disposition !== "succeeded") return;
  // V1 derives its compatibility contract after execution. Internal hashes
  // prevent accidental/tampered cross-binding, but cannot authenticate a
  // pre-execution declaration. A future version with an external contract pin
  // may add the strong-receipt success path.
  addIssue(
    "A post-hoc workflow outcome evaluation cannot claim succeeded.",
    ["terminalReceipt", "disposition"],
  );
}

type ExecutionProjection = {
  inferredStatus: WorkflowOutcomeEvidenceV1["planExecutionStatus"];
  totalNodeCount: number;
  completedNodeCount: number;
  failedNodeCount: number;
  blockedNodeCount: number;
  skippedNodeCount: number;
  waitingApprovalNodeCount: number;
  pendingNodeCount: number;
  dryRunNodeCount: number;
  executedToolCount: number;
  dryRunToolCount: number;
  failedToolCount: number;
  pendingApprovalIds: string[];
  blockingDependencyIds: string[];
};

function projectExecutionEvidence(
  execution: Record<string, unknown> | undefined,
  plan: Record<string, unknown> | undefined,
): ExecutionProjection {
  const nodeExecutions = arrayRecords(execution?.nodeExecutions);
  const planNodes = arrayRecords(plan?.nodes);
  const nodeStatuses = nodeExecutions.map((node) => nodeExecutionStatus(node.status));
  const countStatus = (status: WorkflowPlanNodeExecutionStatus) =>
    nodeStatuses.filter((entry) => entry === status).length;

  const completedNodeCount = maximumCount(
    execution?.completedNodes,
    countStatus("completed"),
  );
  const failedNodeCount = maximumCount(
    execution?.failedNodes,
    countStatus("failed"),
  );
  const blockedNodeCount = maximumCount(
    execution?.blockedNodes,
    countStatus("blocked"),
  );
  const skippedNodeCount = maximumCount(
    execution?.skippedNodes,
    countStatus("skipped"),
  );
  const waitingApprovalNodeCount = maximumCount(
    execution?.waitingApprovalNodes,
    countStatus("waiting_approval"),
  );
  const explicitPendingNodeCount = nodeStatuses.filter(
    (status) => status === "pending" || status === "running",
  ).length;

  const toolExecutions = nodeExecutions.flatMap((node) => {
    const output = recordValue(node.output);
    return arrayRecords(output?.toolExecutions);
  });
  const dryRunToolCount = maximumCount(
    execution?.dryRunTools,
    toolExecutions.filter((tool) => tool.dryRun === true).length,
  );
  const executedToolCount = maximumCount(
    execution?.executedTools,
    toolExecutions.filter(
      (tool) => tool.dryRun !== true && tool.status === "executed",
    ).length,
  );
  const failedToolCount = toolExecutions.filter((tool) =>
    ["failed", "executing", "rejected"].includes(String(tool.status || "")),
  ).length;
  const dryRunNodeCount = Math.max(
    planNodes.filter((node) => node.policy === "dry_run").length,
    nodeExecutions.filter((node) => recordValue(node.output)?.dryRunOnly === true).length,
  );

  let totalNodeCount = maximumCount(
    execution?.totalNodes,
    planNodes.length,
    nodeExecutions.length,
  );
  let pendingNodeCount = explicitPendingNodeCount;
  const observedStates = boundedSum([
    completedNodeCount,
    failedNodeCount,
    blockedNodeCount,
    skippedNodeCount,
    waitingApprovalNodeCount,
    pendingNodeCount,
  ]);
  totalNodeCount = Math.max(totalNodeCount, observedStates);
  const accountedWithoutPending = boundedSum([
    completedNodeCount,
    failedNodeCount,
    blockedNodeCount,
    skippedNodeCount,
    waitingApprovalNodeCount,
  ]);
  pendingNodeCount = Math.max(
    pendingNodeCount,
    Math.max(0, totalNodeCount - accountedWithoutPending),
  );

  const waitingTools = toolExecutions.filter(
    (tool) => tool.status === "approval_required",
  );
  const blockedTools = toolExecutions.filter(
    (tool) => tool.status === "blocked" || tool.status === "rejected",
  );
  const pendingApprovalIds = uniqueReferences(
    "workflow-approval",
    [
      ...nodeExecutions
        .filter((node) => node.status === "waiting_approval")
        .map((node) => stringValue(node.id) || stringValue(node.nodeId)),
      ...waitingTools.map((tool) => stringValue(tool.id) || stringValue(tool.toolId)),
    ],
    MAX_OUTCOME_REQUIREMENTS,
  );
  const blockingDependencyIds = uniqueReferences(
    "workflow-blocker",
    [
      ...nodeExecutions
        .filter((node) => node.status === "blocked")
        .map((node) => stringValue(node.id) || stringValue(node.nodeId)),
      ...blockedTools.map((tool) => stringValue(tool.id) || stringValue(tool.toolId)),
    ],
    MAX_OUTCOME_REQUIREMENTS,
  );

  const inferredStatus = strongestExecutionStatus([
    failedNodeCount > 0 || failedToolCount > 0 ? "failed" : undefined,
    blockedNodeCount > 0 || blockedTools.length > 0 ? "blocked" : undefined,
    waitingApprovalNodeCount > 0 || waitingTools.length > 0
      ? "waiting_approval"
      : undefined,
    pendingNodeCount > 0 ? "running" : undefined,
    totalNodeCount > 0 && completedNodeCount === totalNodeCount
      ? "completed"
      : undefined,
  ]);

  return {
    inferredStatus,
    totalNodeCount,
    completedNodeCount,
    failedNodeCount,
    blockedNodeCount,
    skippedNodeCount,
    waitingApprovalNodeCount,
    pendingNodeCount,
    dryRunNodeCount,
    executedToolCount,
    dryRunToolCount,
    failedToolCount,
    pendingApprovalIds,
    blockingDependencyIds,
  };
}

function dispositionFor(
  evidence: WorkflowOutcomeEvidenceV1,
  requirementResults: readonly RequirementVerificationV1[],
): Pick<
  TerminalReceiptV1,
  "disposition" | "reasonCode" | "verificationState"
> {
  const failedRequirements = requirementResults.filter(
    (result) =>
      result.requirementLevel === "required" && result.state === "failed",
  ).length;
  const unverifiedRequirements = requirementResults.filter(
    (result) =>
      result.requirementLevel === "required" &&
      (result.state === "unverified" || result.state === "not_assessed"),
  ).length;
  if (
    evidence.planExecutionStatus === "failed" ||
    evidence.failedNodeCount > 0 ||
    evidence.failedToolCount > 0 ||
    evidence.mechanicalVerificationPassed === false ||
    (
      evidence.verificationEvidenceSource === "model_assertion" &&
      evidence.verificationPassed === false
    ) ||
    failedRequirements > 0
  ) {
    return {
      disposition: "failed",
      reasonCode: failedRequirements > 0
        ? "requirements_unmet"
        : "execution_failed",
      verificationState: "unverified",
    };
  }
  if (
    evidence.planExecutionStatus === "blocked" ||
    evidence.blockedNodeCount > 0 ||
    evidence.blockingDependencyIds.length > 0
  ) {
    return {
      disposition: "blocked",
      reasonCode: "external_dependency",
      verificationState: "not_applicable",
    };
  }
  if (
    evidence.planExecutionStatus === "waiting_approval" ||
    evidence.waitingApprovalNodeCount > 0 ||
    evidence.pendingApprovalIds.length > 0
  ) {
    return {
      disposition: "waiting_approval",
      reasonCode: "approval_required",
      verificationState: "not_applicable",
    };
  }
  if (
    (evidence.skippedNodeCount > 0 ||
      evidence.dryRunNodeCount > 0 ||
      evidence.dryRunToolCount > 0) &&
    evidence.usefulWorkUnitCount > 0 &&
    (failedRequirements + unverifiedRequirements > 0)
  ) {
    return {
      disposition: "partial",
      reasonCode: "requirements_unmet",
      verificationState: "unverified",
    };
  }
  return {
    disposition: "unverified",
    reasonCode: "verification_inconclusive",
    verificationState: "unverified",
  };
}

function executionModeFor(
  evidence: WorkflowOutcomeEvidenceV1,
): TerminalReceiptV1["executionMode"] {
  if (evidence.dryRunNodeCount > 0 || evidence.dryRunToolCount > 0) {
    return "dry_run";
  }
  if (evidence.executedToolCount > 0) {
    return "live";
  }
  return "unassessed";
}

function declaredCriteria(
  goal: string,
  plan: Record<string, unknown> | undefined,
) {
  const values: string[] = [goal];
  values.push(...stringArray(plan?.acceptanceCriteria));
  arrayRecords(plan?.nodes).forEach((node) => {
    values.push(...stringArray(node.acceptanceCriteria));
  });
  const seen = new Set<string>();
  return values
    .map((value) => value.trim())
    .filter((value) => {
      if (!value || seen.has(value)) return false;
      seen.add(value);
      return true;
    });
}

function stepOutput(detail: WorkflowRunDetail, stepKey: WorkflowStepKey) {
  return detail.steps.find((step) => step.stepKey === stepKey)?.output;
}

function bindingState(
  first: string | undefined,
  second: string | undefined,
): WorkflowOutcomeEvidenceV1["planBindingState"] {
  if (first && second) return first === second ? "matched" : "mismatched";
  if (first || second) return "single_source";
  return "missing";
}

function executionBindingState(
  rawFirst: unknown,
  rawSecond: unknown,
  first: WorkflowOutcomeEvidenceV1["planExecutionStatus"] | undefined,
  second: WorkflowOutcomeEvidenceV1["planExecutionStatus"] | undefined,
  binding: {
    expectedRunId: string;
    expectedPlanId: string | null;
    executionRunId: string | null;
    executionPlanId: string | null;
    hasExecution: boolean;
    hasPlan: boolean;
  },
): WorkflowOutcomeEvidenceV1["planExecutionBindingState"] {
  if (
    (rawFirst !== undefined && !first) ||
    (rawSecond !== undefined && !second)
  ) {
    return "invalid";
  }
  if (!binding.hasExecution) return first ? "single_source" : "missing";
  if (
    !binding.hasPlan ||
    binding.expectedPlanId === null ||
    binding.executionRunId === null ||
    binding.executionPlanId === null
  ) {
    return "invalid";
  }
  if (
    binding.executionRunId !== binding.expectedRunId ||
    binding.executionPlanId !== binding.expectedPlanId
  ) {
    return "mismatched";
  }
  if (first && second) return first === second ? "matched" : "mismatched";
  if (first || second) return "single_source";
  return "missing";
}

function planExecutionStatus(
  value: unknown,
): Exclude<WorkflowOutcomeEvidenceV1["planExecutionStatus"], "unassessed"> | undefined {
  return ["running", "completed", "waiting_approval", "blocked", "failed"].includes(
    String(value || ""),
  )
    ? value as Exclude<WorkflowOutcomeEvidenceV1["planExecutionStatus"], "unassessed">
    : undefined;
}

function strongestExecutionStatus(
  statuses: Array<WorkflowOutcomeEvidenceV1["planExecutionStatus"] | undefined>,
): WorkflowOutcomeEvidenceV1["planExecutionStatus"] {
  const priority: WorkflowOutcomeEvidenceV1["planExecutionStatus"][] = [
    "failed",
    "blocked",
    "waiting_approval",
    "running",
    "completed",
    "unassessed",
  ];
  return priority.find((status) => statuses.includes(status)) || "unassessed";
}

function nodeExecutionStatus(
  value: unknown,
): WorkflowPlanNodeExecutionStatus | undefined {
  return [
    "pending",
    "running",
    "completed",
    "waiting_approval",
    "blocked",
    "failed",
    "skipped",
  ].includes(String(value || ""))
    ? value as WorkflowPlanNodeExecutionStatus
    : undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value
      .map(recordValue)
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function booleanValue(value: unknown) {
  return typeof value === "boolean" ? value : null;
}

function maximumCount(...values: unknown[]) {
  return Math.max(0, ...values.map(boundedCount));
}

function boundedCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(MAX_COUNT, Math.floor(value))
    : 0;
}

function boundedSum(values: readonly number[]) {
  return Math.min(
    MAX_COUNT,
    values.reduce((total, value) => total + boundedCount(value), 0),
  );
}

function uniqueReferences(
  prefix: string,
  values: Array<string | undefined>,
  max: number,
) {
  return [...new Set(
    values.filter((value): value is string => Boolean(value)).map((value) =>
      opaqueReferenceId(prefix, value)
    ),
  )].slice(0, max);
}

function sameIds(first: readonly string[], second: readonly string[]) {
  if (first.length !== second.length) return false;
  const expected = new Set(second);
  return first.every((id) => expected.has(id));
}

function opaqueReferenceId(prefix: string, value: string) {
  const normalized = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(normalized)) {
    return normalized;
  }
  return opaqueDerivedId(prefix, normalized);
}

function opaqueDerivedId(prefix: string, ...values: string[]) {
  return `${prefix}:${sha256Text(values.join("\0"))}`;
}

function workflowIntentSpecId(runId: string, goalSha256: string) {
  return opaqueDerivedId("workflow-intent", runId, goalSha256, "v1");
}

function workflowOutcomeContractId(
  runId: string,
  goalSha256: string,
  planSha256: string | null,
) {
  return opaqueDerivedId(
    "workflow-outcome",
    runId,
    goalSha256,
    planSha256 || "no-plan",
    "v1",
  );
}

function workflowTerminalReceiptId(
  runId: string,
  outcomeContractSha256: string,
  evidenceSha256: string,
) {
  return opaqueDerivedId(
    "workflow-terminal",
    runId,
    outcomeContractSha256,
    evidenceSha256,
    "v1",
  );
}

function workflowEvaluationId(
  runId: string,
  evidenceSha256: string,
  outcomeContractSha256: string,
  terminalReceiptSha256: string,
) {
  return opaqueDerivedId(
    "workflow-evaluation",
    runId,
    evidenceSha256,
    outcomeContractSha256,
    terminalReceiptSha256,
    "v1",
  );
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Workflow outcome hash input is not JSON serializable.");
  }
  return sha256Text(JSON.stringify(sortJsonForHash(JSON.parse(serialized))));
}

function sortJsonForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonForHash);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortJsonForHash(record[key])]),
    );
  }
  return value;
}
