import {
  cancelOperationJobByDedupeKey,
  getOperationJobStats,
  listOperationJobs,
  repairExpiredOperationJobs,
  requeueOperationJobByDedupeKey,
  type OperationJobRecord,
  type OperationJobStats,
} from "@/lib/operations/job-queue";
import { processWorkflowQueue, enqueueWorkflowRunTick, getWorkflowJobDedupeKey } from "@/lib/workflows/queue";
import {
  appendWorkflowEvent,
  getWorkflowStats,
  listWorkflowRuns,
  setWorkflowRunStatus,
  updateWorkflowRun,
} from "@/lib/workflows/store";
import type { WorkflowRunRecord, WorkflowStats } from "@/lib/workflows/types";

export type OperationsRecoveryMode = "inspect" | "repair" | "drain";
export type OperationsRecoveryDisposition = "inspect" | "requeued" | "failed" | "skipped";

export type OperationsRecoveryWorkflow = {
  workflowRunId: string;
  status: WorkflowRunRecord["status"];
  currentStep?: string;
  attempt: number;
  maxAttempts: number;
  staleMs: number;
  ageMs: number;
  disposition: OperationsRecoveryDisposition;
  reason: string;
  jobIds: string[];
};

export type OperationsRecoveryReport = {
  mode: OperationsRecoveryMode;
  inspectedAt: string;
  staleWorkflowMs: number;
  failAfterMs: number;
  limit: number;
  expiredLeasesRepaired: number;
  staleWorkflows: OperationsRecoveryWorkflow[];
  requeuedWorkflows: number;
  failedWorkflows: number;
  skippedWorkflows: number;
  runnableJobsBefore: number;
  runnableJobsAfter: number;
  expiredLeasesBefore: number;
  expiredLeasesAfter: number;
  drain?: {
    requested: number;
    leased: number;
    completed: number;
    failed: number;
    requeued: number;
  };
  before: {
    jobs: OperationJobStats;
    workflows: WorkflowStats;
  };
  after: {
    jobs: OperationJobStats;
    workflows: WorkflowStats;
  };
};

export type OperationsRecoveryInput = {
  mode?: OperationsRecoveryMode;
  limit?: number;
  staleWorkflowMs?: number;
  failAfterMs?: number;
  drainLimit?: number;
  actorId?: string;
};

const defaultStaleWorkflowMs = 10 * 60 * 1000;
const defaultFailAfterMs = 6 * 60 * 60 * 1000;

export async function inspectOperationsRecovery(input: OperationsRecoveryInput = {}) {
  return reconcileOperationsRecovery({ ...input, mode: "inspect" });
}

