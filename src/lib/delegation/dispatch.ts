import { runWithDatabaseActorScope } from "@/lib/db/client";
import { listDelegationExecutions } from "@/lib/delegation/execution-store";
import { processDelegationExecutionJob } from "@/lib/delegation/worker";
import { processParentContinuationJob } from "@/lib/delegation/parent-continuation";
import { getAgentRun } from "@/lib/runs/store";
import { getAgentExecuteJobDedupeKey, leaseOperationJobByDedupeKey } from "@/lib/operations/job-queue";

/** Latency hint after the admitted parent response. The durable queue remains
 * authoritative. Only this parent's due jobs are leased; no tenant tick runs. */
export async function dispatchParentDelegatedWork(input: {
  tenantId: string; ownerActorId: string; canonicalActorId: string; parentRunId: string; deadline: number;
}) {
  if (Date.now() >= input.deadline - 10_000) return;
  return runWithDatabaseActorScope(input.tenantId, [input.ownerActorId, input.canonicalActorId], async () => {
    const parent = await getAgentRun(input.parentRunId, { tenantId: input.tenantId });
    if (parent?.ownerActorId !== input.ownerActorId || parent.agentId !== "atlas" || parent.status !== "completed") return;
    const children = await listDelegationExecutions({ tenantId: input.tenantId, ownerActorId: input.canonicalActorId, parentExecutionId: parent.id, limit: 4 });
    const pending = children.filter(child => child.state === "queued");
    for (let i = 0; i < pending.length && Date.now() < input.deadline - 15_000; i += 2) {
      const results = await Promise.allSettled(pending.slice(i, i + 2).map(async child => {
        const lease = await leaseOperationJobByDedupeKey(getAgentExecuteJobDedupeKey(child.childRunId), {
          tenantId: input.tenantId, type: "agent.execute", leaseSeconds: 300, queuedOnly: true,
        });
        if (lease.outcome === "leased") await processDelegationExecutionJob(lease.job, Math.min(input.deadline, Date.now() + 240_000));
      }));
      for (const result of results) if (result.status === "rejected") console.warn("Immediate child dispatch interrupted; durable recovery retains its lease.",
        result.reason instanceof Error ? result.reason.name : "UnknownError");
    }
    if (!children.length || Date.now() >= input.deadline - 15_000) return;
    const lease = await leaseOperationJobByDedupeKey(`delegation-parent:${parent.id}`, {
      tenantId: input.tenantId, type: "agent.execute", leaseSeconds: 300, queuedOnly: true,
    });
    if (lease.outcome === "leased") await processParentContinuationJob(lease.job, Math.min(input.deadline, Date.now() + 240_000));
  });
}
