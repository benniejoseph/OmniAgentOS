import { listMcpConnectors } from "@/lib/connectors/store";
import { listOpenApiConnectors } from "@/lib/connectors/openapi-store";
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
    };

export async function getApprovalQueue(limit = 25) {
  const [toolApprovals, workflowRuns] = await Promise.all([
    listPendingToolApprovals(limit),
    listWorkflowRuns(100),
  ]);
  const workflowApprovals = workflowRuns
    .filter((run) => run.status === "waiting_approval")
    .slice(0, limit);
  const items = [
    ...toolApprovals.map(toolApprovalToQueueItem),
    ...workflowApprovals.map(workflowApprovalToQueueItem),
  ].sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt));

  return {
    items: items.slice(0, limit),
    stats: {
      total: items.length,
      tools: toolApprovals.length,
      workflows: workflowApprovals.length,
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
  ] = await Promise.all([
    getApprovalQueue(25),
    listWorkflowRuns(20),
    getWorkflowStats(),
    listToolExecutions(20),
    getToolExecutionStats(),
    listAgentRuns(20),
    listMcpConnectors(),
    listOpenApiConnectors(),
  ]);
  const connectorErrors =
    mcpConnectors.filter((connector) => connector.status === "error").length +
    openApiConnectors.filter((connector) => connector.status === "error").length;

  return {
    approvals,
    summary: {
      pendingApprovals: approvals.stats.total,
      activeWorkflows: workflowStats.active,
      failedWorkflows: workflowStats.byStatus.failed || 0,
      failedTools: toolStats.byStatus.failed || 0,
      connectorErrors,
      runningRuns: agentRuns.filter((run) => run.status === "running").length,
    },
    latest: {
      workflows: workflowRuns,
      toolExecutions,
      agentRuns,
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
