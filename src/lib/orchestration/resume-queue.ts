import { after } from "next/server";
import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import {
  getSql,
  runWithDatabaseActorScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import {
  completeOperationJob,
  deferOperationJob,
  failOperationJob,
  getAgentResumeJobDedupeKey,
  heartbeatOperationJob,
  leaseOperationJobByDedupeKey,
  leaseOperationJobs,
  listRunnableAgentResumeTenantIds,
  wakeOperationJobByDedupeKey,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  CheckpointResumeInterruptedError,
  rejectAgentRunApproval,
  resumeAgentRunAfterToolApproval,
} from "@/lib/orchestration/agent-runner";
import { syncMissionExecutorSafely } from "@/lib/missions/runtime";
import { requestWorkDeadline } from "@/lib/observability/request-timing";
import { parseApprovalCheckpointShadowEnrollment } from "@/lib/runs/approval-checkpoint-shadow";
import { LEGACY_AGENT_RUN_BUDGET_LIMITS } from "@/lib/runs/budgets";
import {
  authorizeLatestAgentRunCheckpointResume,
  heartbeatRunCheckpointResumeClaim,
  type AuthorizeRunCheckpointResumeResult,
} from "@/lib/runs/checkpoint-resume-claim";
import type { RunCheckpointWriterSql } from "@/lib/runs/checkpoint-store";
import {
  failAgentRun,
  getAgentRun,
  type AgentRunResumeFence,
} from "@/lib/runs/store";
import type { AgentRunContinuation } from "@/lib/runs/types";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { getToolExecution } from "@/lib/tools/audit-store";

type AgentResumeJobResult = {
  job: OperationJobRecord;
  status: "completed" | "deferred" | "failed" | "stale";
  agentRunId?: string;
  executionId?: string;
  message?: string;
};

type ApprovedToolExecution = Parameters<
  typeof resumeAgentRunAfterToolApproval
>[0]["toolExecution"];

export type ApprovalRequestResumeResult =
  | { status: "leased"; result: AgentResumeJobResult }
  | { status: "unqueued"; resumed: boolean }
  | { status: "busy" };

// Every approval decision wakes its resume job, so this poll is only a
// backstop for decisions that land while a worker holds the job's lease or
// that are recorded elsewhere, such as an approval expiring.
export const PENDING_APPROVAL_RESUME_POLL_SECONDS = 300;
const UNRESOLVED_TOOL_RESUME_POLL_SECONDS = 30;
const APPROVAL_REQUEST_LEASE_ATTEMPTS = 20;
const APPROVAL_REQUEST_LEASE_RETRY_MS = 250;

export type AgentResumeQueueResult = {
  requested: number;
  scheduled?: number;
  leased: number;
  completed: number;
  deferred: number;
  failed: number;
  stale: number;
  jobs: AgentResumeJobResult[];
};

/** Leaves the worker response free while one leased continuation runs. */
export function scheduleAgentResumeQueueDrain(input: {
  tenantId: string;
  routeMaxDurationSeconds: number;
}): AgentResumeQueueResult {
  const deadlineAt = requestWorkDeadline(input.routeMaxDurationSeconds);
  after(async () => {
    try {
      await processAgentResumeQueue({
        tenantId: input.tenantId,
        limit: 1,
        deadlineAt,
      });
    } catch {
      console.warn("Agent resume queue drain failed; the durable job remains recoverable.");
    }
  });
  return {
    requested: 1,
    scheduled: 1,
    leased: 0,
    completed: 0,
    deferred: 0,
    failed: 0,
    stale: 0,
    jobs: [],
  };
}

export async function processAgentResumeQueue({
  tenantId,
  limit = 1,
  deadlineAt,
}: {
  tenantId: string;
  limit?: number;
  deadlineAt?: number;
}): Promise<AgentResumeQueueResult> {
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 10);
  return runWithDatabaseTenantScope(tenantId, async () => {
    const jobs = await leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      limit: boundedLimit,
      leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
    });
    const results: AgentResumeJobResult[] = [];

    for (const job of jobs) {
      results.push(await processAgentResumeJob(job, { deadlineAt }));
    }

    return {
      requested: boundedLimit,
      leased: jobs.length,
      completed: results.filter((result) => result.status === "completed")
        .length,
      deferred: results.filter((result) => result.status === "deferred").length,
      failed: results.filter((result) => result.status === "failed").length,
      stale: results.filter((result) => result.status === "stale").length,
      jobs: results,
    };
  });
}

