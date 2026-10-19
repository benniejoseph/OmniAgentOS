import { getSql, hasDatabaseUrl, runWithDatabaseActorScope } from "@/lib/db/client";
import { parentContinuationRunId } from "@/lib/delegation/parent-continuation-identity";

/** Read-only handoff for an already authorized owner run. A finished initial
 * turn does not mean its specialist-dependent work has finished. */
export async function readParentContinuationProgress(input: {
  tenantId: string; ownerActorId: string; canonicalActorId: string; runId: string; threadId: string;
}) {
  if (!hasDatabaseUrl()) return undefined;
  return runWithDatabaseActorScope(input.tenantId, [input.ownerActorId, input.canonicalActorId], async () => {
    const runId = parentContinuationRunId(input.runId);
    const rows = await getSql()`
      SELECT continuation.id AS run_id, job.status AS job_status,
        EXISTS (SELECT 1 FROM omni_events event WHERE event.tenant_id = parent.tenant_id
          AND event.stream_id = ${`run:${input.runId}`} AND event.type = 'delegation.parent_canceled') AS stopped
      FROM omni_agent_runs parent
      LEFT JOIN omni_agent_runs continuation ON continuation.tenant_id = parent.tenant_id
        AND continuation.id = ${runId} AND continuation.owner_actor_id = parent.owner_actor_id
        AND continuation.thread_id = parent.thread_id
      LEFT JOIN omni_operation_jobs job ON job.tenant_id = parent.tenant_id AND job.type = 'agent.execute'
        AND job.payload ->> 'kind' = 'delegation_parent_v1' AND job.payload ->> 'parentRunId' = parent.id
        AND job.payload ->> 'parentOwnerActorId' = parent.owner_actor_id
        AND job.payload ->> 'actorId' = ${input.canonicalActorId}
      WHERE parent.tenant_id = ${input.tenantId} AND parent.id = ${input.runId}
        AND parent.owner_actor_id = ${input.ownerActorId} AND parent.thread_id = ${input.threadId}
        AND EXISTS (SELECT 1 FROM omni_delegation_executions child WHERE child.tenant_id = parent.tenant_id
          AND child.parent_execution_id = parent.id AND child.owner_actor_id = ${input.canonicalActorId}
          AND child.contract -> 'conversationDelivery' ->> 'disposition' = 'resume_parent'
          AND child.contract -> 'conversationDelivery' ->> 'threadId' = parent.thread_id)
      LIMIT 1
    `;
    if (!rows[0]) return undefined;
    const row = rows[0];
    return { kind: "subagents" as const, threadId: input.threadId,
      runId: typeof row.run_id === "string" ? row.run_id : undefined,
      status: row.stopped || row.job_status === "canceled" ? "canceled" as const
        : ["failed", "quarantined"].includes(String(row.job_status)) ? "failed" as const : "accepted" as const };
  });
}
