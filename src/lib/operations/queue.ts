import {
  APPROVAL_SOURCE_RANK,
  approvalSourceAfter,
  decodeApprovalCursor,
  encodeApprovalCursor,
  mergeApprovalPages,
} from "@/lib/approvals/order";
import { listMcpConnectors } from "@/lib/connectors/store";
import { listOpenApiConnectors } from "@/lib/connectors/openapi-store";
import { summarizeWorkflowHealth } from "@/lib/diagnostics/health";
import {
  getObservabilitySloApprovalPolicyConfig,
  getObservabilitySloPolicyChange,
  getSloPolicyApprovalProgress,
  listPendingSloPolicyChangePage,
  type ObservabilitySloPolicyChange,
} from "@/lib/observability/slo-policy-store";
import {
  getOperationJobStats,
  listOperationJobRecoveryRows,
} from "@/lib/operations/job-queue";
import { inspectOperationsRecovery } from "@/lib/operations/recovery";
import {
  findAgentRunsWaitingForToolApprovals,
  listAgentRuns,
} from "@/lib/runs/store";
import { publicAgentRun } from "@/lib/runs/public";
import { redactSensitive } from "@/lib/security/context";
import {
  canonicalStatusForApproval,
  canonicalStatusForSloPolicyChange,
  type CanonicalStatusProjection,
} from "@/lib/status/canonical";
import {
  getPendingToolApproval,
  getToolExecutionStats,
  listPendingToolApprovalPage,
  listToolExecutions,
} from "@/lib/tools/audit-store";
import {
  getWorkflowPlanForRun,
  getWorkflowPlansForRuns,
} from "@/lib/workflows/planner";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import {
  getWorkflowRun,
  getWorkflowStats,
  listWorkflowApprovalPage,
  listWorkflowRecoveryEvents,
  listWorkflowRuns,
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
      /** The paused run and conversation, shown only to the run's owner. */
      origin?: { runId: string; threadId?: string };
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

export type ApprovalQueueStats = {
  total: number;
  tools: number;
  reconciliations: number;
  workflows: number;
  sloPolicies: number;
};

export type ApprovalQueueKind = ApprovalQueueItem["kind"];

type ApprovalQueueSource =
  | { kind: "tool"; record: ToolExecutionRecord }
  | { kind: "workflow"; run: WorkflowRunRecord }
  | { kind: "slo_policy"; change: ObservabilitySloPolicyChange };

/**
 * One page of the approvals waiting in a tenant, in approval order (see
 * `@/lib/approvals/order`): reconciliations first, then by the time each
 * item started waiting, less a day per risk level. Stats count every
 * pending item, not only this page. `cursor` is a `nextCursor` from the
 * page before; an invalid one throws ApprovalCursorError. With `actorId`,
 * a tool item paused in that actor's run names the run and conversation.
 */
export async function getApprovalQueue(
  limit = 25,
  options: { tenantId?: string; cursor?: string | null; actorId?: string } = {},
) {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), 100);
  const cursor = options.cursor ? decodeApprovalCursor(options.cursor) : undefined;
  const [toolPage, workflowPage, sloPage, sloApprovalPolicy] = await Promise.all([
    listPendingToolApprovalPage({
      tenantId: options.tenantId,
      limit: boundedLimit,
      after: approvalSourceAfter(cursor, APPROVAL_SOURCE_RANK.tool),
    }),
    listWorkflowApprovalPage({
      tenantId: options.tenantId,
      limit: boundedLimit,
      after: approvalSourceAfter(cursor, APPROVAL_SOURCE_RANK.workflow),
    }),
    listPendingSloPolicyChangePage({
      tenantId: options.tenantId,
      limit: boundedLimit,
      after: approvalSourceAfter(cursor, APPROVAL_SOURCE_RANK.slo_policy),
    }),
    getObservabilitySloApprovalPolicyConfig(),
  ]);
  const merged = mergeApprovalPages<ApprovalQueueSource>([
    {
      entries: toolPage.entries.map(({ record, key }) => ({
        item: { kind: "tool" as const, record },
        key,
      })),
      last: toolPage.last,
      exhausted: toolPage.exhausted,
    },
    {
      entries: workflowPage.entries.map(({ run, key }) => ({
        item: { kind: "workflow" as const, run },
        key,
      })),
      last: workflowPage.last,
      exhausted: workflowPage.exhausted,
    },
    {
      entries: sloPage.entries.map(({ change, key }) => ({
        item: { kind: "slo_policy" as const, change },
        key,
      })),
      last: sloPage.last,
      exhausted: sloPage.exhausted,
    },
  ], boundedLimit);
  const sources = merged.entries.map(({ item }) => item);
  const workflowRunIds = sources.flatMap((source) =>
    source.kind === "workflow" ? [source.run.id] : []
  );
  const toolExecutionIds = sources.flatMap((source) =>
    source.kind === "tool" ? [source.record.id] : []
  );
  const [workflowPlans, origins] = await Promise.all([
    workflowRunIds.length
      ? getWorkflowPlansForRuns(workflowRunIds, { tenantId: options.tenantId })
      : Promise.resolve(new Map<string, Awaited<ReturnType<typeof getWorkflowPlanForRun>>>()),
    toolExecutionIds.length && options.actorId
      ? findAgentRunsWaitingForToolApprovals(toolExecutionIds, {
          tenantId: options.tenantId,
        })
      : Promise.resolve(undefined),
  ]);
  const items = sources.map((source): ApprovalQueueItem => {
    if (source.kind === "tool") {
      return withToolOrigin(
        toolApprovalToQueueItem(source.record),
        origins?.get(source.record.id),
        options.actorId,
      );
    }
    if (source.kind === "workflow") {
      return workflowApprovalToQueueItem(
        source.run,
        workflowPlans.get(source.run.id) || null,
      );
    }
    return sloPolicyChangeToQueueItem(source.change, sloApprovalPolicy.breakGlass);
  });
  const stats: ApprovalQueueStats = {
    total: toolPage.total + workflowPage.total + sloPage.total,
    tools: toolPage.total,
    reconciliations: toolPage.reconciliations,
    workflows: workflowPage.total,
    sloPolicies: sloPage.total,
  };

  return {
    items,
    stats,
    nextCursor: merged.nextCursor ? encodeApprovalCursor(merged.nextCursor) : null,
  };
}

