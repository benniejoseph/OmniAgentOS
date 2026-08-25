import { unstable_cache } from "next/cache";
import { getApprovalQueue, type ApprovalQueueItem } from "@/lib/operations/queue";
import { listAgentRunSummaries } from "@/lib/runs/store";
import type { AgentRunRecord } from "@/lib/runs/types";
import { canPerform } from "@/lib/security/context";
import type { SecurityRole } from "@/lib/security/types";
import { listWorkflowRunSummaries } from "@/lib/workflows/store";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

export type WorkspaceSummarySource<T> =
  | { status: "ready"; data: T }
  | { status: "restricted"; error: string }
  | { status: "error"; error: string };

export type WorkspaceSummary = {
  tenantId: string;
  generatedAt: string;
  sources: {
    runs: WorkspaceSummarySource<ReturnType<typeof projectAgentRun>[]>;
    workflows: WorkspaceSummarySource<ReturnType<typeof projectWorkflowRun>[]>;
    approvals: WorkspaceSummarySource<ReturnType<typeof projectApproval>[]>;
  };
};

type WorkspaceSummaryDependencies = {
  listRuns: (
    limit: number,
    options: { tenantId?: string },
  ) => Promise<AgentRunRecord[]>;
  listWorkflows: (
    limit: number,
    options: { tenantId?: string },
  ) => Promise<WorkflowRunRecord[]>;
  getApprovals: (
    limit: number,
    options: { tenantId?: string },
  ) => Promise<{ items: ApprovalQueueItem[] }>;
};

const defaultDependencies: WorkspaceSummaryDependencies = {
  listRuns: listAgentRunSummaries,
  listWorkflows: listWorkflowRunSummaries,
  getApprovals: getApprovalQueue,
};

// Next's data cache is shared across serverless instances. The arguments are
// part of the cache key, so tenant and permission boundaries remain isolated.
const loadCachedWorkspaceSummary = unstable_cache(
  (
    tenantId: string,
    role: SecurityRole,
    boundedLimit: number,
    boundedApprovalLimit: number,
  ) =>
    loadWorkspaceSummarySources({
      tenantId,
      role,
      boundedLimit,
      boundedApprovalLimit,
      dependencies: defaultDependencies,
    }),
  ["workspace-summary-v1"],
  { revalidate: 15 },
);

export async function loadWorkspaceSummary(
  {
    tenantId,
    role,
    limit = 16,
    approvalLimit = Math.min(limit, 12),
  }: {
    tenantId: string;
    role: SecurityRole;
    limit?: number;
    approvalLimit?: number;
  },
  dependencies: WorkspaceSummaryDependencies = defaultDependencies,
): Promise<WorkspaceSummary> {
  const boundedLimit = Math.min(Math.max(limit, 1), 50);
  const boundedApprovalLimit = Math.min(Math.max(approvalLimit, 1), 25);
  if (dependencies === defaultDependencies) {
    return loadCachedWorkspaceSummary(
      tenantId,
      role,
      boundedLimit,
      boundedApprovalLimit,
    );
  }
  return loadWorkspaceSummarySources({
    tenantId,
    role,
    boundedLimit,
    boundedApprovalLimit,
    dependencies,
  });
}

async function loadWorkspaceSummarySources({
  tenantId,
  role,
  boundedLimit,
  boundedApprovalLimit,
  dependencies,
}: {
  tenantId: string;
  role: SecurityRole;
  boundedLimit: number;
  boundedApprovalLimit: number;
  dependencies: WorkspaceSummaryDependencies;
}): Promise<WorkspaceSummary> {
  const canReadApprovals = canPerform(role, "manage.workflow");
  const [runs, workflows, approvals] = await Promise.allSettled([
    dependencies.listRuns(boundedLimit, { tenantId }),
    dependencies.listWorkflows(boundedLimit, { tenantId }),
    canReadApprovals
      ? dependencies.getApprovals(boundedApprovalLimit, { tenantId })
      : Promise.resolve(undefined),
  ]);

  return {
    tenantId,
    generatedAt: new Date().toISOString(),
    sources: {
      runs: settledSource(runs, (records) => records.map(projectAgentRun)),
      workflows: settledSource(workflows, (records) =>
        records.map(projectWorkflowRun),
      ),
      approvals: canReadApprovals
        ? settledSource(approvals, (queue) =>
            (queue?.items || []).map(projectApproval),
          )
        : {
            status: "restricted",
            error: "Operator role required for approval items.",
          },
    },
  };
}

function settledSource<T, U>(
  result: PromiseSettledResult<T>,
  project: (value: T) => U,
): WorkspaceSummarySource<U> {
  if (result.status === "fulfilled") {
    return { status: "ready", data: project(result.value) };
  }
  return {
    status: "error",
    error:
      result.reason instanceof Error
        ? result.reason.message
        : "Workspace source unavailable.",
  };
}

function projectAgentRun(run: AgentRunRecord) {
  return {
    id: run.id,
    mode: run.mode,
    status: run.status,
    prompt: run.prompt,
    response: run.response,
    error: run.error,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    waitingApproval: run.continuation
      ? {
          executionId: run.continuation.pendingToolCall.executionId,
          toolId: run.continuation.pendingToolCall.toolId,
          toolName: run.continuation.pendingToolCall.toolName,
          riskLevel: run.continuation.pendingToolCall.riskLevel,
        }
      : undefined,
  };
}

function projectWorkflowRun(run: WorkflowRunRecord) {
  return {
    id: run.id,
    workflowType: run.workflowType,
    status: run.status,
    goal: run.goal,
    currentStep: run.currentStep,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    approvalRequired: run.approvalRequired,
    error: run.error,
    report:
      typeof run.result?.report === "string"
        ? run.result.report
        : undefined,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    completedAt: run.completedAt,
  };
}

function projectApproval(item: ApprovalQueueItem) {
  return {
    kind: item.kind,
    id: item.id,
    title: item.title,
    status: item.status,
    riskLevel: item.riskLevel,
    requestedBy: item.requestedBy,
    reason: item.reason,
    createdAt: item.createdAt,
  };
}
