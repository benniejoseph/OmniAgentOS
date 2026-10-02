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
  listActiveWorkflowTickRunIds,
  listRunnableWorkflowTenantIds,
  wakeOperationJobByDedupeKey,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import { requestWorkDeadline } from "@/lib/observability/request-timing";
import { redactSensitive } from "@/lib/security/context";
import { inspectWorkflowSpecialistDependencies } from "@/lib/subagents/context";
import { tickWorkflowRun } from "@/lib/workflows/runner";
import {
  appendWorkflowEvent,
  failWorkflowRunForQueueExhaustion,
  getWorkflowRun,
  getWorkflowRunExecutionAuthority,
  getWorkflowRunDetail,
  listRunnableWorkflowRuns,
  reclaimWorkflowRunForQueueDelivery,
  recordWorkflowSpecialistsPending,
  transitionWorkflowRunWithEvents,
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
  /** Epoch ms at which abortSignal fires, so model steps can end before it. */
  deadlineAt?: number;
  /**
   * Set when an earlier tick in the same pass already ran. A tick the
   * deadline then cuts short did not have the whole budget, so it keeps its
   * place in the queue; a tick that had the whole budget waits a second
   * instead, so one slow run cannot hold the head of the queue.
   */
  keepQueuePlaceOnDeadline?: boolean;
};

type WorkflowQueueJobResult = {
  job: OperationJobRecord;
  workflowRunId?: string;
  /** A waiting tick found its run still waiting on specialists and ran nothing. */
  status: "completed" | "failed" | "stale" | "waiting";
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
  /** Leased ticks that went back to the queue because their run still waits on specialists. */
  waiting: number;
  requeued: number;
  jobs: WorkflowQueueJobResult[];
};

export type AllTenantWorkflowQueueResult = WorkflowQueueResult & {
  tenantIds: string[];
  tenantResults: Array<{
    tenantId: string;
    result: WorkflowQueueResult;
    /** Why this tenant's queue failed; the pass went on to other tenants. */
    error?: string;
  }>;
};

const workflowJobPriority = 10;
const workflowJobMaxAttempts = 5;
const runnableWorkflowStatuses = new Set(["queued"]);
/** A tick whose run waits on specialists waits this long, doubling to the cap. */
const specialistWaitBaseSeconds = 15;
const specialistWaitMaxSeconds = 300;
/** A drain after a response leaves its ticks to the worker with less time than this. */
const minDrainRunwayMs = 5_000;

