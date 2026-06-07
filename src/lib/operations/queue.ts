import { listMcpConnectors } from "@/lib/connectors/store";
import { listOpenApiConnectors } from "@/lib/connectors/openapi-store";
import { summarizeWorkflowHealth } from "@/lib/diagnostics/health";
import {
  getSloPolicyApprovalProgress,
  listObservabilitySloPolicyChanges,
  type ObservabilitySloPolicyChange,
} from "@/lib/observability/slo-policy-store";
import { getOperationJobStats, listOperationJobs } from "@/lib/operations/job-queue";
import { inspectOperationsRecovery } from "@/lib/operations/recovery";
import { listAgentRuns } from "@/lib/runs/store";
import { redactSensitive } from "@/lib/security/context";
import { getToolExecutionStats, listPendingToolApprovals, listToolExecutions } from "@/lib/tools/audit-store";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import { getWorkflowStats, listWorkflowRuns } from "@/lib/workflows/store";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

export type ApprovalQueueItem =
  | {
      kind: "tool";
      id: string;
      title: string;
      status: "approval_required";
      riskLevel: number;
      requestedBy?: string;
      tenantId?: string;
      reason?: string;
      createdAt: string;
      input: Record<string, unknown>;
      record: ToolExecutionRecord;
    }
  | {
      kind: "workflow";
      id: string;
      title: string;
      status: "waiting_approval";
      riskLevel: number;
      requestedBy?: string;
      tenantId?: string;
      reason?: string;
      createdAt: string;
      input: Record<string, unknown>;
      record: WorkflowRunRecord;
    }
  | {
      kind: "slo_policy";
      id: string;
      title: string;
      status: "pending";
      riskLevel: number;
      requestedBy?: string;
      tenantId?: string;
      reason?: string;
      createdAt: string;
      input: Record<string, unknown>;
      record: ObservabilitySloPolicyChange;
    };

export async function getApprovalQueue(limit = 25) {
  const [toolApprovals, workflowRuns, sloPolicyChanges] = await Promise.all([
    listPendingToolApprovals(limit),
    listWorkflowRuns(100),
    listObservabilitySloPolicyChanges({ status: "pending", limit }),
  ]);
  const workflowApprovals = workflowRuns
    .filter((run) => run.status === "waiting_approval")
    .slice(0, limit);
  const items = [
    ...toolApprovals.map(toolApprovalToQueueItem),
    ...workflowApprovals.map(workflowApprovalToQueueItem),
    ...sloPolicyChanges.map(sloPolicyChangeToQueueItem),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  return {
    items: items.slice(0, limit),
    stats: {
      total: items.length,
      tools: toolApprovals.length,
      workflows: workflowApprovals.length,
      sloPolicies: sloPolicyChanges.length,
    },
  };
}

export async function getOperationsOverview() {
  const [
    approvals,
    workflowRuns,
    workflowStats,
    toolExecutions,
    toolStats,
    agentRuns,
    mcpConnectors,
    openApiConnectors,
    operationJobStats,
    operationJobs,
    recovery,
  ] = await Promise.all([
    getApprovalQueue(25),
    listWorkflowRuns(20),
    getWorkflowStats(),
    listToolExecutions(20),
    getToolExecutionStats(),
    listAgentRuns(20),
    listMcpConnectors(),
    listOpenApiConnectors(),
    getOperationJobStats(),
    listOperationJobs(20),
    inspectOperationsRecovery({ limit: 10 }),
  ]);
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
      runnableJobs: operationJobStats.runnable,
      expiredLeases: operationJobStats.expiredLeases,
      staleWorkflows: workflowHealth.staleRunnable,
      recoverableWorkflows: recovery.staleWorkflows.filter((workflow) => workflow.reason.includes("retryable")).length,
    },
    recovery,
    latest: {
      workflows: workflowRuns,
      toolExecutions,
      agentRuns,
      operationJobs,
      connectors: [...mcpConnectors, ...openApiConnectors]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 10),
    },
  };
}

function toolApprovalToQueueItem(record: ToolExecutionRecord): ApprovalQueueItem {
  return {
    kind: "tool",
    id: record.id,
    title: record.toolName,
    status: "approval_required",
    riskLevel: record.riskLevel,
    requestedBy: record.actorId,
    tenantId: record.tenantId,
    reason: record.reason,
    createdAt: record.createdAt,
    input: redactSensitive(record.input) as Record<string, unknown>,
    record: {
      ...record,
      input: redactSensitive(record.input) as Record<string, unknown>,
      output: redactSensitive(record.output),
    },
  };
}

function workflowApprovalToQueueItem(record: WorkflowRunRecord): ApprovalQueueItem {
  return {
    kind: "workflow",
    id: record.id,
    title: record.goal,
    status: "waiting_approval",
    riskLevel: 2,
    reason: record.error || "Workflow requires human approval before execution.",
    createdAt: record.updatedAt,
    input: redactSensitive(record.input || {}) as Record<string, unknown>,
    record,
  };
}

function sloPolicyChangeToQueueItem(record: ObservabilitySloPolicyChange): ApprovalQueueItem {
  const title = record.afterPolicy?.name || record.beforePolicy?.name || record.policyId;
  const progress = getSloPolicyApprovalProgress(record);
  return {
    kind: "slo_policy",
    id: record.id,
    title: `SLO ${record.action.replace(/_/g, " ")}: ${title}`,
    status: "pending",
    riskLevel: record.riskLevel,
    requestedBy: record.requestedBy,
    tenantId: record.tenantId,
    reason: [
      record.reason || "SLO policy change requires approval.",
      `${progress.approvals}/${progress.required} approvals recorded.`,
      `Required roles: ${record.approvalPolicy.requiredRoles.join(", ")}.`,
    ].join(" "),
    createdAt: record.createdAt,
    input: redactSensitive({
      policyId: record.policyId,
      action: record.action,
      beforePolicy: record.beforePolicy,
      afterPolicy: record.afterPolicy,
      rollbackChangeId: record.rollbackChangeId,
      approvalPolicy: record.approvalPolicy,
      approvalProgress: progress,
    }) as Record<string, unknown>,
    record: {
      ...record,
      beforePolicy: redactSensitive(record.beforePolicy) as ObservabilitySloPolicyChange["beforePolicy"],
      afterPolicy: redactSensitive(record.afterPolicy) as ObservabilitySloPolicyChange["afterPolicy"],
      metadata: redactSensitive(record.metadata) as Record<string, unknown>,
    },
  };
}