export async function processAllTenantAgentResumeQueues({
  limit = 5,
  timeBudgetMs = 240_000,
  tenantIds: dispatchTenantIds,
}: {
  limit?: number;
  timeBudgetMs?: number;
  tenantIds?: readonly string[];
} = {}) {
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 10);
  const deadline = Date.now() + Math.min(
    Math.max(Math.round(timeBudgetMs), 1_000),
    240_000,
  );
  const tenantIds = dispatchTenantIds
    ? boundedDispatchTenantIds(dispatchTenantIds, boundedLimit)
    : await listRunnableAgentResumeTenantIds(boundedLimit);
  const tenantResults: Array<{
    tenantId: string;
    result: AgentResumeQueueResult;
  }> = [];
  for (const tenantId of tenantIds) {
    if (Date.now() >= deadline) {
      break;
    }
    tenantResults.push({
      tenantId,
      result: await processAgentResumeQueue({ tenantId, limit: 1 }),
    });
  }
  return {
    tenantIds,
    tenantResults,
    leased: tenantResults.reduce(
      (total, item) => total + item.result.leased,
      0,
    ),
    completed: tenantResults.reduce(
      (total, item) => total + item.result.completed,
      0,
    ),
    deferred: tenantResults.reduce(
      (total, item) => total + item.result.deferred,
      0,
    ),
    failed: tenantResults.reduce(
      (total, item) => total + item.result.failed,
      0,
    ),
  };
}

function boundedDispatchTenantIds(tenantIds: readonly string[], limit: number) {
  return [...new Set(tenantIds.map((tenantId) => tenantId.trim()).filter(Boolean))]
    .slice(0, limit);
}

/**
 * Resumes a run from the request that approved its pending tool call, so the
 * run can use that request's in-memory result, such as a This Mac screenshot
 * that is never persisted. The resume runs under the run's resume job lease;
 * without it the durable queue would lease the job while this resume is live,
 * see the run already resuming, and fail it as interrupted.
 *
 * - "leased": this request held the lease and processed the job.
 * - "busy": another owner holds a live lease and continues the run without
 *   the in-memory result.
 * - "unqueued": the run has no live resume job, as legacy runs don't, so it
 *   resumed directly.
 */
