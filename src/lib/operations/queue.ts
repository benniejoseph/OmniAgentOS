import { listMcpConnectors } from "@/lib/connectors/store";
import { listOpenApiConnectors } from "@/lib/connectors/openapi-store";
import { summarizeWorkflowHealth } from "@/lib/diagnostics/health";
import {
  getObservabilitySloApprovalPolicyConfig,
  getSloPolicyApprovalProgress,
  listObservabilitySloPolicyChanges,
  type ObservabilitySloPolicyChange,
} from "@/lib/observability/slo-policy-store";
import { getOperationJobStats, listOperationJobs } from "@/lib/operations/job-queue";
import { inspectOperationsRecovery } from "@/lib/operations/recovery";
import { listAgentRuns } from "@/lib/runs/store";
import { publicAgentRun } from "@/lib/runs/public";
import { redactSensitive } from "@/lib/security/context";
import {
  canonicalStatusForApproval,
  canonicalStatusForSloPolicyChange,
  type CanonicalStatusProjection,
} from "@/lib/status/canonical";
import { getToolExecutionStats, listPendingToolApprovals, listToolExecutions } from "@/lib/tools/audit-store";
import {
  getWorkflowPlanForRun,
  getWorkflowPlansForRuns,
} from "@/lib/workflows/planner";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import {
  getWorkflowStats,
  listWorkflowRecoveryEvents,
  listWorkflowRuns,
  listWorkflowRunsByStatus,
} from "@/lib/workflows/store";
import { publicWorkflowRun } from "@/lib/workflows/public";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

export type ApprovalQueueItem =
  | {
      kind: "tool";
      id: string;
      title: string;
      status: "approval_required" | "reconciliation_required";
      canonicalStatus: CanonicalStatusProjection;
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
      canonicalStatus: CanonicalStatusProjection;
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
      canonicalStatus: CanonicalStatusProjection;
      riskLevel: number;
      requestedBy?: string;
      tenantId?: string;
      reason?: string;
      createdAt: string;
      input: Record<string, unknown>;
      record: ObservabilitySloPolicyChange;
    };

export async function getApprovalQueue(limit = 25, options: { tenantId?: string } = {}) {
  const [
    toolApprovals,
    workflowRuns,
    sloPolicyChanges,
    sloApprovalPolicy,
  ] = await Promise.all([
    listPendingToolApprovals(limit, { tenantId: options.tenantId }),
    listWorkflowRunsByStatus("waiting_approval", limit, {
      tenantId: options.tenantId,
    }),
    listObservabilitySloPolicyChanges({ status: "pending", limit, tenantId: options.tenantId }),
    getObservabilitySloApprovalPolicyConfig(),
  ]);
  const workflowApprovals = workflowRuns.slice(0, limit);
  const workflowPlans = await getWorkflowPlansForRuns(
    workflowApprovals.map((run) => run.id),
    { tenantId: options.tenantId },
  );
  const workflowApprovalItems = workflowApprovals.map((run) =>
    workflowApprovalToQueueItem(run, workflowPlans.get(run.id) || null),
  );
  const reconciliationCount = toolApprovals.filter(
    isMemoryForgetReconciliationRecord,
  ).length;
  const items = [
    ...toolApprovals.map(toolApprovalToQueueItem),
    ...workflowApprovalItems,
    ...sloPolicyChanges.map((change) =>
      sloPolicyChangeToQueueItem(change, sloApprovalPolicy.breakGlass),
    ),
  ].sort(
    (left, right) =>
      Number(right.status === "reconciliation_required") -
        Number(left.status === "reconciliation_required") ||
      Date.parse(right.createdAt) - Date.parse(left.createdAt),
  );

  return {
    items: items.slice(0, limit),
    stats: {
      total: items.length,
      tools: toolApprovals.length,
      reconciliations: reconciliationCount,
      workflows: workflowApprovals.length,
      sloPolicies: sloPolicyChanges.length,
    },
  };
}

