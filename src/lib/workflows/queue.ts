import { after } from "next/server";
import { OPERATION_QUEUE_LEASE_SECONDS, WORKFLOW_DRAIN_LIMIT } from "@/lib/config";
import {
  cancelOperationJobByDedupeKey,
  completeOperationJob,
  enqueueOperationJob,
  failOperationJob,
  leaseOperationJobs,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import { tickWorkflowRun } from "@/lib/workflows/runner";
import { appendWorkflowEvent, listWorkflowRuns } from "@/lib/workflows/store";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

type ProcessWorkflowQueueInput = {
  limit?: number;
  workflowRunId?: string;
  bootstrapQueuedRuns?: boolean;
};

type WorkflowQueueJobResult = {
  job: OperationJobRecord;
  workflowRunId?: string;
  status: "completed" | "failed";
  detail?: WorkflowRunDetail;
  error?: string;
  requeued?: OperationJobRecord;
};

export type WorkflowQueueResult = {
  requested: number;
  leased: number;
  completed: number;
  failed: number;
  requeued: number;
  jobs: WorkflowQueueJobResult[];
};

const workflowJobPriority = 10;
const workflowJobMaxAttempts = 5;
const runnableWorkflowStatuses = new Set(["queued", "running"]);

export async function enqueueWorkflowRunTick(
  workflowRunId: string,
  reason = "workflow_queued",
  priority = workflowJobPriority,
) {
  const job = await enqueueOperationJob({
    type: "workflow.tick",
    dedupeKey: workflowJobDedupeKey(workflowRunId),
    payload: {
      workflowRunId,
      reason,
    },
    priority,
    maxAttempts: workflowJobMaxAttempts,
  });
  await appendWorkflowEvent(workflowRunId, "workflow.queue.enqueued", {
    jobId: job.id,
    reason,
    status: job.status,
    runAt: job.runAt,
  }).catch(() => undefined);
  return job;
}

export async function cancelWorkflowRunTick(workflowRunId: string, reason = "Workflow job canceled.") {
  const jobs = await cancelOperationJobByDedupeKey(workflowJobDedupeKey(workflowRunId), reason);
  if (jobs.length) {
    await appendWorkflowEvent(workflowRunId, "workflow.queue.canceled", {
      reason,
      jobIds: jobs.map((job) => job.id),
    }).catch(() => undefined);
  }
  return jobs;
}

export async function enqueueRunnableWorkflowRuns(limit = 50) {
  const runs = await listWorkflowRuns(Math.max(limit, 50));
  const runnable = runs
    .filter((run) => runnableWorkflowStatuses.has(run.status))
    .slice(0, limit);
  const jobs = [];
  for (const run of runnable) {
    jobs.push(await enqueueWorkflowRunTick(run.id, "queue_bootstrap", workflowJobPriority - 1));
  }
  return jobs;
}

export async function processWorkflowQueue(input: ProcessWorkflowQueueInput = {}): Promise<WorkflowQueueResult> {
  const limit = Math.min(Math.max(input.limit || WORKFLOW_DRAIN_LIMIT, 1), 10);

  if (input.workflowRunId) {
    await enqueueWorkflowRunTick(input.workflowRunId, "operator_tick", workflowJobPriority + 10);
  } else if (input.bootstrapQueuedRuns !== false) {
    await enqueueRunnableWorkflowRuns(50);
  }

  const jobs = await leaseOperationJobs({
    type: "workflow.tick",
    dedupeKey: input.workflowRunId ? workflowJobDedupeKey(input.workflowRunId) : undefined,
    limit,
    leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
  });
  const results: WorkflowQueueJobResult[] = [];

  for (const job of jobs) {
    const workflowRunId = String(job.payload.workflowRunId || "");
    if (!workflowRunId) {
      const error = "Workflow queue job is missing workflowRunId.";
      const failedJob = await failOperationJob(job.id, error);
      results.push({
        job: failedJob || job,
        status: "failed",
        error,
      });
      continue;
    }

    try {
      await appendWorkflowEvent(workflowRunId, "workflow.queue.leased", {
        jobId: job.id,
        attempt: job.attempt,
        leaseExpiresAt: job.leaseExpiresAt,
      }).catch(() => undefined);
      const detail = await tickWorkflowRun(workflowRunId);
      const completedJob = await completeOperationJob(job.id);
      let requeued: OperationJobRecord | undefined;

      if (runnableWorkflowStatuses.has(detail.run.status)) {
        requeued = await enqueueWorkflowRunTick(workflowRunId, "workflow_still_runnable", workflowJobPriority);
      }

      results.push({
        job: completedJob || job,
        workflowRunId,
        status: "completed",
        detail,
        requeued,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workflow queue job failed.";
      const failedJob = await failOperationJob(job.id, message);
      await appendWorkflowEvent(workflowRunId, "workflow.queue.failed", {
        jobId: job.id,
        error: message,
      }).catch(() => undefined);
      results.push({
        job: failedJob || job,
        workflowRunId,
        status: "failed",
        error: message,
      });
    }
  }

  return {
    requested: limit,
    leased: jobs.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    requeued: results.filter((result) => result.requeued).length,
    jobs: results,
  };
}

export function scheduleWorkflowQueueDrain(limit = WORKFLOW_DRAIN_LIMIT) {
  after(async () => {
    try {
      await processWorkflowQueue({
        limit,
        bootstrapQueuedRuns: false,
      });
    } catch (error) {
      console.warn("Workflow queue drain failed.", error instanceof Error ? error.message : error);
    }
  });
}

function workflowJobDedupeKey(workflowRunId: string) {
  return `workflow:${workflowRunId}`;
}