export async function resumeAgentRunInApprovalRequest({
  executionId,
  tenantId,
  toolExecution,
  leaseRetry = {},
  deadlineAt,
}: {
  executionId: string;
  tenantId: string;
  toolExecution: ApprovedToolExecution;
  leaseRetry?: { attempts?: number; delayMs?: number };
  deadlineAt?: number;
}): Promise<ApprovalRequestResumeResult> {
  const attempts = Math.max(
    1,
    Math.round(leaseRetry.attempts ?? APPROVAL_REQUEST_LEASE_ATTEMPTS),
  );
  const delayMs = Math.max(
    0,
    leaseRetry.delayMs ?? APPROVAL_REQUEST_LEASE_RETRY_MS,
  );
  return runWithDatabaseTenantScope(tenantId, async () => {
    for (let attempt = 1; ; attempt += 1) {
      const lease = await leaseOperationJobByDedupeKey(
        getAgentResumeJobDedupeKey(executionId),
        {
          tenantId,
          type: "agent.resume",
          leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
        },
      );
      if (lease.outcome === "leased") {
        return {
          status: "leased",
          result: await processAgentResumeJob(lease.job, {
            approvedToolExecution: toolExecution,
            deadlineAt,
          }),
        };
      }
      if (lease.outcome === "absent") {
        const outcome = await resumeAgentRunAfterToolApproval({
          executionId,
          toolExecution,
          tenantId,
        });
        return { status: "unqueued", resumed: outcome.resumed };
      }
      if (attempt >= attempts) {
        return { status: "busy" };
      }
      // A worker usually holds the lease only while it defers the job.
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  });
}

type ProcessAgentResumeJobOptions = {
  /** The approving request's own result for the job's tool execution. */
  approvedToolExecution?: ApprovedToolExecution;
  /** The request deadline includes the time spent before its response. */
  deadlineAt?: number;
};

async function processAgentResumeJob(
  job: OperationJobRecord,
  options: ProcessAgentResumeJobOptions = {},
): Promise<AgentResumeJobResult> {
  const agentRunId = String(job.payload.agentRunId || "");
  const executionId = String(job.payload.executionId || "");
  const base = { job, agentRunId, executionId };
  if (!agentRunId || !executionId) {
    return failResumeJob(job, "Agent resume job payload is incomplete.", base);
  }

  const actorId = String(job.payload.actorId || "").trim();
  if (!actorId) {
    return failResumeJob(
      job,
      "Agent resume job is missing its owner actor binding.",
      base,
    );
  }
  return runWithDatabaseActorScope(job.tenantId, [actorId], () =>
    processAgentResumeJobInActorScope(job, base, options)
  );
}

async function processAgentResumeJobInActorScope(
  job: OperationJobRecord,
  base: Pick<AgentResumeJobResult, "job" | "agentRunId" | "executionId">,
  options: ProcessAgentResumeJobOptions,
): Promise<AgentResumeJobResult> {
  const agentRunId = base.agentRunId || "";
  const executionId = base.executionId || "";

  try {
    const run = await getAgentRun(agentRunId, { tenantId: job.tenantId });
    if (!run) {
      return completeResumeJob(
        job,
        "Agent run no longer exists; continuation job retired.",
        base,
      );
    }
    if (["completed", "failed", "canceled"].includes(run.status)) {
      return completeResumeJob(
        job,
        `Agent run is already ${run.status}.`,
        base,
      );
    }
    if (!run.continuation) {
      return deferResumeJob(
        job,
        "Waiting for the agent continuation to become durable.",
        base,
      );
    }
    if (run.continuation.pendingToolCall.executionId !== executionId) {
      return completeResumeJob(
        job,
        "Agent run moved to a different continuation.",
        base,
      );
    }
    const checkpointCanary = isCheckpointCanary(run.continuation);
    if (run.status === "resuming" && !checkpointCanary) {
      const message =
        "Approved run resume was interrupted; side effects were not replayed.";
      const actorId = run.continuation.context.actorId;
      await failAgentRun(run.id, message, {
        tenantId: job.tenantId,
        executionScope: run.continuation.executionScope,
        runContractEnvelope: run.continuation.runContractEnvelope,
      });
      await syncMissionExecutorSafely({
        executorType: "agent_run",
        executorId: run.id,
        status: "failed",
        error: message,
      }, { tenantId: job.tenantId, actorId });
      return completeResumeJob(job, message, base);
    }

    const toolExecution = await getToolExecution(executionId, {
      tenantId: job.tenantId,
    });
    if (!toolExecution) {
      return deferResumeJob(
        job,
        "Waiting for the tool approval record to become visible.",
        base,
      );
    }
    if (toolExecution.status === "approval_required") {
      return deferPendingApprovalResumeJob(job, base);
    }
    if (toolExecution.status === "executing") {
      return deferResumeJob(
        job,
        "Waiting for the approved tool execution to finish.",
        base,
      );
    }
    if (toolExecution.status === "rejected") {
      await rejectAgentRunApproval({
        executionId,
        tenantId: job.tenantId,
        reason: toolExecution.approvalReason || toolExecution.reason,
      });
      return completeResumeJob(job, "Rejected continuation recorded.", base);
    }
    if (!["executed", "failed", "blocked"].includes(toolExecution.status)) {
      return failResumeJob(
        job,
        `Tool execution reached unsupported status ${toolExecution.status}.`,
        base,
      );
    }

    const savedBudget = run.continuation.budgetState;
    const remainingWallTimeMs = savedBudget
      ? Math.max(0, savedBudget.limits.wallTimeMs - savedBudget.used.wallTimeMs)
      : LEGACY_AGENT_RUN_BUDGET_LIMITS.wallTimeMs;
    if (
      options.deadlineAt !== undefined &&
      options.deadlineAt - Date.now() < remainingWallTimeMs + 30_000
    ) {
      return deferResumeJob(
        job,
        "Waiting for a delivery with enough time for the saved continuation budget.",
        base,
      );
    }

    let resumeFence: AgentRunResumeFence | undefined;
    if (checkpointCanary) {
      if (run.continuation.toolPolicy?.readOnly !== true) {
        return failResumeJob(
          job,
          "Checkpoint canary continuation exceeded its read-only boundary.",
          base,
        );
      }
      const executionScope = parsePersistedExecutionScope(
        run.continuation.executionScope,
      );
      if (!executionScope || executionScope.tenantId !== job.tenantId) {
        return failResumeJob(
          job,
          "Checkpoint canary continuation lost its execution scope.",
          base,
        );
      }
      if (!job.leaseOwner) {
        return { ...base, status: "stale", message: "Resume lease was stale." };
      }
      const authorization = await getSql().transaction(
        (sql: RunCheckpointWriterSql) =>
          authorizeLatestAgentRunCheckpointResume({
            tenantId: job.tenantId,
            runId: run.id,
            approvalExecutionId: executionId,
            operationJobId: job.id,
            leaseOwner: job.leaseOwner || "",
            leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
            executionScope,
          }, sql),
      ) as AuthorizeRunCheckpointResumeResult;
      if (authorization.outcome === "already_completed") {
        return completeResumeJob(
          job,
          "Checkpoint continuation was already committed.",
          base,
        );
      }
      if (authorization.outcome !== "authorized") {
        return deferResumeJob(
          job,
          `Checkpoint continuation paused: ${authorization.reason}.`,
          base,
        );
      }
      resumeFence = {
        claim: authorization.claim,
        executionScope,
      };
    }

    const controller = new AbortController();
    let leaseLost = false;
    let heartbeatChain = Promise.resolve();
    const heartbeat = async () => {
      try {
        const renewed = await heartbeatOperationJob(
          job.id,
          job.leaseOwner || "",
          {
            tenantId: job.tenantId,
            leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
          },
        );
        if (!renewed) {
          leaseLost = true;
          controller.abort(new Error("Agent resume queue lease was lost."));
          return;
        }
        if (resumeFence) {
          const claimRenewed = await getSql().transaction(
            (sql: RunCheckpointWriterSql) =>
              heartbeatRunCheckpointResumeClaim(
                {
                  ...resumeFence.claim,
                  leaseSeconds: OPERATION_QUEUE_LEASE_SECONDS,
                },
                sql,
              ),
          ) as boolean;
          if (!claimRenewed) {
            const settledRun = await getAgentRun(agentRunId, {
              tenantId: job.tenantId,
            });
            const settledByFencedWrite = Boolean(
              settledRun &&
              (
                ["completed", "failed", "canceled"].includes(
                  settledRun.status,
                ) ||
                (
                  settledRun.status === "waiting_approval" &&
                  settledRun.continuation?.pendingToolCall.executionId !==
                    executionId
                )
              ),
            );
            if (!settledByFencedWrite) {
              leaseLost = true;
              controller.abort(
                new Error("Checkpoint resume claim lease was lost."),
              );
            }
            return;
          }
        }
        const currentRun = await getAgentRun(agentRunId, {
          tenantId: job.tenantId,
        });
        if (!currentRun || currentRun.status === "canceled") {
          leaseLost = true;
          controller.abort(
            new Error(
              currentRun
                ? "Agent run was canceled by the operator."
                : "Agent run no longer exists.",
            ),
          );
        }
      } catch (error) {
        leaseLost = true;
        controller.abort(
          error instanceof Error
            ? error
            : new Error("Agent resume queue heartbeat failed."),
        );
      }
    };
    await heartbeat();
    if (leaseLost) {
      return { ...base, status: "stale", message: "Resume lease was stale." };
    }
    const timer = setInterval(() => {
      heartbeatChain = heartbeatChain.then(heartbeat, heartbeat);
    }, Math.max(
      1_000,
      Math.min(
        5_000,
        Math.floor((OPERATION_QUEUE_LEASE_SECONDS * 1_000) / 3),
      ),
    ));
    let outcome;
    try {
      outcome = await resumeAgentRunAfterToolApproval({
        executionId,
        tenantId: job.tenantId,
        toolExecution:
          options.approvedToolExecution?.record.id === executionId
            ? options.approvedToolExecution
            : {
                record: toolExecution,
                result: toolExecution.output,
                computerObservation: undefined,
              },
        abortSignal: controller.signal,
        resumeFence,
      });
    } finally {
      clearInterval(timer);
      await heartbeatChain;
    }
    if (leaseLost) {
      return {
        ...base,
        status: "stale",
        message: "Resume lease was lost before completion.",
      };
    }
    const outcomeReason = "reason" in outcome ? outcome.reason : undefined;
    const outcomeStatus = "status" in outcome ? outcome.status : undefined;
    if (!outcome.resumed) {
      const current = await getAgentRun(agentRunId, {
        tenantId: job.tenantId,
      });
      if (
        current &&
        !["completed", "failed", "canceled"].includes(current.status)
      ) {
        return deferResumeJob(
          job,
          outcomeReason || "Agent continuation is not ready.",
          base,
        );
      }
    }
    return completeResumeJob(
      job,
      outcome.resumed
        ? `Agent continuation ${outcomeStatus || "completed"}.`
        : outcomeReason || "Agent continuation was already resolved.",
      base,
    );
  } catch (error) {
    if (error instanceof CheckpointResumeInterruptedError) {
      return {
        ...base,
        status: "stale",
        message: "Checkpoint continuation was interrupted; its leases will expire for fenced recovery.",
      };
    }
    return failResumeJob(
      job,
      error instanceof Error ? error.message : "Agent resume job failed.",
      base,
    );
  }
}

function isCheckpointCanary(
  continuation: AgentRunContinuation,
): boolean {
  const enrollment = parseApprovalCheckpointShadowEnrollment(
    continuation.checkpointShadowEnrollment,
  );
  return Boolean(
    enrollment?.enginePin.rolloutMode === "canary",
  );
}

async function completeResumeJob(
  job: OperationJobRecord,
  message: string,
  base: Pick<AgentResumeJobResult, "agentRunId" | "executionId">,
): Promise<AgentResumeJobResult> {
  const completed = await completeOperationJob(
    job.id,
    job.leaseOwner,
    job.tenantId,
  );
  return {
    ...base,
    job: completed || job,
    status: completed ? "completed" : "stale",
    message,
  };
}

async function deferResumeJob(
  job: OperationJobRecord,
  message: string,
  base: Pick<AgentResumeJobResult, "agentRunId" | "executionId">,
  delaySeconds = UNRESOLVED_TOOL_RESUME_POLL_SECONDS,
): Promise<AgentResumeJobResult> {
  const deferred = await deferOperationJob(job.id, job.leaseOwner || "", {
    tenantId: job.tenantId,
    delaySeconds,
    reason: message,
  });
  return {
    ...base,
    job: deferred || job,
    status: deferred ? "deferred" : "stale",
    message,
  };
}

async function deferPendingApprovalResumeJob(
  job: OperationJobRecord,
  base: Pick<AgentResumeJobResult, "agentRunId" | "executionId">,
): Promise<AgentResumeJobResult> {
  const deferred = await deferResumeJob(
    job,
    "Waiting for the tool approval decision.",
    base,
    PENDING_APPROVAL_RESUME_POLL_SECONDS,
  );
  if (deferred.status !== "deferred" || !base.executionId) {
    return deferred;
  }
  // A decision that landed while this job was leased found nothing to wake.
  // Wake it now rather than waiting out the poll; if this fails, the poll
  // still picks the decision up.
  try {
    const current = await getToolExecution(base.executionId, {
      tenantId: job.tenantId,
    });
    if (current && current.status !== "approval_required") {
      const [woken] = await wakeOperationJobByDedupeKey(
        getAgentResumeJobDedupeKey(base.executionId),
        { tenantId: job.tenantId },
      );
      if (woken) {
        return {
          ...deferred,
          job: woken,
          message: "The tool approval was decided while the job was leased; the job was woken.",
        };
      }
    }
  } catch {
    console.warn("Agent resume approval re-check failed; the poll will pick up the decision.");
  }
  return deferred;
}

async function failResumeJob(
  job: OperationJobRecord,
  message: string,
  base: Pick<AgentResumeJobResult, "agentRunId" | "executionId">,
): Promise<AgentResumeJobResult> {
  const failed = await failOperationJob(
    job.id,
    message,
    job.leaseOwner,
    job.tenantId,
  );
  return {
    ...base,
    job: failed || job,
    status: failed ? "failed" : "stale",
    message,
  };
}
