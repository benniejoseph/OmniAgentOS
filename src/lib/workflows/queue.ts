import { after } from "next/server";
import { OPERATION_QUEUE_LEASE_SECONDS, WORKFLOW_DRAIN_LIMIT } from "@/lib/config";
import { RunBudgetExceededError } from "@/lib/runs/budgets";
import {
  getDatabaseTenantContext,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import {
  cancelOperationJobByDedupeKey,
  completeOperationJob,
  deferOperationJob,
  enqueueOperationJob,
  failOperationJob,
  heartbeatOperationJob,
  leaseOperationJobs,
  listRunnableWorkflowTenantIds,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import { tickWorkflowRun } from "@/lib/workflows/runner";
import {
  appendWorkflowEvent,
  failWorkflowRunForQueueExhaustion,
  getWorkflowRunDetail,
  listRunnableWorkflowRuns,
  reclaimWorkflowRunForQueueDelivery,
  transitionWorkflowRun,
  updateWorkflowStep,
} from "@/lib/workflows/store";
import { createWorkflowBudgetSession } from "@/lib/workflows/budgets";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

type ProcessWorkflowQueueInput = {
  limit?: number;
  workflowRunId?: string;
  bootstrapQueuedRuns?: boolean;
  tenantId?: string;
  abortSignal?: AbortSignal;
};

type WorkflowQueueJobResult = {
  job: OperationJobRecord;
  workflowRunId?: string;
  status: "completed" | "failed" | "stale";
  detail?: WorkflowRunDetail;
  error?: string;
  requeued?: OperationJobRecord;
};

export type WorkflowQueueResult = {
  requested: number;
  leased: number;
  completed: number;
  failed: number;
  stale: number;
  requeued: number;
  jobs: WorkflowQueueJobResult[];
};

export type AllTenantWorkflowQueueResult = WorkflowQueueResult & {
  tenantIds: string[];
  tenantResults: Array<{ tenantId: string; result: WorkflowQueueResult }>;
};

const workflowJobPriority = 10;
const workflowJobMaxAttempts = 5;
const runnableWorkflowStatuses = new Set(["queued"]);

export async function enqueueWorkflowRunTick(
  workflowRunId: string,
  reason = "workflow_queued",
  priority = workflowJobPriority,
  tenantId?: string,
) {
  const detail = await getWorkflowRunDetail(workflowRunId, { tenantId });
  const authorizedRetries = detail?.run.input.budgetLimits?.retries ??
    workflowJobMaxAttempts - 1;
  const job = await enqueueOperationJob({
    tenantId,
    type: "workflow.tick",
    dedupeKey: getWorkflowJobDedupeKey(workflowRunId),
    payload: {
      workflowRunId,
      reason,
    },
    priority,
    maxAttempts: Math.min(workflowJobMaxAttempts, 1 + authorizedRetries),
  });
  await appendWorkflowEvent(workflowRunId, "workflow.queue.enqueued", {
    jobId: job.id,
    reason,
    status: job.status,
    runAt: job.runAt,
  }).catch(() => undefined);
  return job;
}

export async function cancelWorkflowRunTick(
  workflowRunId: string,
  reason = "Workflow job canceled.",
  tenantId?: string,
) {
  const jobs = await cancelOperationJobByDedupeKey(
    getWorkflowJobDedupeKey(workflowRunId),
    reason,
    { tenantId },
  );
  if (jobs.length) {
    await appendWorkflowEvent(workflowRunId, "workflow.queue.canceled", {
      reason,
      jobIds: jobs.map((job) => job.id),
    }).catch(() => undefined);
  }
  return jobs;
}

export async function enqueueRunnableWorkflowRuns(limit = 50, options: { tenantId?: string } = {}) {
  const runnable = await listRunnableWorkflowRuns(limit, options);
  const jobs = [];
  for (const run of runnable) {
    jobs.push(await enqueueWorkflowRunTick(
      run.id,
      "queue_bootstrap",
      workflowJobPriority - 1,
      run.tenantId,
    ));
  }
  return jobs;
}

export function processWorkflowQueue(
  input: ProcessWorkflowQueueInput = {},
): Promise<WorkflowQueueResult> {
  const tenantId =
    input.tenantId ||
    getDatabaseTenantContext() ||
    process.env.OMNIAGENT_DEFAULT_TENANT ||
    "default";
  return runWithDatabaseTenantScope(tenantId, () =>
    processWorkflowQueueInScope({ ...input, tenantId }),
  );
}

export async function processAllTenantWorkflowQueues(
  input: { limit?: number; timeBudgetMs?: number } = {},
): Promise<AllTenantWorkflowQueueResult> {
  const limit = Math.min(Math.max(input.limit || WORKFLOW_DRAIN_LIMIT, 1), 10);
  const deadlineSignal = AbortSignal.timeout(
    Math.min(
      Math.max(Math.round(input.timeBudgetMs || 240_000), 1_000),
      240_000,
    ),
  );
  const tenantIds = await listRunnableWorkflowTenantIds(limit);
  const tenantResults: AllTenantWorkflowQueueResult["tenantResults"] = [];
  const jobs: WorkflowQueueJobResult[] = [];
  let remaining = limit;
  let activeTenantIds = tenantIds;

  while (remaining > 0 && activeTenantIds.length) {
    if (deadlineSignal.aborted) {
      break;
    }
    const nextActive: string[] = [];
    for (const tenantId of activeTenantIds) {
      if (remaining <= 0 || deadlineSignal.aborted) {
        break;
      }
      const result = await processWorkflowQueue({
        tenantId,
        limit: 1,
        bootstrapQueuedRuns: true,
        abortSignal: deadlineSignal,
      });
      tenantResults.push({ tenantId, result });
      jobs.push(...result.jobs);
      remaining -= result.leased;
      if (result.leased > 0 && result.requeued > 0) {
        nextActive.push(tenantId);
      }
    }
    if (nextActive.length === activeTenantIds.length && jobs.length === 0) {
      break;
    }
    activeTenantIds = nextActive;
  }

  return {
    requested: limit,
    leased: jobs.length,
    completed: jobs.filter((result) => result.status === "completed").length,
    failed: jobs.filter((result) => result.status === "failed").length,
    stale: jobs.filter((result) => result.status === "stale").length,
    requeued: jobs.filter((result) => result.requeued).length,
    jobs,
    tenantIds,
    tenantResults,
  };
}

async function processWorkflowQueueInScope(
  input: ProcessWorkflowQueueInput,
): Promise<WorkflowQueueResult> {
  const limit = Math.min(Math.max(input.limit || WORKFLOW_DRAIN_LIMIT, 1), 10);
  input.abortSignal?.throwIfAborted();

  if (input.workflowRunId) {
    await enqueueWorkflowRunTick(
      input.workflowRunId,
      "operator_tick",
      workflowJobPriority + 10,
      input.tenantId,
    );
  } else if (input.bootstrapQueuedRuns !== false) {
    await enqueueRunnableWorkflowRuns(50, { tenantId: input.tenantId });
  }

  const jobs = await leaseOperationJobs({
    type: "workflow.tick",
    dedupeKey: input.workflowRunId ? getWorkflowJobDedupeKey(input.workflowRunId) : undefined,
    limit,
    leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
    tenantId: input.tenantId,
  });
  const results: WorkflowQueueJobResult[] = [];

  for (const job of jobs) {
    if (input.abortSignal?.aborted) {
      const deferred = await deferOperationJob(
        job.id,
        job.leaseOwner || "",
        {
          tenantId: job.tenantId,
          delaySeconds: 1,
          reason: "Workflow queue tick reached its execution deadline.",
        },
      );
      results.push({
        job: deferred || job,
        status: "stale",
        requeued: deferred || undefined,
        error: "Workflow queue tick reached its execution deadline.",
      });
      continue;
    }
    const workflowRunId = String(job.payload.workflowRunId || "");
    if (!workflowRunId) {
      const error = "Workflow queue job is missing workflowRunId.";
      const failedJob = await failOperationJob(job.id, error, job.leaseOwner, job.tenantId);
      results.push({
        job: failedJob || job,
        status: failedJob ? "failed" : "stale",
        error,
      });
      continue;
    }

    let leaseLost = false;
    try {
      if (job.attempt > 1) {
        const budgetDetail = await getWorkflowRunDetail(workflowRunId, {
          tenantId: job.tenantId,
        });
        if (budgetDetail) {
          try {
            await createWorkflowBudgetSession(budgetDetail).reserve(
              { retries: 1 },
              { phase: "workflow.queue_redelivery" },
            );
          } catch (error) {
            if (!(error instanceof RunBudgetExceededError)) throw error;
            const message = `${error.message} The workflow stopped before queue redelivery; authorize a larger budget in a new run if needed.`;
            if (budgetDetail.run.currentStep) {
              await updateWorkflowStep(
                workflowRunId,
                budgetDetail.run.currentStep,
                {
                  status: "failed",
                  error: message,
                  completedAt: new Date().toISOString(),
                },
              );
            }
            await transitionWorkflowRun(
              workflowRunId,
              ["queued", "running"],
              {
                status: "failed",
                error: message,
                completedAt: new Date().toISOString(),
              },
              { tenantId: job.tenantId },
            );
            await appendWorkflowEvent(
              workflowRunId,
              "workflow.budget_exhausted",
              {
                schemaVersion: 1,
                dimension: error.dimension,
                limit: error.limit,
                attempted: error.attempted,
                requiresAuthorization: true,
                phase: "workflow.queue_redelivery",
              },
            );
            const completedJob = await completeOperationJob(
              job.id,
              job.leaseOwner,
              job.tenantId,
            );
            results.push({
              job: completedJob || job,
              workflowRunId,
              status: completedJob ? "completed" : "stale",
              detail: await getWorkflowRunDetail(workflowRunId, {
                tenantId: job.tenantId,
              }) || budgetDetail,
              error: message,
            });
            continue;
          }
        }
      }
      await appendWorkflowEvent(workflowRunId, "workflow.queue.leased", {
        jobId: job.id,
        attempt: job.attempt,
        leaseExpiresAt: job.leaseExpiresAt,
      }).catch(() => undefined);
      const controller = new AbortController();
      let heartbeatChain = Promise.resolve();
      const heartbeat = async () => {
        try {
          const renewed = await heartbeatOperationJob(job.id, job.leaseOwner || "", {
            tenantId: job.tenantId,
            leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
          });
          if (renewed) {
            return;
          }
          leaseLost = true;
          controller.abort(new Error("Workflow queue lease was lost."));
        } catch (error) {
          leaseLost = true;
          controller.abort(
            error instanceof Error ? error : new Error("Workflow queue lease heartbeat failed."),
          );
        }
      };
      await heartbeat();
      if (leaseLost) {
        results.push({
          job,
          workflowRunId,
          status: "stale",
          error: "Workflow queue lease was stale before execution started.",
        });
        continue;
      }
      if (job.attempt > job.maxAttempts) {
        const reason =
          "Workflow queue lease expired after its retry budget was exhausted.";
        await failWorkflowRunForQueueExhaustion(workflowRunId, {
          tenantId: job.tenantId,
          jobId: job.id,
          leaseOwner: job.leaseOwner || "",
          reason,
        });
        const completedJob = await completeOperationJob(
          job.id,
          job.leaseOwner,
          job.tenantId,
        );
        const detail = await tickWorkflowRun(workflowRunId, {
          tenantId: job.tenantId,
        });
        await appendWorkflowEvent(
          workflowRunId,
          "workflow.queue.retry_budget_exhausted",
          { jobId: job.id, attempt: job.attempt },
        ).catch(() => undefined);
        results.push({
          job: completedJob || job,
          workflowRunId,
          status: completedJob ? "completed" : "stale",
          detail,
          error: reason,
        });
        continue;
      }
      const reclaimDisposition = await reclaimWorkflowRunForQueueDelivery(
        workflowRunId,
        {
          tenantId: job.tenantId,
          jobId: job.id,
          leaseOwner: job.leaseOwner || "",
          deliveryAttempt: job.attempt,
        },
      );
      if (reclaimDisposition === "stale") {
        results.push({
          job,
          workflowRunId,
          status: "stale",
          error: "Workflow queue lease was stale during redelivery recovery.",
        });
        continue;
      }
      if (reclaimDisposition === "requeued") {
        await appendWorkflowEvent(
          workflowRunId,
          "workflow.queue.redelivery_reclaimed",
          { jobId: job.id, attempt: job.attempt },
        ).catch(() => undefined);
      }
      if (reclaimDisposition === "failed") {
        const completedJob = await completeOperationJob(
          job.id,
          job.leaseOwner,
          job.tenantId,
        );
        const detail = await tickWorkflowRun(workflowRunId, {
          tenantId: job.tenantId,
        });
        results.push({
          job: completedJob || job,
          workflowRunId,
          status: completedJob ? "completed" : "stale",
          detail,
          error:
            "Workflow retry budget was exhausted during redelivery recovery.",
        });
        continue;
      }
      const heartbeatTimer = setInterval(() => {
        heartbeatChain = heartbeatChain.then(heartbeat, heartbeat);
      }, Math.max(1_000, Math.min(5_000, Math.floor(OPERATION_QUEUE_LEASE_SECONDS * 1_000 / 3))));
      let detail: WorkflowRunDetail;
      try {
        const executionSignal = input.abortSignal
          ? AbortSignal.any([controller.signal, input.abortSignal])
          : controller.signal;
        detail = await tickWorkflowRun(workflowRunId, {
          tenantId: job.tenantId,
          abortSignal: executionSignal,
        });
      } finally {
        clearInterval(heartbeatTimer);
        await heartbeatChain;
      }
      if (detail.run.status === "running") {
        throw new Error(
          "Workflow remained running after its queue delivery completed.",
        );
      }
      const completedJob = leaseLost
        ? null
        : await completeOperationJob(job.id, job.leaseOwner, job.tenantId);
      if (!completedJob) {
        results.push({
          job,
          workflowRunId,
          status: "stale",
          detail,
          error: "Workflow queue job lease was stale before completion was recorded.",
        });
        continue;
      }
      let requeued: OperationJobRecord | undefined;

      if (runnableWorkflowStatuses.has(detail.run.status)) {
        requeued = await enqueueWorkflowRunTick(
          workflowRunId,
          "workflow_still_runnable",
          workflowJobPriority,
          job.tenantId,
        );
      }

      results.push({
        job: completedJob,
        workflowRunId,
        status: "completed",
        detail,
        requeued,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Workflow queue job failed.";
      if (input.abortSignal?.aborted && !leaseLost) {
        const deferred = await deferOperationJob(
          job.id,
          job.leaseOwner || "",
          {
            tenantId: job.tenantId,
            delaySeconds: 1,
            reason: "Workflow queue tick reached its execution deadline.",
          },
        );
        results.push({
          job: deferred || job,
          workflowRunId,
          status: "stale",
          requeued: deferred || undefined,
          error: message,
        });
        continue;
      }
      if (job.attempt >= job.maxAttempts) {
        await failWorkflowRunForQueueExhaustion(workflowRunId, {
          tenantId: job.tenantId,
          jobId: job.id,
          leaseOwner: job.leaseOwner || "",
          reason: `Workflow queue exhausted its retry budget: ${message}`,
        });
      }
      const failedJob = await failOperationJob(job.id, message, job.leaseOwner, job.tenantId);
      await appendWorkflowEvent(workflowRunId, "workflow.queue.failed", {
        jobId: job.id,
        error: message,
      }).catch(() => undefined);
      results.push({
        job: failedJob || job,
        workflowRunId,
        status: failedJob ? "failed" : "stale",
        error: message,
      });
    }
  }

  return {
    requested: limit,
    leased: jobs.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    stale: results.filter((result) => result.status === "stale").length,
    requeued: results.filter((result) => result.requeued).length,
    jobs: results,
  };
}

export function scheduleWorkflowQueueDrain(
  limit = WORKFLOW_DRAIN_LIMIT,
  tenantId?: string,
) {
  const scopedTenantId =
    tenantId ||
    getDatabaseTenantContext() ||
    process.env.OMNIAGENT_DEFAULT_TENANT ||
    "default";
  after(async () => {
    try {
      await processWorkflowQueue({
        limit,
        bootstrapQueuedRuns: false,
        tenantId: scopedTenantId,
      });
    } catch (error) {
      console.warn("Workflow queue drain failed.", error instanceof Error ? error.message : error);
    }
  });
}

export function getWorkflowJobDedupeKey(workflowRunId: string) {
  return `workflow:${workflowRunId}`;
}
