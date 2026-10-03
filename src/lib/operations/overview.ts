import { listMcpConnectors } from "@/lib/connectors/store";
import { listOpenApiConnectors } from "@/lib/connectors/openapi-store";
import { summarizeWorkflowHealth } from "@/lib/diagnostics/health";
import {
  getOperationJobStats,
  listOperationJobRecoveryRows,
  listQuarantinedOperationJobs,
} from "@/lib/operations/job-queue";
import { getApprovalQueue } from "@/lib/operations/queue";
import { inspectOperationsRecovery } from "@/lib/operations/recovery";
import { listAgentRuns } from "@/lib/runs/store";
import { publicAgentRun } from "@/lib/runs/public";
import { getToolExecutionStats, listToolExecutions } from "@/lib/tools/audit-store";
import {
  getWorkflowStats,
  listWorkflowRecoveryEvents,
  listWorkflowRuns,
} from "@/lib/workflows/store";
import { publicWorkflowRun } from "@/lib/workflows/public";

/**
 * The operations center's overview. It lives apart from the approval queue
 * because recovery and workflow health reach the workflow engine, and pages
 * that only list approvals, such as Today, must not load it.
 */
export async function getOperationsOverview(options: { tenantId?: string } = {}) {
  const [
    approvals,
    workflowRows,
    workflowStats,
    toolExecutions,
    toolStats,
    agentRuns,
    mcpConnectors,
    openApiConnectors,
    operationJobStats,
    operationJobRows,
    quarantinedJobs,
    recoveryEvents,
  ] = await Promise.all([
    getApprovalQueue(25, { tenantId: options.tenantId }),
    listWorkflowRuns(100, { tenantId: options.tenantId }),
    getWorkflowStats({ tenantId: options.tenantId }),
    listToolExecutions(20, { tenantId: options.tenantId }),
    getToolExecutionStats({ tenantId: options.tenantId }),
    listAgentRuns(20, { tenantId: options.tenantId }),
    listMcpConnectors(20, { tenantId: options.tenantId }),
    listOpenApiConnectors(20, { tenantId: options.tenantId }),
    getOperationJobStats({ tenantId: options.tenantId, latestLimit: 20 }),
    listOperationJobRecoveryRows(100, { tenantId: options.tenantId }),
    listQuarantinedOperationJobs(10, { tenantId: options.tenantId }),
    listWorkflowRecoveryEvents(10, { tenantId: options.tenantId }),
  ]);
  const workflowRuns = workflowRows.slice(0, 20);
  const recovery = await inspectOperationsRecovery({
    limit: 10,
    tenantId: options.tenantId,
    inspectionSnapshot: {
      jobs: {
        ...operationJobStats,
        latest: operationJobStats.latest.slice(0, 5),
      },
      workflows: workflowStats,
      jobRows: operationJobRows,
      workflowRows,
    },
  });
  const connectorErrors =
    mcpConnectors.filter((connector) => connector.status === "error").length +
    openApiConnectors.filter((connector) => connector.status === "error").length;
  const workflowHealth = summarizeWorkflowHealth(workflowStats, workflowRuns);
  const liveWorkflowRisks = workflowHealth.staleRunnable + workflowHealth.recentUnhandledFailures;

  return {
    approvals,
    summary: {
      pendingApprovals: approvals.stats.total,
      activeWorkflows: workflowStats.active,
      failedWorkflows: workflowStats.byStatus.failed || 0,
      historicalFailedWorkflows: workflowStats.byStatus.failed || 0,
      liveWorkflowRisks,
      recentUnhandledWorkflowFailures: workflowHealth.recentUnhandledFailures,
      recoveredWorkflowFailures: workflowHealth.recoveredTerminalFailures,
      failedTools: toolStats.byStatus.failed || 0,
      connectorErrors,
      runningRuns: agentRuns.filter((run) => run.status === "running").length,
      queuedJobs: operationJobStats.byStatus.queued || 0,
      runningJobs: operationJobStats.byStatus.running || 0,
      failedJobs: operationJobStats.byStatus.failed || 0,
      quarantinedJobs: operationJobStats.byStatus.quarantined || 0,
      runnableJobs: operationJobStats.runnable,
      expiredLeases: operationJobStats.expiredLeases,
      staleWorkflows: workflowHealth.staleRunnable,
      recoverableWorkflows: recovery.staleWorkflows.filter((workflow) => workflow.reason.includes("retryable")).length,
    },
    recovery,
    latest: {
      workflows: workflowRuns.map(publicWorkflowRun),
      toolExecutions,
      agentRuns: agentRuns.map(publicAgentRun),
      operationJobs: operationJobStats.latest,
      quarantinedJobs: quarantinedJobs.map((job) => ({
        id: job.id,
        type: job.type,
        attempt: job.attempt,
        maxAttempts: job.maxAttempts,
        leaseLapses: job.leaseLapses || 0,
        lastError: job.lastError,
        updatedAt: job.updatedAt,
      })),
      recoveryEvents,
      connectors: [...mcpConnectors, ...openApiConnectors]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 10),
    },
  };
}
