import {
  canonicalStatusForTerminalReceipt,
  canonicalStatusForWorkflowRun,
  canonicalStatusForWorkflowStep,
} from "@/lib/status/canonical";
import {
  parseWorkflowOutcomeEvaluationV1,
  type WorkflowOutcomeEvaluationV1,
} from "@/lib/workflows/outcome-evaluator";
import type {
  WorkflowRunDetail,
  WorkflowRunRecord,
  WorkflowStats,
} from "@/lib/workflows/types";

function outcomeEvaluationFor(run: WorkflowRunRecord) {
  try {
    return parseWorkflowOutcomeEvaluationV1(
      run.result?.outcomeEvaluation,
      run.id,
    );
  } catch {
    // Stored shadow data is untrusted at the public boundary. Preserve the
    // truthful legacy projection instead of failing or upgrading the read.
    return undefined;
  }
}

function publicOutcome(evaluation: WorkflowOutcomeEvaluationV1 | undefined) {
  if (!evaluation) return null;
  return {
    schemaVersion: evaluation.schemaVersion,
    outcomeContractBindingState: evaluation.outcomeContractBindingState,
    outcomeContract: evaluation.outcomeContract,
    outcomeContractSha256: evaluation.outcomeContractSha256,
    terminalReceipt: evaluation.terminalReceipt,
    terminalReceiptSha256: evaluation.terminalReceiptSha256,
  };
}

/**
 * Additive, display-only workflow projection. The legacy status remains the
 * authoritative control value during the shadow rollout.
 */
export function publicWorkflowRun(run: WorkflowRunRecord) {
  const evaluation = outcomeEvaluationFor(run);
  return {
    ...run,
    canonicalStatus: evaluation
      ? canonicalStatusForTerminalReceipt(
          evaluation.terminalReceipt,
          "workflow_run",
        )
      : canonicalStatusForWorkflowRun(run),
    outcome: publicOutcome(evaluation),
  };
}

export function publicWorkflowRunDetail(detail: WorkflowRunDetail) {
  return {
    ...detail,
    run: publicWorkflowRun(detail.run),
    steps: detail.steps.map((step) => ({
      ...step,
      canonicalStatus: canonicalStatusForWorkflowStep(step),
    })),
  };
}

export function publicWorkflowStats(stats: WorkflowStats) {
  return {
    ...stats,
    latest: stats.latest.map(publicWorkflowRun),
  };
}

export function publicWorkflowStatus<
  RecordType extends { status: unknown },
>(record: RecordType) {
  return {
    ...record,
    canonicalStatus: canonicalStatusForWorkflowRun(record),
    outcome: null,
  };
}