export async function reconcileOperationsRecovery(input: OperationsRecoveryInput = {}): Promise<OperationsRecoveryReport> {
  const mode = input.mode || "inspect";
  const limit = Math.min(Math.max(Math.round(input.limit || 10), 1), 50);
  const drainLimit = Math.min(Math.max(Math.round(input.drainLimit || 5), 1), 10);
  const staleWorkflowMs = Math.min(Math.max(Math.round(input.staleWorkflowMs ?? defaultStaleWorkflowMs), 0), 86_400_000);
  const failAfterMs = Math.min(Math.max(Math.round(input.failAfterMs || defaultFailAfterMs), staleWorkflowMs), 7 * 86_400_000);
  const [jobsBefore, workflowsBefore, jobRows, workflowRows] = await Promise.all([
    getOperationJobStats(),
    getWorkflowStats(),
    listOperationJobs(100),
    listWorkflowRuns(100),
  ]);
  const staleCandidates = workflowRows
    .filter((run) => isStaleRunnableWorkflow(run, staleWorkflowMs))
    .sort((left, right) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .slice(0, limit);
  const expiredLeasesRepaired = mode === "inspect" ? 0 : await repairExpiredOperationJobs();
  const staleWorkflows: OperationsRecoveryWorkflow[] = [];

  for (const run of staleCandidates) {
    const staleMs = Date.now() - Date.parse(run.updatedAt);
    const ageMs = Date.now() - Date.parse(run.createdAt);
    if (mode === "inspect") {
      staleWorkflows.push(summarizeWorkflow(run, staleMs, ageMs, "inspect", classifyStaleWorkflow(run, staleMs, failAfterMs)));
      continue;
    }

    const exhausted = run.attempt >= run.maxAttempts || staleMs >= failAfterMs;
    if (exhausted) {
      staleWorkflows.push(await failStaleWorkflow(run, staleMs, ageMs, input.actorId));
      continue;
    }

    staleWorkflows.push(await requeueStaleWorkflow(run, staleMs, ageMs, input.actorId, jobRows));
  }

  const drain = mode === "drain"
    ? await processWorkflowQueue({ limit: drainLimit, bootstrapQueuedRuns: true })
    : undefined;
  const [jobsAfter, workflowsAfter] = await Promise.all([
    getOperationJobStats(),
    getWorkflowStats(),
  ]);

  return {
    mode,
    inspectedAt: new Date().toISOString(),
    staleWorkflowMs,
    failAfterMs,
    limit,
    expiredLeasesRepaired,
    staleWorkflows,
    requeuedWorkflows: staleWorkflows.filter((item) => item.disposition === "requeued").length,
    failedWorkflows: staleWorkflows.filter((item) => item.disposition === "failed").length,
    skippedWorkflows: staleWorkflows.filter((item) => item.disposition === "skipped").length,
    runnableJobsBefore: jobsBefore.runnable,
    runnableJobsAfter: jobsAfter.runnable,
    expiredLeasesBefore: jobsBefore.expiredLeases,
    expiredLeasesAfter: jobsAfter.expiredLeases,
    drain: drain
      ? {
          requested: drain.requested,
          leased: drain.leased,
          completed: drain.completed,
          failed: drain.failed,
          requeued: drain.requeued,
        }
      : undefined,
    before: {
      jobs: jobsBefore,
      workflows: workflowsBefore,
    },
    after: {
      jobs: jobsAfter,
      workflows: workflowsAfter,
    },
  };
}

function isStaleRunnableWorkflow(run: WorkflowRunRecord, staleWorkflowMs: number) {
  return ["queued", "running"].includes(run.status) && Date.now() - Date.parse(run.updatedAt) > staleWorkflowMs;
}

function classifyStaleWorkflow(run: WorkflowRunRecord, staleMs: number, failAfterMs: number) {
  if (run.attempt >= run.maxAttempts) {
    return "Workflow exhausted max attempts and should be failed.";
  }
  if (staleMs >= failAfterMs) {
    return "Workflow exceeded stale fail-after threshold and should be failed.";
  }
  return "Workflow is stale but still retryable and should be requeued.";
}

function summarizeWorkflow(
  run: WorkflowRunRecord,
  staleMs: number,
  ageMs: number,
  disposition: OperationsRecoveryDisposition,
  reason: string,
  jobIds: string[] = [],
): OperationsRecoveryWorkflow {
  return {
    workflowRunId: run.id,
    status: run.status,
    currentStep: run.currentStep,
    attempt: run.attempt,
    maxAttempts: run.maxAttempts,
    staleMs,
    ageMs,
    disposition,
    reason,
    jobIds,
  };
}

async function requeueStaleWorkflow(
  run: WorkflowRunRecord,
  staleMs: number,
  ageMs: number,
  actorId?: string,
  jobs: OperationJobRecord[] = [],
) {
  if (run.status === "running") {
    await updateWorkflowRun(run.id, {
      status: "queued",
      error: "Recovery reconciled stale running workflow back to queued.",
    });
  }

  const dedupeKey = getWorkflowJobDedupeKey(run.id);
  const existingJobs = jobs.filter((job) => job.dedupeKey === dedupeKey && ["queued", "running", "failed"].includes(job.status));
  const requeuedJobs = existingJobs.length
    ? await requeueOperationJobByDedupeKey(dedupeKey, "Recovery requeued stale workflow job.")
    : [await enqueueWorkflowRunTick(run.id, "operations_recovery_stale_workflow", 30)];
  await appendWorkflowEvent(run.id, "workflow.recovery.requeued", {
    actorId,
    staleMs,
    jobIds: requeuedJobs.map((job) => job.id),
    previousStatus: run.status,
  }).catch(() => undefined);
  return summarizeWorkflow(
    run,
    staleMs,
    ageMs,
    "requeued",
    "Workflow was stale and has been requeued for bounded processing.",
    requeuedJobs.map((job) => job.id),
  );
}

async function failStaleWorkflow(run: WorkflowRunRecord, staleMs: number, ageMs: number, actorId?: string) {
  const reason = run.attempt >= run.maxAttempts
    ? "Recovery failed stale workflow after max attempts were exhausted."
    : "Recovery failed workflow after stale fail-after threshold was exceeded.";
  await setWorkflowRunStatus(run.id, "failed", {
    currentStep: run.currentStep,
    error: reason,
  });
  const canceledJobs = await cancelOperationJobByDedupeKey(getWorkflowJobDedupeKey(run.id), reason);
  await appendWorkflowEvent(run.id, "workflow.recovery.failed", {
    actorId,
    staleMs,
    ageMs,
    reason,
    canceledJobIds: canceledJobs.map((job) => job.id),
  }).catch(() => undefined);
  return summarizeWorkflow(
    run,
    staleMs,
    ageMs,
    "failed",
    reason,
    canceledJobs.map((job) => job.id),
  );
}
