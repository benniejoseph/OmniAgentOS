import { approvalInboxHref, commandConversationHref } from "@/lib/approvals/inbox-link";
import type { ActivityItem, ActivityReference } from "@/lib/activity/contracts";
import type { ApprovalQueueItem } from "@/lib/operations/queue";
import { terminalReceiptV1Schema } from "@/lib/runs/contracts";
import type { AgentRunRecord } from "@/lib/runs/types";
import {
  canonicalStatusForAgentRun,
  canonicalStatusForApproval,
  canonicalStatusForTerminalReceipt,
} from "@/lib/status/canonical";
import type { PersonalNotification } from "@/lib/today/types";

const runCopy = {
  queued: "Queued to start.",
  running: "The run is in progress.",
  resuming: "The run is resuming.",
  waiting_approval: "Waiting for an approval decision.",
  waiting_clarification: "Waiting for clarification in the conversation.",
  completed: "The run completed; its outcome has not been verified.",
  failed: "The run failed. Open its source to inspect the result.",
  canceled: "The run was canceled.",
} as const;

/** This projection receives only records whose ownership has already been checked. */
export function projectActivityRun(run: AgentRunRecord): ActivityItem | undefined {
  if (!activityId(run.id) || typeof run.status !== "string" || !Object.hasOwn(runCopy, run.status) ||
    (run.threadId !== undefined && !activityId(run.threadId))) return undefined;
  const completed = date(run.completedAt);
  const started = date(run.startedAt);
  if (!started) return undefined;
  const terminal = ["completed", "failed", "canceled"].includes(run.status);
  const receipt = terminalReceiptV1Schema.safeParse(run.terminalReceipt);
  const canonicalStatus = terminal && receipt.success && receipt.data.runId === run.id
    ? canonicalStatusForTerminalReceipt(receipt.data, "agent_run")
    : canonicalStatusForAgentRun(run.status);
  const sourceRef: ActivityReference = { kind: "run", id: run.id };
  return {
    id: `run:${run.id}`,
    group: terminal ? "history" : run.status.startsWith("waiting_") ? "needs_you" : "working",
    workKey: `run:${run.id}`,
    source: "runs",
    sourceRef,
    references: [sourceRef],
    title: "Agent run",
    summary: terminal && canonicalStatus.basis === "terminal_receipt"
      ? terminalCopy[canonicalStatus.status]
      : runCopy[run.status],
    status: run.status,
    canonicalStatus,
    timestamp: terminal && completed
      ? { at: completed, basis: "completed" }
      : { at: started, basis: "started" },
    href: commandConversationHref({ runId: run.id, threadId: run.threadId }),
  };
}

export function projectActivityApproval(
  approval: ApprovalQueueItem,
  matchingRun?: AgentRunRecord,
): ActivityItem | undefined {
  const at = date(approval.createdAt);
  if (!activityId(approval.id) || !at ||
    !["tool", "workflow", "slo_policy"].includes(approval.kind)) return undefined;
  const validStatus = approval.kind === "tool"
    ? ["approval_required", "reconciliation_required"].includes(approval.status)
    : approval.kind === "workflow" ? approval.status === "waiting_approval" : approval.status === "pending";
  if (!validStatus) return undefined;
  const sourceRef: ActivityReference = { kind: "approval", id: approval.id, approvalKind: approval.kind };
  const linkedRun = matchingRun && approval.kind === "tool" &&
    matchingRun.status === "waiting_approval" &&
    matchingRun.continuation?.pendingToolCall?.executionId === approval.id
    ? matchingRun : undefined;
  const origin = linkedRun ? {
    runId: linkedRun.id,
    ...(linkedRun.threadId ? { threadId: linkedRun.threadId } : {}),
    href: commandConversationHref({ runId: linkedRun.id, threadId: linkedRun.threadId }),
  } : undefined;
  return {
    id: `approval:${approval.kind}:${approval.id}`,
    group: "needs_you",
    workKey: origin ? `run:${origin.runId}` : `approval:${approval.kind}:${approval.id}`,
    source: "approvals",
    sourceRef,
    references: [sourceRef, ...(origin ? [{ kind: "run" as const, id: origin.runId }] : [])],
    title: approval.kind === "tool" ? "Tool approval" : approval.kind === "workflow" ? "Workflow approval" : "Policy approval",
    summary: approval.status === "reconciliation_required"
      ? "An approved action needs reconciliation. Open the approval to inspect its receipt."
      : "A decision is waiting in the approvals inbox.",
    status: approval.status,
    canonicalStatus: { ...canonicalStatusForApproval("approval_required"), sourceStatus: approval.status },
    timestamp: { at, basis: "created" },
    href: approvalInboxHref({ id: approval.id, kind: approval.kind, returnTo: "/app/activity" }),
    ...(origin ? { origin } : {}),
  };
}

export function projectActivityNotification(notification: PersonalNotification): ActivityItem | undefined {
  const at = date(notification.updatedAt);
  if (!activityId(notification.id) || !activityId(notification.sourceId) || !at ||
    notification.kind !== "reminder" || notification.sourceType !== "today_item" ||
    !["unread", "read", "snoozed", "dismissed", "acted"].includes(notification.status)) return undefined;
  const sourceRef: ActivityReference = { kind: "notification", id: notification.id };
  return {
    id: `notification:${notification.id}`,
    group: notification.status === "unread" || notification.status === "snoozed" ? "updates" : "history",
    workKey: `today_item:${notification.sourceId}`,
    source: "notifications",
    sourceRef,
    references: [sourceRef, { kind: "today_item", id: notification.sourceId }],
    title: "Reminder",
    summary: notification.status === "unread" ? "An unread reminder is available in Today."
      : notification.status === "snoozed" ? "This reminder is snoozed."
      : notification.status === "read" ? "This reminder has been read."
      : notification.status === "dismissed" ? "This reminder was dismissed."
      : "An action was recorded for this reminder.",
    status: notification.status,
    timestamp: { at, basis: "updated" },
    href: "/app",
  };
}

const terminalCopy = {
  preview: "The run ended with a preview; no live outcome is claimed.",
  running: "The terminal receipt still reports work in progress.",
  waiting: "The run ended while waiting for a required decision or input.",
  blocked: "The run ended with a blocked outcome.",
  partial: "The run ended with a partial outcome. Open its source to inspect what remains.",
  unverified: "The run ended; its outcome has not been verified.",
  failed: "The terminal receipt reports a failed outcome.",
  canceled: "The terminal receipt reports a canceled outcome.",
  succeeded: "The run completed with a verified outcome.",
} as const;

/** Full opaque identities are retained; free-form bodies never enter the projection. */
export function activityId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,199}$/.test(value);
}

function date(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
}
