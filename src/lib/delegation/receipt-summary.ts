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
 * Keep useful independent findings and plans. A clear server-owned status
 * separates assigned work from completed outcomes, and removes direct model
 * contradictions of the creation receipt rather than erasing the whole reply.
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
  const usefulResponse = response.trim().split(/(?<=[.!?])\s+|\n{2,}/)
    .filter(part => !contradictsDelegationReceipt(part) && !contradictsQueuedAssignment(part, receipts))
    .join("\n\n").slice(0, 35_000);
  const assigned = receipts.map(receipt =>
    `- ${agentName(receipt.delegateAgentId)}: ${receipt.state.replaceAll("_", " ")} at assignment (task \`${receipt.executionId}\`).`).join("\n");
  const reconciled = [usefulResponse,
    `Assigned specialist work:\n${assigned}`,
    "These assignment receipts do not mean the task is finished. Each specialist's result or blocker will return to this conversation; your coordinating Agent retains responsibility for the overall outcome.",
  ].filter(Boolean).join("\n\n");
  return Object.freeze({
    response: reconciled,
    receiptCount: receipts.length,
    replaced: response !== reconciled,
  });
}

function contradictsDelegationReceipt(text: string) {
  return /\b(?:delegation|delegating|sub[- ]?agents?|child(?:ren|\s+agents?)?|specialists?)\b[^.!?]{0,100}\b(?:unavailable|unsupported|not\s+(?:available|possible)|cannot\s+be\s+(?:created|started))\b/i.test(text) ||
    /\b(?:cannot|can't|unable\s+to|could\s+not|did\s+not|didn't)\b[^.!?]{0,50}\b(?:delegate|spawn|create\s+(?:a\s+)?(?:child|sub[- ]?agent))\b/i.test(text) ||
    /\bno\s+(?:child(?:ren)?|sub[- ]?agents?|specialists?|delegations?)\b[^.!?]{0,45}\b(?:created|started|assigned|spawned)\b/i.test(text) ||
    /^(?:(?:all|the|your)\s+)?(?:work|task|request|goal|everything)\s+(?:is|has\s+been)\s+(?:fully\s+)?(?:done|complete|completed|finished)[.!]?$/i.test(text.trim());
}

function contradictsQueuedAssignment(text: string, receipts: readonly DelegationReceiptProjection[]) {
  // A named completion claim needs more than that specialist's queued receipts.
  // Do not erase independent prose, or claims supported by a verified result.
  const queued = new Set(receipts.filter(receipt => receipt.state === "queued")
    .map(receipt => receipt.delegateAgentId));
  for (const receipt of receipts) {
    if (receipt.state === "verified") queued.delete(receipt.delegateAgentId);
  }
  for (const id of queued) {
    const displayName = agentName(id);
    const names = displayName === "Specialist" ? [id] : [id, displayName];
    for (const name of new Set(names)) {
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const subject = `\\b${escaped}(?:['’]s\\s+(?:task|work|check|review))?\\s+`;
      if (new RegExp(`${subject}(?:(?:has|have)\\s+)?(?:successfully\\s+)?(?:finished|completed)\\b`, "i").test(text) ||
          new RegExp(`${subject}(?:is|was|has\\s+been)\\s+(?:fully\\s+)?(?:done|complete|completed|finished)\\b`, "i").test(text)) return true;
    }
  }
  return false;
}

function agentName(id: string) {
  return ({ atlas: "Atlas", scout: "Scout", meridian: "Meridian", forge: "Forge",
    sentinel: "Sentinel", mnemosyne: "Mnemosyne" } as Record<string, string>)[id] || "Specialist";
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
