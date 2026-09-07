import {
  listAbandonedExternalA2ASafety,
  touchExternalA2ASafety,
  type A2ASafetyStatus,
} from "@/lib/a2a/safety-store";
import { getDelegationTask, transitionDelegationTask } from "@/lib/delegation/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

export async function reconcileAbandonedExternalA2ATasks(input: {
  tenantId: string;
  limit?: number;
  now?: string;
}) {
  const now = input.now || new Date().toISOString();
  const abandoned = await listAbandonedExternalA2ASafety({
    tenantId: input.tenantId,
    limit: input.limit,
    now,
  });
  const results: Array<Readonly<{
    internalTaskId: string;
    outcome: "expired" | "canceled" | "already_terminal" | "failed";
    reason?: string;
  }>> = [];

  for (const safety of abandoned) {
    try {
      const reservation = safety.reservation;
      const task = await getDelegationTask({
        tenantId: reservation.tenantId,
        ownerActorId: reservation.ownerActorId,
        taskId: reservation.internalTaskId,
      });
      const scope = createExecutionScope({
        tenantId: task.tenantId,
        initiatingActorId: task.ownerActorId,
        executingPrincipalType: "agent",
        executingPrincipalId: task.parentPrincipalId,
        delegationId: task.parentDelegationId,
        correlationId: `a2a-maintenance:${reservation.safetySha256}`,
        causationId: reservation.safetyId,
        purpose: "a2a.abandoned_task_reconciliation",
      });
      const terminalStatus = safetyStatusForTask(task.state);
      if (terminalStatus) {
        await touchExternalA2ASafety({
          tenantId: task.tenantId,
          ownerActorId: task.ownerActorId,
          internalTaskId: task.taskId,
          executionScope: scope,
          status: terminalStatus,
          now,
          reason: "canonical_task_already_terminal",
        });
        results.push({ internalTaskId: task.taskId, outcome: "already_terminal" });
        continue;
      }
      const deadlineExpired = Date.parse(now) >= Date.parse(task.completeBy);
      const next = await transitionDelegationTask({
        taskId: task.taskId,
        tenantId: task.tenantId,
        expectedRevision: task.lifecycleRevision,
        transition: deadlineExpired
          ? { to: "expired" }
          : {
              to: "canceled",
              initiator: "system",
              reason: "The external delegation stopped making progress within its safety lease.",
            },
        parentExecutionScope: scope,
        at: now,
      });
      const outcome = deadlineExpired ? "expired" : "canceled";
      await touchExternalA2ASafety({
        tenantId: next.tenantId,
        ownerActorId: next.ownerActorId,
        internalTaskId: next.taskId,
        executionScope: scope,
        status: outcome,
        now,
        reason: deadlineExpired ? "completion_deadline_expired" : "progress_timeout_expired",
      });
      results.push({ internalTaskId: next.taskId, outcome });
    } catch (error) {
      results.push({
        internalTaskId: safety.reservation.internalTaskId,
        outcome: "failed",
        reason: error instanceof Error ? error.message : "Unknown reconciliation failure.",
      });
    }
  }

  return {
    scanned: abandoned.length,
    expired: results.filter((item) => item.outcome === "expired").length,
    canceled: results.filter((item) => item.outcome === "canceled").length,
    alreadyTerminal: results.filter((item) => item.outcome === "already_terminal").length,
    failed: results.filter((item) => item.outcome === "failed").length,
    results,
  } as const;
}

function safetyStatusForTask(state: string): A2ASafetyStatus | undefined {
  if (["completed_proposed", "result_accepted"].includes(state)) return "completed";
  if (["challenged", "rejected"].includes(state)) return "challenged";
  if (state === "canceled") return "canceled";
  if (state === "expired") return "expired";
  return undefined;
}
