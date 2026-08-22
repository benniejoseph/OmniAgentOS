import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { rebuildMemoryGraph } from "@/lib/memory/graph";
import { getAccessRequestStore } from "@/lib/onboarding/access-request-store";

export type RetentionPolicy = {
  pendingApprovalDays: number;
  pendingAccessRequestDays: number;
  reviewedAccessRequestDays: number;
  episodeMemoryDays: number;
  consolidatedMemoryDays: number;
  retrievalTraceDays: number;
  workflowDays: number;
  triggerEventDays: number;
  operationJobDays: number;
  runContentDays: number;
  toolPayloadDays: number;
  domainEventDays: number;
  observabilityDays: number;
  securityAuditDays: number;
};

export type RetentionSweepResult = {
  backend: "postgres" | "bounded_local";
  scope: "all_tenants" | "tenant";
  tenantId?: string;
  policy: RetentionPolicy;
  deleted: {
    expiredApprovalRuns: number;
    expiredToolApprovals: number;
    expiredAccessRequests: number;
    accessRequests: number;
    authSessions: number;
    memoryGraphEdges: number;
    memoryGraphNodes: number;
    memories: number;
    retrievalTraces: number;
    workflowPlans: number;
    workflows: number;
    triggerEvents: number;
    operationJobs: number;
    runs: number;
    toolExecutions: number;
    domainEvents: number;
    observabilityEvents: number;
    securityAudits: number;
  };
  batchLimit: number;
  moreAvailable: boolean;
  completedAt: string;
};

export function getRetentionPolicy(): RetentionPolicy {
  return {
    pendingApprovalDays: retentionDays("OMNIAGENT_RETENTION_PENDING_APPROVAL_DAYS", 7),
    pendingAccessRequestDays: retentionDays("OMNIAGENT_RETENTION_PENDING_ACCESS_DAYS", 30),
    reviewedAccessRequestDays: retentionDays("OMNIAGENT_RETENTION_REVIEWED_ACCESS_DAYS", 365),
    episodeMemoryDays: retentionDays("OMNIAGENT_RETENTION_EPISODE_MEMORY_DAYS", 30),
    consolidatedMemoryDays: retentionDays("OMNIAGENT_RETENTION_CONSOLIDATED_MEMORY_DAYS", 365),
    retrievalTraceDays: retentionDays("OMNIAGENT_RETENTION_RETRIEVAL_TRACE_DAYS", 30),
    workflowDays: retentionDays("OMNIAGENT_RETENTION_WORKFLOW_DAYS", 90),
    triggerEventDays: retentionDays("OMNIAGENT_RETENTION_TRIGGER_EVENT_DAYS", 90),
    operationJobDays: retentionDays("OMNIAGENT_RETENTION_OPERATION_JOB_DAYS", 90),
    runContentDays: retentionDays("OMNIAGENT_RETENTION_RUN_DAYS", 30),
    toolPayloadDays: retentionDays("OMNIAGENT_RETENTION_TOOL_DAYS", 90),
    domainEventDays: retentionDays("OMNIAGENT_RETENTION_EVENT_DAYS", 90),
    observabilityDays: retentionDays("OMNIAGENT_RETENTION_OBSERVABILITY_DAYS", 30),
    securityAuditDays: retentionDays("OMNIAGENT_RETENTION_SECURITY_DAYS", 365),
  };
}

