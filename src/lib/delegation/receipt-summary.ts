import type { GovernedToolExecutionResult } from "@/lib/tools/executor";
import type { DelegationExecutionState } from "@/lib/delegation/execution-record";

const DELEGATION_TOOL_ID = "app.agents.delegate";
const DELEGATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/;
const RECEIPT_KEYS = "childRunId,delegateAgentId,executionId,state";
const DELEGATION_STATES = new Set<DelegationExecutionState>([
  "queued",
  "running",
  "waiting",
  "completed_proposed",
  "verified",
  "rejected",
  "failed",
  "canceled",
  "expired",
]);

export type DelegationReceiptProjection = Readonly<{
  executionId: string;
  childRunId: string;
  delegateAgentId: string;
  state: DelegationExecutionState;
}>;

export type DelegationReceiptReconciliation = Readonly<{
  response: string;
  receiptCount: number;
  replaced: boolean;
}>;

/**
 * Projects only live, successful delegation receipts from executions that the
 * current run performed in memory. Persisted or model-supplied payloads must
 * not be passed through this trusted boundary.
 */
export function projectSuccessfulDelegationReceipts(
  executions: readonly GovernedToolExecutionResult[],
): readonly DelegationReceiptProjection[] {
  const seenExecutionIds = new Set<string>();
  const receipts: DelegationReceiptProjection[] = [];

  for (const execution of executions) {
    if (!isRecord(execution) || !isRecord(execution.record)) continue;
    const record = execution.record;
    if (
      record.toolId !== DELEGATION_TOOL_ID ||
      record.status !== "executed" ||
      record.dryRun !== false ||
      record.approvalRequired !== false ||
      record.approvalDecision !== undefined ||
      (record.approvals?.length || 0) > 0 ||
      record.approvedBy !== undefined ||
      record.approvedAt !== undefined ||
      record.approvalReason !== undefined
    ) {
      continue;
    }

    const task = delegationTask(execution.result);
    if (!task || seenExecutionIds.has(task.executionId)) continue;

    seenExecutionIds.add(task.executionId);
    receipts.push(Object.freeze(task));
  }

  return Object.freeze(receipts);
}

/**
 * The receipts a run holds so far: those it carried across earlier approval
 * pauses, then those its live executions produced, each task once.
 */
export function collectDelegationReceipts(
  executions: readonly GovernedToolExecutionResult[],
  carried: readonly DelegationReceiptProjection[] = [],
): readonly DelegationReceiptProjection[] {
  const receipts = new Map<string, DelegationReceiptProjection>();
  for (const receipt of [
    ...carried,
    ...projectSuccessfulDelegationReceipts(executions),
  ]) {
    if (!receipts.has(receipt.executionId)) {
      receipts.set(receipt.executionId, receipt);
    }
  }
  return Object.freeze([...receipts.values()]);
}

/**
 * Reads the receipts a paused run projected into its server-written
 * continuation. Anything but a list of distinct, well-formed receipts reads
 * as undefined, so the caller rejects the continuation instead of trusting
 * part of it.
 */
export function parseCarriedDelegationReceipts(
  value: unknown,
): readonly DelegationReceiptProjection[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const receipts: DelegationReceiptProjection[] = [];
  const seenExecutionIds = new Set<string>();
  for (const item of value) {
    if (
      !isRecord(item) ||
      Object.keys(item).sort().join(",") !== RECEIPT_KEYS
    ) {
      return undefined;
    }
    const receipt = delegationTask({ task: item });
    if (!receipt || seenExecutionIds.has(receipt.executionId)) return undefined;
    seenExecutionIds.add(receipt.executionId);
    receipts.push(Object.freeze(receipt));
  }
  return Object.freeze(receipts);
}

/**
 * Produces the exact user-facing reconciliation text: one task ID and its
 * initial state per line, in governed execution order, with no inferred
 * completion claim or other task detail.
 */
export function summarizeSuccessfulDelegationReceipts(
  executions: readonly GovernedToolExecutionResult[],
): string | null {
  const receipts = projectSuccessfulDelegationReceipts(executions);
  if (receipts.length === 0) return null;
  return delegationReceiptSummary(receipts);
}

/**
 * Reconciles fallible model prose against server-owned execution receipts,
 * including those a resumed run carried across its approval pauses.
 * Successful dynamic delegation is asynchronous, so the receipt and its
 * initial state are the only terminal facts the parent may report here.
 */
export function reconcileResponseWithDelegationReceipts(
  response: string,
  executions: readonly GovernedToolExecutionResult[],
  carried: readonly DelegationReceiptProjection[] = [],
): DelegationReceiptReconciliation {
  const receipts = collectDelegationReceipts(executions, carried);
  if (receipts.length === 0) {
    return Object.freeze({ response, receiptCount: 0, replaced: false });
  }
  const reconciled = delegationReceiptSummary(receipts);
  return Object.freeze({
    response: reconciled,
    receiptCount: receipts.length,
    replaced: response !== reconciled,
  });
}

function delegationReceiptSummary(
  receipts: readonly DelegationReceiptProjection[],
) {
  return receipts
    .map((receipt) => `- ${receipt.executionId} — ${receipt.state}`)
    .join("\n");
}

function delegationTask(result: unknown): DelegationReceiptProjection | null {
  if (!isRecord(result)) return null;
  const task = result.task;
  if (!isRecord(task)) return null;

  const executionId = delegationId(task.executionId);
  const childRunId = delegationId(task.childRunId);
  const delegateAgentId = delegationId(task.delegateAgentId);
  const state = isDelegationState(task.state)
    ? task.state
    : null;
  if (!executionId || !childRunId || !delegateAgentId || !state) return null;

  return { executionId, childRunId, delegateAgentId, state };
}

function delegationId(value: unknown) {
  return typeof value === "string" && DELEGATION_ID_PATTERN.test(value)
    ? value
    : null;
}

function isDelegationState(value: unknown): value is DelegationExecutionState {
  return typeof value === "string" && DELEGATION_STATES.has(
    value as DelegationExecutionState,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
