import { createHash } from "node:crypto";
import { getSql } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  assertExecutionScopeTenant,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

type RunContextSqlClient = ReturnType<typeof getSql>;

export type RunContextInvalidationSourceKind =
  | "memory"
  | "knowledge"
  | "capture";

export type RunContextInvalidationResult = Readonly<{
  agentRunIds: readonly string[];
  workflowRunIds: readonly string[];
}>;

/**
 * Permanently stops non-terminal runs whose persisted context trace contains
 * material being deleted. The caller must already hold the tenant memory-graph
 * lock and pass the deletion transaction client.
 */
export async function invalidateRunsForDeletedContext(input: {
  tenantId: string;
  retrievalTraceIds: readonly string[];
  executionScope: ExecutionScope;
  sourceKind: RunContextInvalidationSourceKind;
  sourceReference: string;
  sql: RunContextSqlClient;
}): Promise<RunContextInvalidationResult> {
  assertExecutionScopeTenant(input.executionScope, input.tenantId);
  const retrievalTraceIds = canonicalIds(input.retrievalTraceIds);
  if (!retrievalTraceIds.length) {
    return { agentRunIds: [], workflowRunIds: [] };
  }
  const sourceReferenceSha256 = digest({
    tenantId: input.tenantId,
    sourceKind: input.sourceKind,
    sourceReference: input.sourceReference,
  });
  const invalidatedAt = new Date().toISOString();
  const reason = "Context invalidated because retrieved source material was deleted.";

  const agentRows = await input.sql`
    UPDATE omni_agent_runs run
    SET status = 'canceled',
        response = NULL,
        grounding = NULL,
        error = ${reason},
        continuation = NULL,
        completed_at = ${invalidatedAt}
    WHERE run.tenant_id = ${input.tenantId}
      AND run.status IN ('running', 'waiting_approval', 'resuming')
      AND EXISTS (
        SELECT 1
        FROM omni_agent_events event
        WHERE event.tenant_id = run.tenant_id
          AND event.run_id = run.id
          AND event.type = 'harness'
          AND event.payload ->> 'contextTraceId' = ANY(${retrievalTraceIds}::text[])
      )
    RETURNING run.id
  `;
  const workflowRows = await input.sql`
    UPDATE omni_workflow_runs run
    SET status = 'canceled',
        canceled_at = ${invalidatedAt},
        error = ${reason},
        updated_at = ${invalidatedAt},
        completed_at = ${invalidatedAt}
    WHERE run.tenant_id = ${input.tenantId}
      AND run.status IN ('queued', 'running', 'waiting_approval', 'paused')
      AND EXISTS (
        SELECT 1
        FROM omni_workflow_plans plan
        WHERE plan.tenant_id = run.tenant_id
          AND plan.workflow_run_id = run.id
          AND plan.context_trace_id = ANY(${retrievalTraceIds}::text[])
      )
    RETURNING run.id
  `;

  const agentRunIds = canonicalIds(agentRows.map((row) => String(row.id)));
  const workflowRunIds = canonicalIds(
    workflowRows.map((row) => String(row.id)),
  );
  const payload = {
    schemaVersion: 1,
    reasonCode: "retrieved_context_deleted",
    sourceKind: input.sourceKind,
    sourceReferenceSha256,
    retrievalTraceCount: retrievalTraceIds.length,
    invalidatedAt,
  } as const;

  for (const runId of agentRunIds) {
    const eventId = invalidationEventId("agent", runId, sourceReferenceSha256);
    await input.sql`
      INSERT INTO omni_agent_events (
        id, tenant_id, run_id, type, payload, created_at
      )
      VALUES (
        ${eventId}, ${input.tenantId}, ${runId}, ${"context_invalidated"},
        ${payload}::jsonb, ${invalidatedAt}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await appendScopedDomainEvent({
      id: `run_domain:${eventId}`,
      streamId: `run:${runId}`,
      type: "run.context_invalidated",
      executionScope: input.executionScope,
      payload,
    }, { sql: input.sql });
  }

  for (const runId of workflowRunIds) {
    const eventId = invalidationEventId(
      "workflow",
      runId,
      sourceReferenceSha256,
    );
    await input.sql`
      INSERT INTO omni_workflow_events (
        id, tenant_id, workflow_run_id, type, payload, created_at
      )
      VALUES (
        ${eventId}, ${input.tenantId}, ${runId},
        ${"workflow.context_invalidated"}, ${payload}::jsonb,
        ${invalidatedAt}
      )
      ON CONFLICT (id) DO NOTHING
    `;
    await appendScopedDomainEvent({
      id: `workflow_domain:${eventId}`,
      streamId: `workflow:${runId}`,
      type: "workflow.context_invalidated",
      executionScope: input.executionScope,
      payload,
    }, { sql: input.sql });
  }

  return { agentRunIds, workflowRunIds };
}

function canonicalIds(values: readonly string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, 2_000);
}

function invalidationEventId(
  runKind: "agent" | "workflow",
  runId: string,
  sourceReferenceSha256: string,
) {
  return `context_invalidation_${runKind}_${digest({
    runId,
    sourceReferenceSha256,
  }).slice(0, 48)}`;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