export async function getOperationsOverview(options: { tenantId?: string } = {}) {
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
    recoveryEvents,
  ] = await Promise.all([
    getApprovalQueue(25, { tenantId: options.tenantId }),
    listWorkflowRuns(20, { tenantId: options.tenantId }),
    getWorkflowStats({ tenantId: options.tenantId }),
    listToolExecutions(20, { tenantId: options.tenantId }),
    getToolExecutionStats({ tenantId: options.tenantId }),
    listAgentRuns(20, { tenantId: options.tenantId }),
    listMcpConnectors(20, { tenantId: options.tenantId }),
    listOpenApiConnectors(20, { tenantId: options.tenantId }),
    getOperationJobStats({ tenantId: options.tenantId }),
    listOperationJobs(20, { tenantId: options.tenantId }),
    inspectOperationsRecovery({ limit: 10, tenantId: options.tenantId }),
    listWorkflowRecoveryEvents(10, { tenantId: options.tenantId }),
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
      workflows: workflowRuns.map(publicWorkflowRun),
      toolExecutions,
      agentRuns: agentRuns.map(publicAgentRun),
      operationJobs,
      recoveryEvents,
      connectors: [...mcpConnectors, ...openApiConnectors]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 10),
    },
  };
}

function toolApprovalToQueueItem(record: ToolExecutionRecord): ApprovalQueueItem {
  const reconciliationRequired = isMemoryForgetReconciliationRecord(record);
  const canonicalStatus = canonicalStatusForApproval("approval_required");
  return {
    kind: "tool",
    id: record.id,
    title: record.toolName,
    status: reconciliationRequired
      ? "reconciliation_required"
      : "approval_required",
    canonicalStatus: reconciliationRequired
      ? { ...canonicalStatus, sourceStatus: "reconciliation_required" }
      : canonicalStatus,
    riskLevel: record.riskLevel,
    requestedBy: record.actorId,
    tenantId: record.tenantId,
    reason: reconciliationRequired
      ? "Approval is already recorded, but the deletion outcome was not finalized before its execution claim expired. Reconcile the immutable receipt or safely replay the same bound request."
      : record.reason,
    createdAt: record.createdAt,
    input: redactSensitive(record.input) as Record<string, unknown>,
    record: {
      ...record,
      input: redactSensitive(record.input) as Record<string, unknown>,
      output: redactSensitive(record.output),
    },
  };
}

function isMemoryForgetReconciliationRecord(record: ToolExecutionRecord) {
  return record.status === "executing" &&
    record.toolId === "memory.forget" &&
    !record.dryRun &&
    record.approvalRequired &&
    record.approvalDecision === "approved";
}

function workflowApprovalToQueueItem(
  record: WorkflowRunRecord,
  plan: Awaited<ReturnType<typeof getWorkflowPlanForRun>>,
): ApprovalQueueItem {
  const review = plan
    ? {
        id: plan.id,
        planner: plan.planner,
        confidence: plan.confidence,
        highestRiskLevel: plan.highestRiskLevel,
        approvalRequired: plan.approvalRequired,
        acceptanceCriteria: plan.plan.acceptanceCriteria,
        selectedToolIds: plan.plan.selectedToolIds,
        connectorTargets: plan.plan.connectorTargets,
        nodes: plan.plan.nodes.map((node) => ({
          id: node.id,
          label: node.label,
          kind: node.kind,
          toolIds: node.toolIds,
          riskLevel: node.riskLevel,
          dependsOn: node.dependsOn,
        })),
      }
    : { unavailable: true };
  return {
    kind: "workflow",
    id: record.id,
    title: record.goal,
    status: "waiting_approval",
    canonicalStatus: canonicalStatusForApproval("waiting_approval"),
    riskLevel: 2,
    reason: record.error || "Workflow requires human approval before execution.",
    createdAt: record.updatedAt,
    input: redactSensitive({
      ...(record.input || {}),
      planReview: review,
    }) as Record<string, unknown>,
    record: publicWorkflowRun(record),
  };
}

function sloPolicyChangeToQueueItem(
  record: ObservabilitySloPolicyChange,
  breakGlassPolicy: Awaited<
    ReturnType<typeof getObservabilitySloApprovalPolicyConfig>
  >["breakGlass"],
): ApprovalQueueItem {
  const title = record.afterPolicy?.name || record.beforePolicy?.name || record.policyId;
  const progress = getSloPolicyApprovalProgress(record);
  return {
    kind: "slo_policy",
    id: record.id,
    title: `SLO ${record.action.replace(/_/g, " ")}: ${title}`,
    status: "pending",
    canonicalStatus: canonicalStatusForSloPolicyChange(record),
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
      breakGlassPolicy,
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
