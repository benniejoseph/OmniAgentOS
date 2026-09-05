import { createHash } from "node:crypto";
import { z } from "zod";
import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import {
  runWithDatabaseActorScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { syncMissionExecutor } from "@/lib/missions/runtime";
import { recordMissionArtifact } from "@/lib/missions/store";
import { runAgent } from "@/lib/orchestration/agent-runner";
import {
  completeOperationJob,
  deferOperationJob,
  failOperationJob,
  getAgentExecuteJobDedupeKey,
  heartbeatOperationJob,
  leaseOperationJobs,
  listRunnableAgentExecuteTenantIds,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  AgentRunExecutionScopeBindingError,
  appendRunEvent,
  claimQueuedAgentRun,
  failAgentRun,
  getAgentRunExecutionScope,
  getAgentRun,
} from "@/lib/runs/store";
import {
  assertExecutionScopeTenant,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { inspectWorkflowSpecialistDependencies } from "@/lib/subagents/context";
import {
  durableSpecialistLabel,
  durableSpecialistProfile,
} from "@/lib/subagents/profiles";
import type { DurableSpecialistJobPayload } from "@/lib/subagents/types";
import { DURABLE_SPECIALIST_SCOPE_PURPOSE } from "@/lib/subagents/types";
import { enqueueWorkflowRunTick } from "@/lib/workflows/queue";
import { getWorkflowRunDetail } from "@/lib/workflows/store";

const specialistJobSchema = z.object({
  actorId: z.string().min(1).max(200),
  missionId: z.string().min(1).max(200),
  taskId: z.string().min(1).max(200),
  runId: z.string().min(1).max(200),
  agentId: z.enum(["atlas", "scout", "forge", "sentinel", "mnemosyne"]),
  requestId: z.string().min(1).max(200).optional(),
  delegationId: z.string().min(1).max(200).optional(),
  executionScope: z.unknown().optional(),
  workflowRunId: z.string().min(1).max(200).optional(),
  ready: z.boolean(),
  preparedAt: z.string().datetime(),
}).passthrough();

type SpecialistJobResult = {
  job: OperationJobRecord;
  runId?: string;
  status: "completed" | "failed" | "stale";
  message?: string;
};

export async function processDurableSpecialistQueue({
  tenantId,
  limit = 2,
  deadline,
}: {
  tenantId: string;
  limit?: number;
  /** Absolute epoch deadline. Work is aborted early enough to persist a terminal receipt. */
  deadline?: number;
}) {
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 2);
  if (deadline !== undefined && Date.now() >= deadline - 1_000) {
    return summarize([], boundedLimit);
  }
  return runWithDatabaseTenantScope(tenantId, async () => {
    const jobs = await leaseOperationJobs({
      tenantId,
      type: "agent.execute",
      limit: boundedLimit,
      leaseSeconds: Math.max(OPERATION_QUEUE_LEASE_SECONDS, 300),
    });
    const results = await Promise.all(
      jobs.map((job) => processSpecialistJobSafely(job, deadline)),
    );
    return summarize(results, boundedLimit);
  });
}

export async function processAllTenantDurableSpecialistQueues({
  limit = 4,
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
  const tenantIds = await listRunnableAgentExecuteTenantIds(boundedLimit);
  const tenantResults: Array<{
    tenantId: string;
    result: ReturnType<typeof summarize>;
  }> = [];
  let remaining = boundedLimit;
  for (const tenantId of tenantIds) {
    if (Date.now() >= deadline || remaining <= 0) break;
    const result = await processDurableSpecialistQueue({
      tenantId,
      limit: Math.min(remaining, 2),
      deadline,
    });
    tenantResults.push({ tenantId, result });
    remaining -= result.leased;
  }
  return {
    tenantIds,
    tenantResults,
    leased: tenantResults.reduce((sum, item) => sum + item.result.leased, 0),
    completed: tenantResults.reduce(
      (sum, item) => sum + item.result.completed,
      0,
    ),
    failed: tenantResults.reduce((sum, item) => sum + item.result.failed, 0),
    stale: tenantResults.reduce((sum, item) => sum + item.result.stale, 0),
  };
}

async function processSpecialistJob(
  job: OperationJobRecord,
  deadline?: number,
): Promise<SpecialistJobResult> {
  const parsed = specialistJobSchema.safeParse(job.payload);
  if (!parsed.success) {
    return failInfrastructureJob(job, "Durable specialist job payload is invalid.");
  }
  const payload = parsed.data as DurableSpecialistJobPayload;
  let executionScope = await specialistExecutionScope(
    payload,
    job.tenantId,
    payload.ready,
    job.dedupeKey,
  );
  if (!payload.ready) {
    const ageMs = Date.now() - Date.parse(payload.preparedAt);
    if (Number.isFinite(ageMs) && ageMs < 15 * 60_000) {
      const deferred = await deferOperationJob(
        job.id,
        job.leaseOwner || "",
        {
          tenantId: job.tenantId,
          delaySeconds: 5,
          reason: "Durable specialist intent is waiting for its parent workflow binding.",
        },
      );
      return {
        job: deferred || job,
        runId: payload.runId,
        status: "stale",
        message: "Specialist intent is not bound yet.",
      };
    }
    executionScope = await specialistExecutionScope(
      payload,
      job.tenantId,
      true,
      job.dedupeKey,
    );
    const abandoned = await getAgentRun(payload.runId, { tenantId: job.tenantId });
    if (abandoned && !["completed", "failed", "canceled"].includes(abandoned.status)) {
      const message = "Durable specialist initialization expired before a parent workflow was bound.";
      await failAgentRun(abandoned.id, message);
      await appendRunEvent(
        abandoned.id,
        { type: "error", message },
        { tenantId: job.tenantId, executionScope },
      );
      const terminal = await getAgentRun(abandoned.id, { tenantId: job.tenantId });
      if (terminal) return finalizeTerminalRun(job, payload, terminal);
    }
    return failInfrastructureJob(
      job,
      "Durable specialist initialization expired without a runnable parent workflow.",
      payload.runId,
    );
  }
  let run = await getAgentRun(payload.runId, { tenantId: job.tenantId });
  if (!run) {
    return failInfrastructureJob(job, "Durable specialist run no longer exists.", payload.runId);
  }
  if (run.agentId !== payload.agentId) {
    return failInfrastructureJob(job, "Durable specialist identity does not match its run.", payload.runId);
  }
  if (["completed", "failed", "canceled"].includes(run.status)) {
    return finalizeTerminalRun(job, payload, run);
  }
  if (run.status !== "queued") {
    const message =
      "A claimed durable specialist run was interrupted; it was not replayed.";
    await failAgentRun(run.id, message);
    await appendRunEvent(
      run.id,
      { type: "error", message },
      { tenantId: job.tenantId, executionScope },
    );
    run = (await getAgentRun(run.id, { tenantId: job.tenantId })) || run;
    return finalizeTerminalRun(job, payload, run);
  }

  const claimed = await claimQueuedAgentRun(run.id, { tenantId: job.tenantId });
  if (!claimed) {
    const raced = await getAgentRun(run.id, { tenantId: job.tenantId });
    if (!raced) {
      return failInfrastructureJob(job, "Durable specialist run disappeared during claim.", run.id);
    }
    return ["completed", "failed", "canceled"].includes(raced.status)
      ? finalizeTerminalRun(job, payload, raced)
      : interruptClaimedRun(job, payload, raced, executionScope);
  }
  run = claimed;

  await syncMissionExecutor({
    executorType: "agent_run",
    executorId: run.id,
    status: "running",
  }, { tenantId: job.tenantId, actorId: payload.actorId });

  const controller = new AbortController();
  const executionDeadline = Math.min(
    deadline ?? Date.now() + 240_000,
    Date.now() + 240_000,
  );
  const deadlineTimer = setTimeout(
    () => controller.abort(new Error("Durable specialist execution exceeded its worker deadline.")),
    Math.max(1, executionDeadline - Date.now() - 5_000),
  );
  let leaseLost = false;
  let heartbeatChain = Promise.resolve();
  const heartbeat = async () => {
    try {
      const renewed = await heartbeatOperationJob(job.id, job.leaseOwner || "", {
        tenantId: job.tenantId,
        leaseSeconds: Math.max(OPERATION_QUEUE_LEASE_SECONDS, 300),
      });
      const current = await getAgentRun(run.id, { tenantId: job.tenantId });
      if (renewed && current && current.status !== "canceled") return;
      leaseLost = true;
      controller.abort(new Error("Durable specialist lease or run was canceled."));
    } catch (error) {
      leaseLost = true;
      controller.abort(
        error instanceof Error
          ? error
          : new Error("Durable specialist heartbeat failed."),
      );
    }
  };
  await heartbeat();
  if (leaseLost) {
    clearTimeout(deadlineTimer);
    return { job, runId: run.id, status: "stale", message: "Specialist lease was stale." };
  }
  const timer = setInterval(() => {
    heartbeatChain = heartbeatChain.then(heartbeat, heartbeat);
  }, 5_000);

  try {
    const profile = durableSpecialistProfile(payload.agentId, run.mode);
    for await (const event of runAgent({
      preclaimedRunId: run.id,
      executionScope,
      mode: run.mode,
      messages: run.messages,
      tenantId: job.tenantId,
      actorId: payload.actorId,
      role: "operator",
      agentId: payload.agentId,
      specialistIds: [],
      agentProfile: profile,
    }, controller.signal)) {
      // runAgent owns event persistence; the worker only waits for a terminal receipt.
      void event;
    }
  } catch (error) {
    if (!leaseLost) {
      const message = error instanceof Error ? error.message : "Durable specialist execution failed.";
      const changed = await failAgentRun(run.id, message);
      if (changed) {
        await appendRunEvent(
          run.id,
          { type: "error", message },
          { tenantId: job.tenantId, executionScope },
        );
      }
    }
  } finally {
    clearTimeout(deadlineTimer);
    clearInterval(timer);
    await heartbeatChain;
  }
  if (leaseLost) {
    return { job, runId: run.id, status: "stale", message: "Specialist lease was lost before commit." };
  }
  const terminal = await getAgentRun(run.id, { tenantId: job.tenantId });
  if (!terminal) {
    return failInfrastructureJob(job, "Durable specialist run disappeared after execution.", run.id);
  }
  if (!["completed", "failed", "canceled"].includes(terminal.status)) {
    return interruptClaimedRun(job, payload, terminal, executionScope);
  }
  return finalizeTerminalRun(job, payload, terminal);
}

async function processSpecialistJobSafely(
  job: OperationJobRecord,
  deadline?: number,
): Promise<SpecialistJobResult> {
  const parsed = specialistJobSchema.safeParse(job.payload);
  const actorId = parsed.success ? parsed.data.actorId : undefined;
  if (actorId) {
    return runWithDatabaseActorScope(job.tenantId, [actorId], () =>
      processSpecialistJobSafelyInActorScope(job, deadline)
    );
  }
  return processSpecialistJobSafelyInActorScope(job, deadline);
}

async function processSpecialistJobSafelyInActorScope(
  job: OperationJobRecord,
  deadline?: number,
): Promise<SpecialistJobResult> {
  try {
    return await processSpecialistJob(job, deadline);
  } catch (error) {
    const message = error instanceof Error
      ? error.message
      : "Durable specialist queue delivery failed.";
    const parsed = specialistJobSchema.safeParse(job.payload);
    if (parsed.success) {
      const parsedPayload = parsed.data as DurableSpecialistJobPayload;
      const boundScope = await getAgentRunExecutionScope(parsedPayload.runId, {
        tenantId: job.tenantId,
      }).catch(() => undefined);
      const run = await getAgentRun(parsedPayload.runId, {
        tenantId: job.tenantId,
      }).catch(() => undefined);
      const invalidScope = error instanceof DurableSpecialistScopeError;
      const canonicalSpecialistRun = Boolean(
        run &&
        boundScope &&
        isCanonicalSpecialistRunBinding(
          boundScope,
          parsedPayload,
          job.dedupeKey,
        ) &&
        boundScope.executingPrincipalId === run.agentId &&
        run.id === parsedPayload.runId,
      );
      let failedRun = false;
      if (
        run &&
        !["completed", "failed", "canceled"].includes(run.status) &&
        (
          (invalidScope && canonicalSpecialistRun) ||
          (!invalidScope && run.status !== "queued")
        )
      ) {
        const interrupted =
          `Durable specialist delivery was interrupted and will not be replayed: ${message}`;
        const changed = await failAgentRun(run.id, interrupted).catch(() => false);
        failedRun = changed;
        if (changed && boundScope) {
          await appendRunEvent(
            run.id,
            { type: "error", message: interrupted },
            { tenantId: job.tenantId, executionScope: boundScope },
          ).catch(() => undefined);
        }
      }
      if (
        run &&
        invalidScope &&
        canonicalSpecialistRun &&
        boundScope?.initiatingActorId &&
        (failedRun || run.status === "failed")
      ) {
        await syncMissionExecutor({
          executorType: "agent_run",
          executorId: run.id,
          status: "failed",
          error: `Durable specialist scope validation failed: ${message}`,
        }, {
          tenantId: job.tenantId,
          actorId: boundScope.initiatingActorId,
        }).catch(() => undefined);
      }
    }
    return failInfrastructureJob(
      job,
      message,
      parsed.success ? parsed.data.runId : undefined,
    );
  }
}

async function interruptClaimedRun(
  job: OperationJobRecord,
  payload: DurableSpecialistJobPayload,
  run: NonNullable<Awaited<ReturnType<typeof getAgentRun>>>,
  executionScope?: ExecutionScope,
) {
  const message =
    "Durable specialist execution ended without a terminal receipt; it was not replayed.";
  const changed = await failAgentRun(run.id, message);
  if (changed) {
    await appendRunEvent(
      run.id,
      { type: "error", message },
      { tenantId: job.tenantId, executionScope },
    );
  }
  const terminal = (await getAgentRun(run.id, { tenantId: job.tenantId })) || run;
  return finalizeTerminalRun(job, payload, terminal);
}

class DurableSpecialistScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableSpecialistScopeError";
  }
}

