import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
import {
  completeOperationJob,
  deferOperationJob,
  failOperationJob,
  heartbeatOperationJob,
  leaseOperationJobs,
  listRunnableAgentResumeTenantIds,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  rejectAgentRunApproval,
  resumeAgentRunAfterToolApproval,
} from "@/lib/orchestration/agent-runner";
import { syncMissionExecutorSafely } from "@/lib/missions/runtime";
import {
  appendRunEvent,
  failAgentRun,
  getAgentRun,
} from "@/lib/runs/store";
import { getToolExecution } from "@/lib/tools/audit-store";

type AgentResumeJobResult = {
  job: OperationJobRecord;
  status: "completed" | "deferred" | "failed" | "stale";
  agentRunId?: string;
  executionId?: string;
  message?: string;
};

export type AgentResumeQueueResult = {
  requested: number;
  leased: number;
  completed: number;
  deferred: number;
  failed: number;
  stale: number;
  jobs: AgentResumeJobResult[];
};

export async function processAgentResumeQueue({
  tenantId,
  limit = 1,
}: {
  tenantId: string;
  limit?: number;
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
      results.push(await processAgentResumeJob(job));
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
}: {
  limit?: number;
  timeBudgetMs?: number;
} = {}) {
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 10);
  const deadline = Date.now() + Math.min(
    Math.max(Math.round(timeBudgetMs), 1_000),
    240_000,
  );
  const tenantIds = await listRunnableAgentResumeTenantIds(boundedLimit);
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

async function processAgentResumeJob(
  job: OperationJobRecord,
): Promise<AgentResumeJobResult> {
  const agentRunId = String(job.payload.agentRunId || "");
  const executionId = String(job.payload.executionId || "");
  const base = { job, agentRunId, executionId };
  if (!agentRunId || !executionId) {
    return failResumeJob(job, "Agent resume job payload is incomplete.", base);
  }

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
    if (run.status === "resuming") {
      const message =
        "Approved run resume was interrupted; side effects were not replayed.";
      const actorId = run.continuation.context.actorId;
      await failAgentRun(run.id, message);
      await appendRunEvent(run.id, { type: "error", message });
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
    if (["approval_required", "executing"].includes(toolExecution.status)) {
      return deferResumeJob(
        job,
        "Waiting for the tool approval decision to finish.",
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
        toolExecution: {
          record: toolExecution,
          result: toolExecution.output,
        },
        abortSignal: controller.signal,
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
    return failResumeJob(
      job,
      error instanceof Error ? error.message : "Agent resume job failed.",
      base,
    );
  }
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
): Promise<AgentResumeJobResult> {
  const deferred = await deferOperationJob(job.id, job.leaseOwner || "", {
    tenantId: job.tenantId,
    delaySeconds: 30,
    reason: message,
  });
  return {
    ...base,
    job: deferred || job,
    status: deferred ? "deferred" : "stale",
    message,
  };
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
