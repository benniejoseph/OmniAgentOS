import { appendScopedDomainEvent } from "@/lib/events/store";
import { getAgentRun, cancelAgentRun } from "@/lib/runs/store";
import { cancelOperationJobByDedupeKey, getAgentResumeJobDedupeKey } from "@/lib/operations/job-queue";
import { cancelDelegationExecution, listDelegationExecutions } from "@/lib/delegation/execution-store";
import { parentContinuationRunId } from "@/lib/delegation/parent-continuation-identity";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

/** Called only after the application's governed owner/run cancellation check.
 * A stopped parent keeps its historical answer; its pending descendants stop. */
export async function cancelParentDependentWork(input: {
  tenantId: string; actorId: string; parentRunId: string; reason: string;
  executionScope: ExecutionScope; idempotencyKey: string;
}): Promise<{ canceledJobs: number; unresolved: string[] }> {
  const { tenantId, actorId, parentRunId, reason } = input;
  await appendScopedDomainEvent({ id: `parent-stop:${canonicalJsonSha256({ parentRunId, key: input.idempotencyKey })}`, streamId: `run:${parentRunId}`,
    type: "delegation.parent_canceled", executionScope: input.executionScope,
    payload: { parentRunId, dependentWorkStopped: true } });
  const jobs = await cancelOperationJobByDedupeKey(`delegation-parent:${parentRunId}`, reason, { tenantId });
  const children = await listDelegationExecutions({ tenantId, ownerActorId: actorId, parentExecutionId: parentRunId, limit: 100 });
  const unresolved: string[] = [];
  for (const child of children.filter(child => ["queued", "running", "waiting"].includes(child.state))) {
    const scope = createExecutionScope({ ...input.executionScope, initiatingActorId: actorId,
      // Retain the actual caller's principal. Owner controls are normalized to
      // the server-resolved canonical identity, never minted from model input.
      executingPrincipalId: input.executionScope.executingPrincipalType === "user" ? actorId : input.executionScope.executingPrincipalId });
    try {
      await cancelDelegationExecution({ tenantId, ownerActorId: actorId, executionId: child.executionId,
        expectedRevision: child.lifecycleRevision, executionScope: scope,
        requestSha256: canonicalJsonSha256({ parentRunId, executionId: child.executionId, reason }),
        idempotencyKeySha256: canonicalJsonSha256({ key: input.idempotencyKey, executionId: child.executionId }) });
    } catch {
      // A child can finish between enumeration and its compare-and-swap.
      // Its result may remain, but the parent stop marker still suppresses follow-through.
      unresolved.push(child.executionId);
    }
  }
  const continuation = await getAgentRun(parentContinuationRunId(parentRunId), { tenantId });
  if (continuation) {
    if (!["completed", "failed", "canceled"].includes(continuation.status)) await cancelAgentRun(continuation.id, reason, { tenantId });
    if (continuation.continuation) jobs.push(...await cancelOperationJobByDedupeKey(
      getAgentResumeJobDedupeKey(continuation.continuation.pendingToolCall.executionId), reason, { tenantId }));
    // Propagate through later generations, bounded by the original delegation budget.
    const descendants = await cancelParentDependentWork({ ...input, parentRunId: continuation.id });
    return { canceledJobs: jobs.length + descendants.canceledJobs, unresolved: [...unresolved, ...descendants.unresolved] };
  }
  return { canceledJobs: jobs.length, unresolved };
}