export async function sweepExpiredSensitiveData(input: {
  tenantId: string;
  allTenants?: boolean;
}): Promise<RetentionSweepResult> {
  const policy = getRetentionPolicy();
  const scope = input.allTenants ? "all_tenants" : "tenant";
  if (!hasDatabaseUrl()) {
    const accessRequests = await getAccessRequestStore().sweepRetention({
      pendingBefore: cutoff(policy.pendingAccessRequestDays),
      reviewedBefore: cutoff(policy.reviewedAccessRequestDays),
      tenantId: input.allTenants ? undefined : input.tenantId,
    });
    const deleted = emptyDeletedCounts();
    deleted.expiredAccessRequests = accessRequests.expired;
    deleted.accessRequests = accessRequests.deleted;
    return {
      backend: "bounded_local",
      scope,
      tenantId: input.allTenants ? undefined : input.tenantId,
      policy,
      deleted,
      batchLimit: 0,
      moreAvailable: false,
      completedAt: new Date().toISOString(),
    };
  }

  await ensureDatabaseSchema();
  const sweep = () => sweepPostgres(policy, input.allTenants ? undefined : input.tenantId);
  const result = input.allTenants
    ? await runWithDatabaseSystemScope("scheduled sensitive-data retention sweep", sweep)
    : await runWithDatabaseTenantScope(input.tenantId, sweep);

  return {
    backend: "postgres",
    scope,
    tenantId: input.allTenants ? undefined : input.tenantId,
    policy,
    deleted: result.deleted,
    batchLimit: result.batchLimit,
    moreAvailable: result.moreAvailable,
    completedAt: new Date().toISOString(),
  };
}