export async function enqueueWorkflowRunTick(
  workflowRunId: string,
  reason = "workflow_queued",
  priority = workflowJobPriority,
  tenantId?: string,
  options: {
    /**
     * Runs a tick that is waiting out a delay now. An enqueue alone keeps
     * a queued tick's run_at.
     */
    wake?: boolean;
  } = {},
) {
  const run = await getWorkflowRun(workflowRunId, { tenantId });
  const authorizedRetries = run?.input.budgetLimits?.retries ??
    workflowJobMaxAttempts - 1;
  let job = await enqueueOperationJob({
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
  if (options.wake) {
    const [woken] = await wakeOperationJobByDedupeKey(
      getWorkflowJobDedupeKey(workflowRunId),
      { tenantId: job.tenantId },
    );
    job = woken || job;
  }
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

/**
 * Enqueues a tick for each queued run that has none waiting or running. A run
 * whose tick waits out a backoff or runs under a lease already has its
 * delivery; enqueueing it again would reset that tick's retries or clear its
 * last error.
 */
export async function enqueueRunnableWorkflowRuns(limit = 50, options: { tenantId?: string } = {}) {
  const runnable = await listRunnableWorkflowRuns(limit, {
    ...options,
    excludeIds: await listActiveWorkflowTickRunIds(options),
  });
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
  input: {
    limit?: number;
    timeBudgetMs?: number;
    tenantIds?: readonly string[];
  } = {},
): Promise<AllTenantWorkflowQueueResult> {
  const limit = Math.min(Math.max(input.limit || WORKFLOW_DRAIN_LIMIT, 1), 10);
  const timeBudgetMs = Math.min(
    Math.max(Math.round(input.timeBudgetMs || 240_000), 1_000),
    240_000,
  );
  const deadlineAt = Date.now() + timeBudgetMs;
  const deadlineSignal = AbortSignal.timeout(timeBudgetMs);
  const tenantIds = input.tenantIds
    ? boundedDispatchTenantIds(input.tenantIds, limit)
    : await listRunnableWorkflowTenantIds(limit);
  const tenantResults: AllTenantWorkflowQueueResult["tenantResults"] = [];
  const jobs: WorkflowQueueJobResult[] = [];
  let remaining = limit;
  let activeTenantIds = tenantIds;
  let tickRan = false;

  while (remaining > 0 && activeTenantIds.length) {
    if (deadlineSignal.aborted) {
      break;
    }
    const nextActive: string[] = [];
    for (const tenantId of activeTenantIds) {
      if (remaining <= 0 || deadlineSignal.aborted) {
        break;
      }
      let result: WorkflowQueueResult;
      try {
        result = await processWorkflowQueue({
          tenantId,
          limit: 1,
          bootstrapQueuedRuns: true,
          abortSignal: deadlineSignal,
          deadlineAt,
          keepQueuePlaceOnDeadline: tickRan,
        });
      } catch (error) {
        // One tenant's failure must not end the pass for the others.
        const message = String(redactSensitive(
          error instanceof Error ? error.message : "Workflow queue failed.",
        )).slice(0, 500);
        console.error(JSON.stringify({
          level: "error",
          msg: "workflow_queue_tenant_failed",
          tenantId,
          error: message,
        }));
        tenantResults.push({
          tenantId,
          result: {
            requested: 1,
            leased: 0,
            completed: 0,
            failed: 0,
            stale: 0,
            waiting: 0,
            requeued: 0,
            jobs: [],
          },
          error: message,
        });
        continue;
      }
      if (result.leased > result.waiting) {
        tickRan = true;
      }
      tenantResults.push({ tenantId, result });
      jobs.push(...result.jobs);
      // A tick that went back to wait on specialists ran nothing, so it takes
      // none of the pass's limit and its tenant keeps its turn.
      remaining -= result.leased - result.waiting;
      if (result.leased > 0 && (result.requeued > 0 || result.waiting > 0)) {
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
    waiting: jobs.filter((result) => result.status === "waiting").length,
    requeued: jobs.filter((result) => result.requeued).length,
    jobs,
    tenantIds,
    tenantResults,
  };
}

function boundedDispatchTenantIds(tenantIds: readonly string[], limit: number) {
  return [...new Set(tenantIds.map((tenantId) => tenantId.trim()).filter(Boolean))]
    .slice(0, limit);
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
  let earlierTickRan = input.keepQueuePlaceOnDeadline === true;

  for (const job of jobs) {
    if (input.abortSignal?.aborted) {
      // It never started, so it keeps its place in the queue.
      const deferred = await deferOperationJob(
        job.id,
        job.leaseOwner || "",
        {
          tenantId: job.tenantId,
          keepRunAt: true,
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
    const keepQueuePlace = earlierTickRan;

    let leaseLost = false;
    try {
      const waiting = await deferWhileSpecialistsWork(job, workflowRunId);
      if (waiting) {
        results.push(waiting);
        continue;
      }
      earlierTickRan = true;
      const releasedFromQuarantine = job.payload.__workflowQuarantineReleased === true;
      if (job.attempt > 1 || releasedFromQuarantine) {
        const budgetDetail = await getWorkflowRunDetail(workflowRunId, {
          tenantId: job.tenantId,
        });
        if (budgetDetail) {
          const executionAuthority = budgetDetail.run.input.executionAuthorityRequired
            ? await getWorkflowRunExecutionAuthority(workflowRunId, {
                tenantId: job.tenantId,
              })
            : undefined;
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
                {
                  tenantId: job.tenantId,
                  events: [{
                    type: "step.failed",
                    payload: {
                      stepKey: budgetDetail.run.currentStep,
                      reason: "queue_redelivery_budget_exhausted",
                    },
                  }],
                  executionAuthority,
                },
              );
            }
            await transitionWorkflowRunWithEvents(
              workflowRunId,
              ["queued", "running"],
              {
                status: "failed",
                error: message,
                completedAt: new Date().toISOString(),
              },
              [{
                type: "workflow.budget_exhausted",
                payload: {
                  schemaVersion: 1,
                  dimension: error.dimension,
                  limit: error.limit,
                  attempted: error.attempted,
                  requiresAuthorization: true,
                  phase: "workflow.queue_redelivery",
                },
              }],
              { tenantId: job.tenantId, executionAuthority },
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
          releasedFromQuarantine,
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
          deadlineAt: input.deadlineAt,
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
            keepRunAt: keepQueuePlace,
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
    waiting: results.filter((result) => result.status === "waiting").length,
    requeued: results.filter((result) => result.requeued).length,
    jobs: results,
  };
}

/**
 * Sends a leased tick back to the queue while its run waits on durable
 * specialist tasks. A wait runs none of the run's work, so the tick's attempts
 * start over and it writes no queue events. It waits 15 seconds, doubling to
 * five minutes; the specialist worker wakes it when the last task finishes.
 * Returns undefined when the tick should run.
 */
async function deferWhileSpecialistsWork(
  job: OperationJobRecord,
  workflowRunId: string,
): Promise<WorkflowQueueJobResult | undefined> {
  const run = await getWorkflowRun(workflowRunId, { tenantId: job.tenantId });
  if (run?.status !== "queued") {
    return undefined;
  }
  const gate = await inspectWorkflowSpecialistDependencies({ run });
  if (gate.state !== "pending") {
    return undefined;
  }
  if (
    run.input.executionAuthorityRequired &&
    !(await getWorkflowRunExecutionAuthority(workflowRunId, {
      tenantId: job.tenantId,
    }))
  ) {
    // The runner fails the tick for its missing authority.
    return undefined;
  }
  await recordWorkflowSpecialistsPending(workflowRunId, gate.pendingTaskIds, {
    tenantId: job.tenantId,
  }).catch(() => undefined);
  const waits = specialistWaitCount(job.payload.specialistWaits);
  const deferred = await deferOperationJob(job.id, job.leaseOwner || "", {
    tenantId: job.tenantId,
    delaySeconds: Math.min(
      specialistWaitMaxSeconds,
      specialistWaitBaseSeconds * 2 ** waits,
    ),
    resetAttempts: true,
    payload: { specialistWaits: waits + 1 },
    reason: "Waiting for durable specialist tasks to finish.",
  });
  if (!deferred) {
    return {
      job,
      workflowRunId,
      status: "stale",
      error: "Workflow queue lease was stale before the tick could wait for specialists.",
    };
  }
  try {
    // A task that finished while this tick was leased found nothing to wake.
    // Wake the tick now rather than waiting out its delay; if this fails, the
    // delay still brings the tick back.
    const current = await inspectWorkflowSpecialistDependencies({ run });
    if (current.state !== "pending") {
      const [woken] = await wakeOperationJobByDedupeKey(
        getWorkflowJobDedupeKey(workflowRunId),
        { tenantId: job.tenantId },
      );
      if (woken) {
        return { job: woken, workflowRunId, status: "waiting", requeued: woken };
      }
    }
  } catch (error) {
    console.warn(
      "Workflow specialist re-check failed; the tick's delay will pick up the change.",
      error instanceof Error ? error.message : error,
    );
  }
  return { job: deferred, workflowRunId, status: "waiting" };
}

function specialistWaitCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : 0;
}

export function scheduleWorkflowQueueDrain(
  limit = WORKFLOW_DRAIN_LIMIT,
  tenantId?: string,
  options: { routeMaxDurationSeconds?: number } = {},
) {
  const scopedTenantId =
    tenantId ||
    getDatabaseTenantContext() ||
    process.env.OMNIAGENT_DEFAULT_TENANT ||
    "default";
  // after() runs only within the route's limit, counted from the request's start.
  const deadlineAt = requestWorkDeadline(options.routeMaxDurationSeconds);
  after(async () => {
    try {
      await drainWorkflowQueue({ tenantId: scopedTenantId, limit, deadlineAt });
    } catch (error) {
      console.warn("Workflow queue drain failed.", error instanceof Error ? error.message : error);
    }
  });
}

/**
 * Runs up to `limit` queued ticks one at a time, starting each only while at
 * least five seconds are left before `deadlineAt`. A tick the deadline cuts
 * short goes back to the queue without spending a retry, and ticks not yet
 * leased stay queued for the worker instead of stranding on a lease when the
 * platform stops the function.
 */
export async function drainWorkflowQueue(input: {
  tenantId: string;
  limit: number;
  deadlineAt: number;
}) {
  const limit = Math.min(Math.max(input.limit || WORKFLOW_DRAIN_LIMIT, 1), 10);
  const abortSignal = AbortSignal.timeout(Math.max(1, input.deadlineAt - Date.now()));
  for (let drained = 0; drained < limit; drained += 1) {
    if (abortSignal.aborted || input.deadlineAt - Date.now() < minDrainRunwayMs) {
      return;
    }
    const result = await processWorkflowQueue({
      tenantId: input.tenantId,
      limit: 1,
      bootstrapQueuedRuns: false,
      abortSignal,
      deadlineAt: input.deadlineAt,
      // No drain after a response has a worker's whole budget, so a tick it
      // cuts short keeps its place in the queue.
      keepQueuePlaceOnDeadline: true,
    });
    if (!result.leased) {
      return;
    }
  }
}

export function getWorkflowJobDedupeKey(workflowRunId: string) {
  return `workflow:${workflowRunId}`;
}
