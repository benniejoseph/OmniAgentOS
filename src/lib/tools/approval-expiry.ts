import type { ToolExecutionRecord } from "@/lib/tools/types";

const DAY_MS = 86_400_000;

/**
 * How many days a pending approval waits for a decision. Retention expires
 * approvals this old when it sweeps; a decision checks the same age, so an
 * approval cannot be approved between sweeps or where no sweep runs.
 */
export function pendingToolApprovalDays() {
  const parsed = Number(process.env.OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3_650
    ? parsed
    : 7;
}

/** Whether a pending approval has waited longer than the approval window. */
export function toolApprovalExpired(
  record: Pick<ToolExecutionRecord, "status" | "createdAt">,
  now = Date.now(),
) {
  if (record.status !== "approval_required") return false;
  const createdAt = Date.parse(record.createdAt);
  // An unreadable creation time cannot show the approval is still fresh.
  return !Number.isFinite(createdAt) ||
    createdAt < now - pendingToolApprovalDays() * DAY_MS;
}