async function sweepPostgres(policy: RetentionPolicy, tenantId?: string) {
  const sql = getSql();
  const batchLimit = retentionBatchSize();
  const pendingCutoff = cutoff(policy.pendingApprovalDays);
  const pendingAccessCutoff = cutoff(policy.pendingAccessRequestDays);
  const reviewedAccessCutoff = cutoff(policy.reviewedAccessRequestDays);
  const episodeMemoryCutoff = cutoff(policy.episodeMemoryDays);
  const consolidatedMemoryCutoff = cutoff(policy.consolidatedMemoryDays);
  const retrievalTraceCutoff = cutoff(policy.retrievalTraceDays);
  const workflowCutoff = cutoff(policy.workflowDays);
  const triggerEventCutoff = cutoff(policy.triggerEventDays);
  const operationJobCutoff = cutoff(policy.operationJobDays);
  const runCutoff = cutoff(policy.runContentDays);
  const toolCutoff = cutoff(policy.toolPayloadDays);
  const eventCutoff = cutoff(policy.domainEventDays);
  const observabilityCutoff = cutoff(policy.observabilityDays);
  const securityCutoff = cutoff(policy.securityAuditDays);

  const result = await sql.transaction(async (transaction: ReturnType<typeof getSql>) => {
    const affectedMemoryTenants = tenantId
      ? await transaction`
          SELECT DISTINCT tenant_id
          FROM (
            (
              SELECT tenant_id
              FROM omni_memories
              WHERE tenant_id = ${tenantId}
                AND (
                  (source = 'agent' AND updated_at < ${episodeMemoryCutoff}::timestamptz)
                  OR
                  (source = 'consolidator' AND updated_at < ${consolidatedMemoryCutoff}::timestamptz)
                )
              ORDER BY updated_at ASC
              LIMIT ${batchLimit}
            )
            UNION ALL
            (
              SELECT tenant_id
              FROM omni_retrieval_traces
              WHERE tenant_id = ${tenantId}
                AND created_at < ${retrievalTraceCutoff}::timestamptz
              ORDER BY created_at ASC
              LIMIT ${batchLimit}
            )
          ) expired_memory_tenants
        `
      : await transaction`
          SELECT DISTINCT tenant_id
          FROM (
            (
              SELECT tenant_id
              FROM omni_memories
              WHERE (source = 'agent' AND updated_at < ${episodeMemoryCutoff}::timestamptz)
                 OR (source = 'consolidator' AND updated_at < ${consolidatedMemoryCutoff}::timestamptz)
              ORDER BY updated_at ASC
              LIMIT ${batchLimit}
            )
            UNION ALL
            (
              SELECT tenant_id
              FROM omni_retrieval_traces
              WHERE created_at < ${retrievalTraceCutoff}::timestamptz
              ORDER BY created_at ASC
              LIMIT ${batchLimit}
            )
          ) expired_memory_tenants
        `;
    const affectedMemoryTenantIds = affectedMemoryTenants.map((row) =>
      String(row.tenant_id)
    );
    if (affectedMemoryTenantIds.length) {
      await transaction`
        INSERT INTO omni_memory_graph_rebuild_queue (
          tenant_id, requested_at, attempts, last_error, updated_at, generation
        )
        SELECT pending.tenant_id, NOW(), 0, NULL, NOW(), 1
        FROM unnest(${affectedMemoryTenantIds}::text[]) AS pending(tenant_id)
        ON CONFLICT (tenant_id) DO UPDATE SET
          requested_at = EXCLUDED.requested_at,
          attempts = 0,
          last_error = NULL,
          updated_at = NOW(),
          generation = omni_memory_graph_rebuild_queue.generation + 1
      `;
    }
    const memoryGraphEdges = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_memory_graph_edges
            WHERE tenant_id = ${tenantId}
              AND ${affectedMemoryTenants.length > 0}
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_memory_graph_edges target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_memory_graph_edges
            WHERE tenant_id = ANY(${affectedMemoryTenantIds}::text[])
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_memory_graph_edges target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const memoryGraphNodes = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_memory_graph_nodes
            WHERE tenant_id = ${tenantId}
              AND ${affectedMemoryTenants.length > 0}
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_memory_graph_nodes target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_memory_graph_nodes
            WHERE tenant_id = ANY(${affectedMemoryTenantIds}::text[])
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_memory_graph_nodes target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const retrievalTraces = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_retrieval_traces
            WHERE tenant_id = ${tenantId}
              AND created_at < ${retrievalTraceCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_retrieval_traces target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_retrieval_traces
            WHERE created_at < ${retrievalTraceCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_retrieval_traces target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const memories = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_memories
            WHERE tenant_id = ${tenantId}
              AND (
                (source = 'agent' AND updated_at < ${episodeMemoryCutoff}::timestamptz)
                OR
                (source = 'consolidator' AND updated_at < ${consolidatedMemoryCutoff}::timestamptz)
              )
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_memories target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_memories
            WHERE (source = 'agent' AND updated_at < ${episodeMemoryCutoff}::timestamptz)
               OR (source = 'consolidator' AND updated_at < ${consolidatedMemoryCutoff}::timestamptz)
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_memories target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const expiredAccessRequests = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_access_requests
            WHERE tenant_id = ${tenantId}
              AND status = 'pending_review'
              AND created_at < ${pendingAccessCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          UPDATE omni_access_requests target
          SET status = 'declined',
              name = '[expired]',
              email = 'expired+' || target.id || '@invalid',
              company = '[expired]',
              role = 'other',
              use_case = '[expired by retention policy]',
              timeline = 'research',
              reviewed_by = 'retention',
              review_note = 'Expired before administrator review.',
              reviewed_at = NOW(),
              updated_at = NOW()
          FROM expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_access_requests
            WHERE status = 'pending_review'
              AND created_at < ${pendingAccessCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          UPDATE omni_access_requests target
          SET status = 'declined',
              name = '[expired]',
              email = 'expired+' || target.id || '@invalid',
              company = '[expired]',
              role = 'other',
              use_case = '[expired by retention policy]',
              timeline = 'research',
              reviewed_by = 'retention',
              review_note = 'Expired before administrator review.',
              reviewed_at = NOW(),
              updated_at = NOW()
          FROM expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const accessRequests = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_access_requests
            WHERE tenant_id = ${tenantId}
              AND status IN (
                'approved',
                'provisioning_pending',
                'provisioned',
                'declined'
              )
              AND updated_at < ${reviewedAccessCutoff}::timestamptz
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_access_requests target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_access_requests
            WHERE status IN (
              'approved',
              'provisioning_pending',
              'provisioned',
              'declined'
            )
              AND updated_at < ${reviewedAccessCutoff}::timestamptz
            ORDER BY updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_access_requests target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const authSessions = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_auth_sessions
            WHERE tenant_id = ${tenantId}
              AND expires_at < NOW()
            ORDER BY expires_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_auth_sessions target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_auth_sessions
            WHERE expires_at < NOW()
            ORDER BY expires_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_auth_sessions target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const expiredToolApprovals = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_tool_executions
            WHERE tenant_id = ${tenantId}
              AND status = 'approval_required'
              AND created_at < ${pendingCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          UPDATE omni_tool_executions target
          SET status = 'rejected',
              input = '{"redacted":"expired approval"}'::jsonb,
              output = NULL,
              reason = 'Approval expired before an operator decision.',
              approval_decision = 'rejected',
              approval_reason = 'Expired by retention policy.',
              completed_at = NOW()
          FROM expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_tool_executions
            WHERE status = 'approval_required'
              AND created_at < ${pendingCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          UPDATE omni_tool_executions target
          SET status = 'rejected',
              input = '{"redacted":"expired approval"}'::jsonb,
              output = NULL,
              reason = 'Approval expired before an operator decision.',
              approval_decision = 'rejected',
              approval_reason = 'Expired by retention policy.',
              completed_at = NOW()
          FROM expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const expiredApprovalRuns = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT run.ctid
            FROM omni_agent_runs run
            WHERE run.tenant_id = ${tenantId}
              AND run.status = 'waiting_approval'
              AND EXISTS (
                SELECT 1
                FROM omni_tool_executions tool
                WHERE tool.id = run.continuation->'pendingToolCall'->>'executionId'
                  AND tool.tenant_id = ${tenantId}
                  AND tool.status = 'rejected'
                  AND tool.approval_reason = 'Expired by retention policy.'
              )
            ORDER BY run.started_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          UPDATE omni_agent_runs target
          SET status = 'failed',
              prompt = '[expired approval]',
              messages = '[]'::jsonb,
              response = NULL,
              continuation = NULL,
              error = 'Approval expired before an operator decision.',
              completed_at = NOW()
          FROM expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT run.ctid
            FROM omni_agent_runs run
            WHERE run.status = 'waiting_approval'
              AND EXISTS (
                SELECT 1
                FROM omni_tool_executions tool
                WHERE tool.id = run.continuation->'pendingToolCall'->>'executionId'
                  AND tool.status = 'rejected'
                  AND tool.approval_reason = 'Expired by retention policy.'
              )
            ORDER BY run.started_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          UPDATE omni_agent_runs target
          SET status = 'failed',
              prompt = '[expired approval]',
              messages = '[]'::jsonb,
              response = NULL,
              continuation = NULL,
              error = 'Approval expired before an operator decision.',
              completed_at = NOW()
          FROM expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const workflowPlans = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT plan.ctid
            FROM omni_workflow_plans plan
            WHERE plan.tenant_id = ${tenantId}
              AND plan.updated_at < ${workflowCutoff}::timestamptz
              AND (
                plan.workflow_run_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM omni_workflow_runs run
                  WHERE run.id = plan.workflow_run_id
                    AND run.status IN ('completed', 'failed', 'canceled')
                    AND COALESCE(run.completed_at, run.updated_at) < ${workflowCutoff}::timestamptz
                )
              )
            ORDER BY plan.updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_workflow_plans target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT plan.ctid
            FROM omni_workflow_plans plan
            WHERE plan.updated_at < ${workflowCutoff}::timestamptz
              AND (
                plan.workflow_run_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM omni_workflow_runs run
                  WHERE run.id = plan.workflow_run_id
                    AND run.status IN ('completed', 'failed', 'canceled')
                    AND COALESCE(run.completed_at, run.updated_at) < ${workflowCutoff}::timestamptz
                )
              )
            ORDER BY plan.updated_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_workflow_plans target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const workflows = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT run.ctid
            FROM omni_workflow_runs run
            WHERE run.tenant_id = ${tenantId}
              AND run.status IN ('completed', 'failed', 'canceled')
              AND COALESCE(run.completed_at, run.updated_at) < ${workflowCutoff}::timestamptz
              AND NOT EXISTS (
                SELECT 1
                FROM omni_workflow_plans plan
                WHERE plan.workflow_run_id = run.id
              )
            ORDER BY COALESCE(run.completed_at, run.updated_at) ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_workflow_runs target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT run.ctid
            FROM omni_workflow_runs run
            WHERE run.status IN ('completed', 'failed', 'canceled')
              AND COALESCE(run.completed_at, run.updated_at) < ${workflowCutoff}::timestamptz
              AND NOT EXISTS (
                SELECT 1
                FROM omni_workflow_plans plan
                WHERE plan.workflow_run_id = run.id
              )
            ORDER BY COALESCE(run.completed_at, run.updated_at) ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_workflow_runs target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const triggerEvents = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_workflow_trigger_events
            WHERE tenant_id = ${tenantId}
              AND received_at < ${triggerEventCutoff}::timestamptz
            ORDER BY received_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_workflow_trigger_events target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_workflow_trigger_events
            WHERE received_at < ${triggerEventCutoff}::timestamptz
            ORDER BY received_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_workflow_trigger_events target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const operationJobs = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_operation_jobs
            WHERE tenant_id = ${tenantId}
              AND status IN ('completed', 'failed', 'canceled')
              AND COALESCE(completed_at, updated_at) < ${operationJobCutoff}::timestamptz
            ORDER BY COALESCE(completed_at, updated_at) ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_operation_jobs target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_operation_jobs
            WHERE status IN ('completed', 'failed', 'canceled')
              AND COALESCE(completed_at, updated_at) < ${operationJobCutoff}::timestamptz
            ORDER BY COALESCE(completed_at, updated_at) ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_operation_jobs target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const runs = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_agent_runs
            WHERE tenant_id = ${tenantId}
              AND status IN ('completed', 'failed', 'canceled')
              AND completed_at < ${runCutoff}::timestamptz
            ORDER BY completed_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_agent_runs target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_agent_runs
            WHERE status IN ('completed', 'failed', 'canceled')
              AND completed_at < ${runCutoff}::timestamptz
            ORDER BY completed_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_agent_runs target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const toolExecutions = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_tool_executions
            WHERE tenant_id = ${tenantId}
              AND status IN ('dry_run', 'executed', 'blocked', 'failed', 'rejected')
              AND COALESCE(completed_at, created_at) < ${toolCutoff}::timestamptz
            ORDER BY COALESCE(completed_at, created_at) ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_tool_executions target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_tool_executions
            WHERE status IN ('dry_run', 'executed', 'blocked', 'failed', 'rejected')
              AND COALESCE(completed_at, created_at) < ${toolCutoff}::timestamptz
            ORDER BY COALESCE(completed_at, created_at) ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_tool_executions target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const domainEvents = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_events
            WHERE tenant_id = ${tenantId}
              AND at < ${eventCutoff}::timestamptz
            ORDER BY at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_events target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_events
            WHERE at < ${eventCutoff}::timestamptz
            ORDER BY at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_events target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const observabilityEvents = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_observability_events
            WHERE tenant_id = ${tenantId}
              AND created_at < ${observabilityCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_observability_events target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_observability_events
            WHERE created_at < ${observabilityCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_observability_events target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;
    const securityAudits = tenantId
      ? await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_security_audits
            WHERE tenant_id = ${tenantId}
              AND created_at < ${securityCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_security_audits target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `
      : await transaction`
          WITH expired AS (
            SELECT ctid
            FROM omni_security_audits
            WHERE created_at < ${securityCutoff}::timestamptz
            ORDER BY created_at ASC
            FOR UPDATE SKIP LOCKED
            LIMIT ${batchLimit}
          )
          DELETE FROM omni_security_audits target
          USING expired
          WHERE target.ctid = expired.ctid
          RETURNING target.id
        `;

    return {
      affectedMemoryTenantIds,
      deleted: {
        expiredApprovalRuns: expiredApprovalRuns.length,
        expiredToolApprovals: expiredToolApprovals.length,
        expiredAccessRequests: expiredAccessRequests.length,
        accessRequests: accessRequests.length,
        authSessions: authSessions.length,
        memoryGraphEdges: memoryGraphEdges.length,
        memoryGraphNodes: memoryGraphNodes.length,
        memories: memories.length,
        retrievalTraces: retrievalTraces.length,
        workflowPlans: workflowPlans.length,
        workflows: workflows.length,
        triggerEvents: triggerEvents.length,
        operationJobs: operationJobs.length,
        runs: runs.length,
        toolExecutions: toolExecutions.length,
        domainEvents: domainEvents.length,
        observabilityEvents: observabilityEvents.length,
        securityAudits: securityAudits.length,
      },
    };
  }) as {
    affectedMemoryTenantIds: string[];
    deleted: RetentionSweepResult["deleted"];
  };

  await processPendingMemoryGraphRebuilds({
    tenantIds: result.affectedMemoryTenantIds,
    limit: Math.max(result.affectedMemoryTenantIds.length, 1),
  });
  return {
    deleted: result.deleted,
    batchLimit,
    moreAvailable: Object.values(result.deleted).some(
      (count) => count >= batchLimit,
    ),
  };
}

export async function processPendingMemoryGraphRebuilds({
  tenantIds,
  limit = 10,
}: {
  tenantIds?: string[];
  limit?: number;
} = {}) {
  if (!hasDatabaseUrl()) {
    return { processed: 0, completed: 0, failed: 0, pendingTenantIds: [] };
  }
  await ensureDatabaseSchema();
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const claims = await claimPendingMemoryGraphRebuilds({
    tenantIds,
    limit: boundedLimit,
  });
  const pendingTenantIds = claims.map((claim) => claim.tenantId);
  let completed = 0;
  let failed = 0;

  for (const claim of claims) {
    const pendingTenantId = claim.tenantId;
    try {
      await rebuildMemoryGraph({
        tenantId: pendingTenantId,
        source: "retention-rebuild",
      });
      await runWithDatabaseTenantScope(pendingTenantId, async () => {
        const deleted = await getSql()`
          DELETE FROM omni_memory_graph_rebuild_queue
          WHERE tenant_id = ${pendingTenantId}
            AND generation = ${claim.generation}::bigint
          RETURNING tenant_id
        `;
        if (!deleted[0]) {
          await getSql()`
            UPDATE omni_memory_graph_rebuild_queue
            SET lease_owner = NULL,
                lease_expires_at = NULL,
                updated_at = NOW()
            WHERE tenant_id = ${pendingTenantId}
              AND lease_owner = ${claim.leaseOwner}
          `;
        }
      });
      completed += 1;
    } catch (error) {
      failed += 1;
      const message = (
        error instanceof Error
          ? error.message
          : "Memory graph rebuild failed."
      ).slice(0, 1000);
      await runWithDatabaseTenantScope(pendingTenantId, () =>
        getSql()`
          UPDATE omni_memory_graph_rebuild_queue
          SET attempts = CASE
                WHEN generation = ${claim.generation}::bigint
                THEN attempts + 1
                ELSE 0
              END,
              last_error = CASE
                WHEN generation = ${claim.generation}::bigint
                THEN ${message}
                ELSE NULL
              END,
              lease_owner = NULL,
              lease_expires_at = NULL,
              updated_at = NOW()
          WHERE tenant_id = ${pendingTenantId}
            AND lease_owner = ${claim.leaseOwner}
        `,
      ).catch(() => undefined);
    }
  }

  return {
    processed: pendingTenantIds.length,
    completed,
    failed,
    pendingTenantIds,
  };
}

type MemoryGraphRebuildClaim = {
  tenantId: string;
  generation: string;
  leaseOwner: string;
};

async function claimPendingMemoryGraphRebuilds({
  tenantIds,
  limit,
}: {
  tenantIds?: string[];
  limit: number;
}): Promise<MemoryGraphRebuildClaim[]> {
  const leaseOwner = randomUUID();
  const requestedTenantIds = [
    ...new Set(
      (tenantIds || [])
        .map((tenantId) => tenantId.trim())
        .filter(Boolean),
    ),
  ].slice(0, limit);
  if (tenantIds && !requestedTenantIds.length) {
    return [];
  }

  return runWithDatabaseSystemScope(
    "Lease durable memory-graph rebuild requests.",
    () =>
      getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const rows = requestedTenantIds.length
          ? await sql`
              WITH candidates AS (
                SELECT tenant_id
                FROM omni_memory_graph_rebuild_queue
                WHERE tenant_id = ANY(${requestedTenantIds}::text[])
                  AND (
                    lease_expires_at IS NULL
                    OR lease_expires_at <= NOW()
                  )
                ORDER BY attempts ASC, updated_at ASC, requested_at ASC, tenant_id ASC
                FOR UPDATE SKIP LOCKED
                LIMIT ${limit}
              )
              UPDATE omni_memory_graph_rebuild_queue queue
              SET lease_owner = ${leaseOwner},
                  lease_expires_at = NOW() + (900 * INTERVAL '1 second'),
                  updated_at = NOW()
              FROM candidates
              WHERE queue.tenant_id = candidates.tenant_id
              RETURNING queue.tenant_id, queue.generation
            `
          : await sql`
              WITH candidates AS (
                SELECT tenant_id
                FROM omni_memory_graph_rebuild_queue
                WHERE lease_expires_at IS NULL
                   OR lease_expires_at <= NOW()
                ORDER BY attempts ASC, updated_at ASC, requested_at ASC, tenant_id ASC
                FOR UPDATE SKIP LOCKED
                LIMIT ${limit}
              )
              UPDATE omni_memory_graph_rebuild_queue queue
              SET lease_owner = ${leaseOwner},
                  lease_expires_at = NOW() + (900 * INTERVAL '1 second'),
                  updated_at = NOW()
              FROM candidates
              WHERE queue.tenant_id = candidates.tenant_id
              RETURNING queue.tenant_id, queue.generation
            `;
        return rows.map((row) => ({
          tenantId: String(row.tenant_id),
          generation: String(row.generation),
          leaseOwner,
        }));
      }) as Promise<MemoryGraphRebuildClaim[]>,
  );
}

function retentionDays(name: string, fallback: number) {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3_650
    ? parsed
    : fallback;
}

function retentionBatchSize() {
  const parsed = Number(process.env.OMNIAGENT_RETENTION_BATCH_SIZE);
  return Number.isInteger(parsed)
    ? Math.min(Math.max(parsed, 100), 5_000)
    : 500;
}

function cutoff(days: number) {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

function emptyDeletedCounts(): RetentionSweepResult["deleted"] {
  return {
    expiredApprovalRuns: 0,
    expiredToolApprovals: 0,
    expiredAccessRequests: 0,
    accessRequests: 0,
    authSessions: 0,
    memoryGraphEdges: 0,
    memoryGraphNodes: 0,
    memories: 0,
    retrievalTraces: 0,
    workflowPlans: 0,
    workflows: 0,
    triggerEvents: 0,
    operationJobs: 0,
    runs: 0,
    toolExecutions: 0,
    domainEvents: 0,
    observabilityEvents: 0,
    securityAudits: 0,
  };
}