async function specialistExecutionScope(
  payload: DurableSpecialistJobPayload,
  tenantId: string,
  requireRunBinding = true,
  jobDedupeKey?: string,
): Promise<ExecutionScope | undefined> {
  const hasScopedEnvelope = hasSpecialistScopeEnvelope(payload);
  if (!hasScopedEnvelope) {
    let boundScope: ExecutionScope | undefined;
    try {
      boundScope = await getAgentRunExecutionScope(payload.runId, { tenantId });
    } catch (error) {
      if (error instanceof AgentRunExecutionScopeBindingError) {
        throw new DurableSpecialistScopeError(error.message);
      }
      throw error;
    }
    if (boundScope) {
      if (!isCanonicalSpecialistRunBinding(
        boundScope,
        payload,
        jobDedupeKey,
      )) {
        throw new DurableSpecialistScopeError(
          "Durable specialist legacy envelope does not match its run binding.",
        );
      }
      return boundScope;
    }
    return undefined;
  }
  if (
    payload.executionScope === undefined ||
    payload.executionScope === null ||
    !payload.requestId ||
    !payload.delegationId
  ) {
    throw new DurableSpecialistScopeError(
      "Durable specialist execution scope is incomplete.",
    );
  }
  let scope: ExecutionScope | undefined;
  try {
    scope = parsePersistedExecutionScope(payload.executionScope);
  } catch {
    throw new DurableSpecialistScopeError(
      "Durable specialist execution scope is invalid.",
    );
  }
  if (!scope) {
    throw new DurableSpecialistScopeError(
      "Durable specialist execution scope is invalid.",
    );
  }
  try {
    assertExecutionScopeTenant(scope, tenantId);
  } catch {
    throw new DurableSpecialistScopeError(
      "Durable specialist execution scope has the wrong tenant.",
    );
  }
  if (
    scope.initiatingActorId !== payload.actorId ||
    scope.executingPrincipalType !== "agent" ||
    scope.executingPrincipalId !== payload.agentId ||
    scope.missionId !== payload.missionId ||
    scope.causationId !== payload.taskId ||
    scope.delegationId !== payload.delegationId ||
    scope.correlationId !== payload.requestId ||
    scope.purpose !== DURABLE_SPECIALIST_SCOPE_PURPOSE
  ) {
    throw new DurableSpecialistScopeError(
      "Durable specialist execution scope does not match its job.",
    );
  }
  if (!requireRunBinding) {
    return scope;
  }
  let boundScope: ExecutionScope | undefined;
  try {
    boundScope = await getAgentRunExecutionScope(payload.runId, { tenantId });
  } catch (error) {
    if (error instanceof AgentRunExecutionScopeBindingError) {
      throw new DurableSpecialistScopeError(error.message);
    }
    throw error;
  }
  if (!boundScope || !executionScopesEqual(boundScope, scope)) {
    throw new DurableSpecialistScopeError(
      "Durable specialist execution scope does not match its run binding.",
    );
  }
  return boundScope;
}

