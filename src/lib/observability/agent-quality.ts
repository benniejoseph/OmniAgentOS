import { getSql, hasDatabaseUrl } from "@/lib/db/client";
import {
  AGENT_FIRST_OUTPUT_ACTION,
  recordRuntimeEventSafely,
} from "@/lib/observability/store";
import type { AgentEvent } from "@/lib/orchestration/types";

/**
 * How a tenant's agents did over a window, from the runs, tool calls, usage
 * and approvals the database keeps.
 */
export type AgentQualityStats = {
  /** Runs that completed or failed in the window; canceled runs are left out. */
  runs: { finished: number; completed: number; successRate: number; costPerRunUsd: number };
  /** Tool calls that ran to an outcome in the window. */
  tools: { finished: number; failed: number; failureRate: number };
  /** Tool approvals an operator approved or rejected in the window. */
  approvals: { decided: number; latencyP95Ms: number };
};

/**
 * Watches one request's agent events and records, once, how long after the
 * request arrived the first text of its reply was ready to stream.
 */
export function firstOutputTimer({
  tenantId,
  actorId,
  correlationId,
  receivedAtMs,
  now = Date.now,
}: {
  tenantId: string;
  actorId: string;
  correlationId: string;
  receivedAtMs: number;
  now?: () => number;
}) {
  let recording: Promise<unknown> | undefined;
  return {
    observe(event: AgentEvent) {
      if (recording || event.type !== "delta" || !event.text) return;
      recording = recordRuntimeEventSafely({
        category: "api",
        action: AGENT_FIRST_OUTPUT_ACTION,
        route: "/api/agent",
        method: "POST",
        tenantId,
        actorId,
        correlationId,
        durationMs: Math.max(0, now() - receivedAtMs),
        message: "Streamed the first text of an agent reply.",
        // Measured by its own SLO, not as a request.
        metadata: { sloExcluded: true },
      });
    },
    /** Settles once the time is recorded, or at once if none was taken. */
    settled: () => recording ?? Promise.resolve(),
  };
}

/**
 * Reads a tenant's agent quality since a time. Only the database keeps the
 * records it needs; without one, every count is zero.
 */
export async function getAgentQualityStats({
  tenantId,
  since,
  sql,
}: {
  tenantId: string;
  since: Date;
  sql?: ReturnType<typeof getSql>;
}): Promise<AgentQualityStats> {
  if (!hasDatabaseUrl()) {
    return agentQualityFromRow({});
  }
  const rows = await (sql || getSql()).query(
    `
      WITH finished_runs AS (
        SELECT id, status
        FROM omni_agent_runs
        WHERE tenant_id = $1
          AND status IN ('completed', 'failed')
          AND completed_at >= $2
      ),
      run_costs AS (
        SELECT finished_runs.id,
          COALESCE(SUM(usage.estimated_cost_microusd), 0) AS cost_microusd
        FROM finished_runs
        LEFT JOIN omni_ai_usage AS usage
          ON usage.tenant_id = $1
          AND usage.source_stream_id = 'run:' || finished_runs.id
        GROUP BY finished_runs.id
      ),
      finished_tools AS (
        SELECT status
        FROM omni_tool_executions
        WHERE tenant_id = $1
          AND status IN ('executed', 'failed')
          AND completed_at >= $2
      ),
      decided_approvals AS (
        SELECT EXTRACT(EPOCH FROM (approved_at - created_at)) * 1000 AS latency_ms
        FROM omni_tool_executions
        WHERE tenant_id = $1
          AND approval_decision IN ('approved', 'rejected')
          AND approved_at >= $2
      )
      SELECT
        (SELECT COUNT(*)::int FROM finished_runs) AS finished_runs,
        (SELECT COUNT(*)::int FROM finished_runs WHERE status = 'completed') AS completed_runs,
        COALESCE((SELECT AVG(cost_microusd) FROM run_costs), 0)::float8 AS average_run_cost_microusd,
        (SELECT COUNT(*)::int FROM finished_tools) AS finished_tools,
        (SELECT COUNT(*)::int FROM finished_tools WHERE status = 'failed') AS failed_tools,
        (SELECT COUNT(*)::int FROM decided_approvals) AS decided_approvals,
        COALESCE((
          SELECT PERCENTILE_DISC(0.95) WITHIN GROUP (ORDER BY latency_ms)
          FROM decided_approvals
        ), 0)::float8 AS approval_latency_p95_ms
    `,
    [tenantId, since],
  );
  return agentQualityFromRow(rows[0] || {});
}

function agentQualityFromRow(row: Record<string, unknown>): AgentQualityStats {
  const finishedRuns = Number(row.finished_runs || 0);
  const completedRuns = Number(row.completed_runs || 0);
  const finishedTools = Number(row.finished_tools || 0);
  const failedTools = Number(row.failed_tools || 0);
  return {
    runs: {
      finished: finishedRuns,
      completed: completedRuns,
      successRate: finishedRuns ? completedRuns / finishedRuns : 1,
      costPerRunUsd: Number(row.average_run_cost_microusd || 0) / 1_000_000,
    },
    tools: {
      finished: finishedTools,
      failed: failedTools,
      failureRate: finishedTools ? failedTools / finishedTools : 0,
    },
    approvals: {
      decided: Number(row.decided_approvals || 0),
      latencyP95Ms: Math.round(Number(row.approval_latency_p95_ms || 0)),
    },
  };
}