/**
 * One approval by id while it still waits on a person; null once it was
 * decided, finished, or never existed in this tenant. Without `kind`, tool
 * actions are tried first, then workflow runs, then SLO policy changes.
 */
export async function getApprovalQueueItem(
  id: string,
  options: { tenantId?: string; kind?: ApprovalQueueKind; actorId?: string } = {},
): Promise<ApprovalQueueItem | null> {
  const approvalId = id.trim();
  if (!approvalId) return null;
  const tenantId = options.tenantId;
  if (!options.kind || options.kind === "tool") {
    const record = await getPendingToolApproval(approvalId, { tenantId });
    if (record) {
      const origins = options.actorId
        ? await findAgentRunsWaitingForToolApprovals([record.id], { tenantId })
        : undefined;
      return withToolOrigin(
        toolApprovalToQueueItem(record),
        origins?.get(record.id),
        options.actorId,
      );
    }
    if (options.kind) return null;
  }
  if (!options.kind || options.kind === "workflow") {
    const run = await getWorkflowRun(approvalId, { tenantId });
    if (run?.status === "waiting_approval") {
      const plan = await getWorkflowPlanForRun(run.id, { tenantId });
      return workflowApprovalToQueueItem(run, plan || null);
    }
    if (options.kind) return null;
  }
  const change = await getObservabilitySloPolicyChange(approvalId, { tenantId });
  if (change?.status !== "pending") return null;
  const sloApprovalPolicy = await getObservabilitySloApprovalPolicyConfig();
  return sloPolicyChangeToQueueItem(change, sloApprovalPolicy.breakGlass);
}

function withToolOrigin(
  item: ApprovalQueueItem,
  origin: { runId: string; threadId?: string; ownerActorId: string } | undefined,
  actorId: string | undefined,
): ApprovalQueueItem {
  if (item.kind !== "tool" || !origin || !actorId || origin.ownerActorId !== actorId) {
    return item;
  }
  return {
    ...item,
    origin: origin.threadId
      ? { runId: origin.runId, threadId: origin.threadId }
      : { runId: origin.runId },
  };
}

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
      recoveryEvents,
      connectors: [...mcpConnectors, ...openApiConnectors]
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, 10),
    },
  };
}

function toolApprovalToQueueItem(record: ToolExecutionRecord): ApprovalQueueItem {
  const memoryForgetReconciliation = isMemoryForgetReconciliationRecord(record);
  const readOnlyReconciliation = isReadOnlyReconciliationRecord(record);
  const reconciliationRequired =
    memoryForgetReconciliation || readOnlyReconciliation;
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
    reason: memoryForgetReconciliation
      ? "Approval is already recorded, but the deletion outcome was not finalized before its execution claim expired. Reconcile the immutable receipt or safely replay the same bound request."
      : readOnlyReconciliation
        ? "Approval is already recorded, but this read-only action stopped before returning a result. Retry the exact approved request to fetch a fresh result; this recovery cannot perform a mutation."
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

function isReadOnlyReconciliationRecord(record: ToolExecutionRecord) {
  return record.status === "executing" &&
    record.toolId !== "memory.forget" &&
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
        connectorTargets: node.connectorTargets,
        reviewedToolInputs: (node.toolInputs || []).map((input) => ({
          toolId: input.toolId,
          input: parseReviewedWorkflowInput(input.inputJson),
          grantEligible: !node.inputBindings?.some(
            (binding) => binding.targetToolId === input.toolId,
          ),
        })),
        hasDynamicInputBindings: Boolean(node.inputBindings?.length),
      })),
      approvalGrant: {
        scope: "Only exact reviewed static inputs for reversible risk-one or risk-two tools.",
        maxLifetimeHours: 24,
        replanningInvalidates: true,
      },
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

function parseReviewedWorkflowInput(inputJson: string) {
  try {
    const value: unknown = JSON.parse(inputJson);
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : { unavailable: "Reviewed input is not an object." };
  } catch {
    return { unavailable: "Reviewed input could not be parsed." };
  }
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