function hasSpecialistScopeEnvelope(
  payload: Pick<
    DurableSpecialistJobPayload,
    "executionScope" | "requestId" | "delegationId"
  >,
) {
  return payload.executionScope !== undefined ||
    payload.requestId !== undefined ||
    payload.delegationId !== undefined;
}

function isCanonicalSpecialistRunBinding(
  scope: ExecutionScope,
  payload: Pick<
    DurableSpecialistJobPayload,
    "actorId" | "agentId" | "missionId" | "runId" | "taskId"
  >,
  jobDedupeKey?: string,
) {
  return jobDedupeKey === getAgentExecuteJobDedupeKey(payload.runId) &&
    scope.initiatingActorId === payload.actorId &&
    scope.executingPrincipalType === "agent" &&
    scope.executingPrincipalId === payload.agentId &&
    scope.missionId === payload.missionId &&
    scope.causationId === payload.taskId &&
    Boolean(scope.delegationId) &&
    scope.purpose === DURABLE_SPECIALIST_SCOPE_PURPOSE;
}

async function finalizeTerminalRun(
  job: OperationJobRecord,
  payload: DurableSpecialistJobPayload,
  run: NonNullable<Awaited<ReturnType<typeof getAgentRun>>>,
): Promise<SpecialistJobResult> {
  const owner = { tenantId: job.tenantId, actorId: payload.actorId };
  if (run.status === "completed") {
    const response = (run.response || "").slice(0, 12_000);
    const label = durableSpecialistLabel(payload.agentId);
    await recordMissionArtifact({
      ...owner,
      missionId: payload.missionId,
      taskId: payload.taskId,
      sourceKey: `subagent:${run.id}:result`,
      kind: "specialist_result",
      title: `${label.name} · durable findings`,
      mimeType: "text/plain",
      data: {
        agentId: payload.agentId,
        response,
        responseLength: run.response?.length || 0,
        responseSha256: createHash("sha256").update(run.response || "").digest("hex"),
      },
    });
  }
  const missionStatus = run.status === "completed"
    ? "succeeded"
    : run.status === "canceled"
      ? "canceled"
      : "failed";
  await syncMissionExecutor({
    executorType: "agent_run",
    executorId: run.id,
    status: missionStatus,
    output: run.status === "completed"
      ? {
          agentId: payload.agentId,
          responseLength: run.response?.length || 0,
          responseSha256: createHash("sha256").update(run.response || "").digest("hex"),
        }
      : undefined,
    error: run.status === "failed" ? run.error : undefined,
  }, owner);

  if (payload.workflowRunId) {
    const workflow = await getWorkflowRunDetail(payload.workflowRunId, {
      tenantId: job.tenantId,
    });
    if (workflow && workflow.run.status === "queued") {
      const gate = await inspectWorkflowSpecialistDependencies(workflow);
      if (gate.state !== "pending") {
        await enqueueWorkflowRunTick(
          workflow.run.id,
          gate.state === "ready"
            ? "specialist_dependencies_ready"
            : "specialist_dependency_failed",
          20,
          job.tenantId,
        );
      }
    }
  }

  const completed = await completeOperationJob(
    job.id,
    job.leaseOwner,
    job.tenantId,
  );
  return {
    job: completed || job,
    runId: run.id,
    status: completed ? (run.status === "completed" ? "completed" : "failed") : "stale",
    message: run.error,
  };
}

async function failInfrastructureJob(
  job: OperationJobRecord,
  message: string,
  runId?: string,
): Promise<SpecialistJobResult> {
  const failed = await failOperationJob(
    job.id,
    message,
    job.leaseOwner,
    job.tenantId,
  );
  return {
    job: failed || job,
    runId,
    status: failed?.status === "failed" ? "failed" : failed ? "stale" : "stale",
    message,
  };
}

function summarize(results: SpecialistJobResult[], requested: number) {
  return {
    requested,
    leased: results.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    stale: results.filter((result) => result.status === "stale").length,
    jobs: results,
  };
}
