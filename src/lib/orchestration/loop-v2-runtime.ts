import { z } from "zod";

import {
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
  type LoopV2EnginePin,
} from "@/lib/orchestration/loop-v2";
import {
  finalizeLoopV2Run,
  recordLoopV2Checkpoint,
  type LoopV2CheckpointWriterSql,
} from "@/lib/orchestration/loop-v2-store";
import type {
  AgentEvent,
  AgentMode,
  ChatMessage,
} from "@/lib/orchestration/types";
import {
  getCurrentTenantCapabilityRollout,
} from "@/lib/rollouts/tenant-capability-rollouts";
import {
  appendRunEvent,
  bindAgentRunExecutionScope,
  createAgentRun,
  failAgentRun,
} from "@/lib/runs/store";
import { redactSensitive } from "@/lib/security/context";
import {
  deriveExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { appendThreadTurn } from "@/lib/threads/store";
import {
  executeGovernedTool,
  governedToolOperationClass,
  type GovernedToolExecutionResult,
} from "@/lib/tools/executor";
import { getGovernedTool } from "@/lib/tools/registry";

const LOOP_V2_LIST_INPUT = Object.freeze({ limit: 6 });
const LOOP_V2_RESULT_LIMIT = 5;

const recentRunSchema = z.object({
  id: z.string().min(1).max(240),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "resuming",
    "completed",
    "failed",
    "canceled",
  ]),
  prompt: z.string().max(30_000),
  agentId: z.string().max(120).optional(),
  startedAt: z.string().datetime({ offset: true }),
  completedAt: z.string().datetime({ offset: true }).optional(),
}).passthrough();

const runsListResultSchema = z.object({
  runs: z.array(recentRunSchema).max(6),
}).strict();

export type LoopV2ReadOnlyCanaryEnrollment = Readonly<{
  enginePin: LoopV2EnginePin;
}>;

export type LoopV2ReadOnlyCanaryCandidate = Readonly<{
  tenantId: string;
  message: string;
  mode: AgentMode;
  route: "direct" | "durable_workflow" | "clarify";
  requiresApproval: boolean;
  requestUsesMessageField: boolean;
  requestedAgentId?: string;
  requestedSpecialistIds?: readonly string[];
  missionId?: string;
  contextEvidenceIds?: readonly string[];
}>;

export type LoopV2ReadOnlyCanaryRequest = Readonly<{
  message: string;
  messages: readonly ChatMessage[];
  mode: AgentMode;
  threadId?: string;
  agentId: string;
  securityContext: SecurityContext;
  executionScope: ExecutionScope;
  enrollment: LoopV2ReadOnlyCanaryEnrollment;
}>;

export type LoopV2RuntimeDependencies = Readonly<{
  createRun: typeof createAgentRun;
  bindRunScope: typeof bindAgentRunExecutionScope;
  appendEvent: typeof appendRunEvent;
  appendAssistantTurn: typeof appendThreadTurn;
  executeTool: typeof executeGovernedTool;
  persistCheckpoint: typeof persistCheckpoint;
  finalizeRun: typeof persistTerminalCheckpoint;
  failUncheckpointedRun: typeof failAgentRun;
}>;

const runtimeDependencies: LoopV2RuntimeDependencies = Object.freeze({
  createRun: createAgentRun,
  bindRunScope: bindAgentRunExecutionScope,
  appendEvent: appendRunEvent,
  appendAssistantTurn: appendThreadTurn,
  executeTool: executeGovernedTool,
  persistCheckpoint,
  finalizeRun: persistTerminalCheckpoint,
  failUncheckpointedRun: failAgentRun,
});

export function isLoopV2ReadOnlyCanaryCandidate(
  input: LoopV2ReadOnlyCanaryCandidate,
) {
  return Boolean(
    hasDatabaseUrl() &&
      input.tenantId.trim() &&
      input.mode === "orchestrate" &&
      input.route === "direct" &&
      !input.requiresApproval &&
      input.requestUsesMessageField &&
      (!input.requestedAgentId || input.requestedAgentId === "atlas") &&
      !input.requestedSpecialistIds?.length &&
      !input.missionId &&
      !input.contextEvidenceIds?.length &&
      isRecentRunsIntent(input.message),
  );
}

export async function resolveLoopV2ReadOnlyCanaryEnrollment(
  input: LoopV2ReadOnlyCanaryCandidate,
  getRollout: typeof getCurrentTenantCapabilityRollout =
    getCurrentTenantCapabilityRollout,
): Promise<LoopV2ReadOnlyCanaryEnrollment | null> {
  if (!isLoopV2ReadOnlyCanaryCandidate(input)) return null;
  const rollout = await getRollout({
    tenantId: input.tenantId,
    capabilityId: LOOP_V2_CAPABILITY_ID,
  });
  if (!rollout) return null;
  try {
    return Object.freeze({ enginePin: buildLoopV2EnginePin(rollout) });
  } catch {
    return null;
  }
}

export async function* runLoopV2ReadOnlyCanary(
  request: LoopV2ReadOnlyCanaryRequest,
  abortSignal?: AbortSignal,
  dependencies: LoopV2RuntimeDependencies = runtimeDependencies,
): AsyncGenerator<AgentEvent> {
  const context = request.securityContext;
  const executionScope = request.executionScope;
  let run: Awaited<ReturnType<typeof createAgentRun>> | undefined;
  let current: LoopV2Checkpoint | undefined;

  const emit = async (event: AgentEvent) => {
    if (!run) throw new Error("Loop v2 cannot emit before creating its run.");
    await dependencies.appendEvent(run.id, event, {
      tenantId: context.tenantId,
      executionScope,
    });
    return event;
  };

  const transition = async (
    trigger: Parameters<typeof advanceLoopV2Checkpoint>[0]["trigger"],
    receipt: unknown,
  ) => {
    if (!current) throw new Error("Loop v2 transition has no root checkpoint.");
    const next = advanceLoopV2Checkpoint({
      current,
      executionScope,
      trigger,
      outputReceiptSha256: sourceContractSha256(receipt),
    });
    await dependencies.persistCheckpoint(next, executionScope);
    current = next;
    return next;
  };

  try {
    assertRuntimeRequest(request);
    throwIfAborted(abortSignal);
    run = await dependencies.createRun({
      tenantId: context.tenantId,
      actorId: context.actorId,
      threadId: request.threadId,
      mode: request.mode,
      prompt: request.message,
      messages: [...request.messages],
      model: LOOP_V2_ENGINE_VERSION_ID,
      agentId: request.agentId,
      specialistIds: [request.agentId],
    });
    await dependencies.bindRunScope(run.id, executionScope, {
      tenantId: context.tenantId,
    });
    const root = createInitialLoopV2Checkpoint({
      tenantId: context.tenantId,
      runId: run.id,
      ownerActorId: context.actorId,
      executionScope,
      enginePin: request.enrollment.enginePin,
    });
    await dependencies.persistCheckpoint(root, executionScope);
    current = root;

    yield await emit({ type: "run", runId: run.id, threadId: request.threadId });
    yield await emit({
      type: "status",
      label: "Loop v2 canary",
      detail: "Running one bounded read-only task through persisted checkpoints.",
    });

    await transition("plan_bound", {
      taskClass: "single_read_only_governed_tool",
      toolId: "runs.list",
      toolInputSha256: sourceContractSha256(LOOP_V2_LIST_INPUT),
      requestedOutcomeSha256: sourceContractSha256(
        normalizedRecentRunsIntent(request.message),
      ),
    });
    throwIfAborted(abortSignal);

    const callId = `${run.id}:runs.list:1`;
    const toolScope = deriveExecutionScope(executionScope, {
      causationId: callId,
      purpose: "agent.tool.execute",
    });
    await transition("action_started", {
      toolId: "runs.list",
      callIdSha256: sourceContractSha256(callId),
      operationClass: "read_only",
    });
    yield await emit({
      type: "tool",
      toolId: "runs.list",
      toolName: "List Runs",
      status: "running",
      riskLevel: 0,
    });

    let execution: GovernedToolExecutionResult | undefined;
    for (let attempt = 0; attempt <= 2; attempt += 1) {
      throwIfAborted(abortSignal);
      try {
        execution = await dependencies.executeTool({
          toolId: "runs.list",
          input: LOOP_V2_LIST_INPUT,
          dryRun: false,
          approved: false,
          context,
          abortSignal,
          idempotencyKey: callId,
          executionScope: toolScope,
        });
        break;
      } catch (error) {
        if (abortSignal?.aborted) throw error;
        if (attempt >= 2) throw error;
        await transition("retry_scheduled", {
          toolId: "runs.list",
          attempt: attempt + 1,
          failureSha256: sourceContractSha256(safeErrorMessage(error)),
          replaySafe: true,
        });
        yield await emit({
          type: "status",
          label: "Read retry scheduled",
          detail: `Retrying the bounded read (${attempt + 1}/2).`,
        });
      }
    }
    if (!execution) throw new Error("Loop v2 governed read returned no receipt.");
    throwIfAborted(abortSignal);
    if (execution.record.status !== "executed") {
      throw new Error(
        `Loop v2 governed read ended with ${execution.record.status}.`,
      );
    }
    await transition("action_succeeded", {
      executionId: execution.record.id,
      toolId: execution.record.toolId,
      status: execution.record.status,
      dryRun: execution.record.dryRun,
      riskLevel: execution.record.riskLevel,
      approvalRequired: execution.record.approvalRequired,
      resultSha256: sourceContractSha256(jsonCompatibleReceipt(execution.result)),
    });
    yield await emit({
      type: "tool",
      toolId: "runs.list",
      toolName: "List Runs",
      status: "executed",
      riskLevel: execution.record.riskLevel,
      dryRun: execution.record.dryRun,
      summary: execution.record.reason,
      executionId: execution.record.id,
    });

    const observed = runsListResultSchema.parse(execution.result);
    const recentRuns = observed.runs
      .filter((candidate) => candidate.id !== run?.id)
      .slice(0, LOOP_V2_RESULT_LIMIT);
    await transition("observation_recorded", {
      executionId: execution.record.id,
      observedCount: recentRuns.length,
      observedRunIdsSha256: sourceContractSha256(
        recentRuns.map((candidate) => candidate.id),
      ),
    });
    throwIfAborted(abortSignal);

    const tool = getGovernedTool("runs.list");
    const verified = Boolean(
      tool?.status === "active" &&
        tool.riskLevel === 0 &&
        !tool.approvalRequired &&
        governedToolOperationClass(tool, LOOP_V2_LIST_INPUT) === "read_only" &&
        execution.record.toolId === "runs.list" &&
        execution.record.status === "executed" &&
        execution.record.dryRun === false &&
        execution.record.riskLevel === 0 &&
        execution.record.approvalRequired === false &&
        execution.record.effectReceipt === undefined,
    );
    if (!verified) {
      throw new Error("Loop v2 read-only verification failed.");
    }
    const response = formatRecentRunsResponse(recentRuns);
    const terminal = advanceLoopV2Checkpoint({
      current,
      executionScope,
      trigger: "verification_passed",
      outputReceiptSha256: sourceContractSha256({
        executionId: execution.record.id,
        operationClass: "read_only",
        effectReceiptPresent: false,
        responseSha256: sourceContractSha256(response),
      }),
    });
    await dependencies.finalizeRun(
      terminal,
      executionScope,
      { response },
    );
    current = terminal;

    if (request.threadId) {
      await dependencies.appendAssistantTurn({
        tenantId: context.tenantId,
        threadId: request.threadId,
        runId: run.id,
        role: "assistant",
        content: response,
      }).catch((error: unknown) => {
        console.error(
          "Loop v2 assistant turn persistence failed.",
          safeErrorMessage(error),
        );
      });
    }
    await appendTerminalEventSafely(
      dependencies,
      run.id,
      { type: "done", response },
      context.tenantId,
      executionScope,
    );
    yield { type: "done", response };
  } catch (error) {
    const canceled = Boolean(abortSignal?.aborted);
    const message = canceled
      ? "Loop v2 run canceled after the client stopped the request."
      : safeErrorMessage(error);
    let terminalCommitted = current?.toState === "finish";
    if (run && current && current.toState !== "finish") {
      try {
        if (canceled) {
          const terminal = advanceLoopV2Checkpoint({
            current,
            executionScope,
            trigger: "canceled",
            outputReceiptSha256: sourceContractSha256({
              reason: "request_aborted",
            }),
          });
          await dependencies.finalizeRun(
            terminal,
            executionScope,
            { error: message },
          );
          current = terminal;
        } else {
          if (current.toState === "act") {
            await transition("action_failed", {
              failureSha256: sourceContractSha256(message),
            });
          } else if (current.toState === "verify") {
            await transition("verification_failed", {
              failureSha256: sourceContractSha256(message),
            });
          }
          const terminal = advanceLoopV2Checkpoint({
            current,
            executionScope,
            trigger: "budget_exhausted",
            outputReceiptSha256: sourceContractSha256({
              failureSha256: sourceContractSha256(message),
              retryCount: current.retryCount,
              replanCount: current.replanCount,
            }),
          });
          await dependencies.finalizeRun(
            terminal,
            executionScope,
            { error: message },
          );
          current = terminal;
        }
        terminalCommitted = true;
      } catch (terminalError) {
        console.error(
          "Loop v2 terminal checkpoint persistence failed.",
          safeErrorMessage(terminalError),
        );
      }
    }
    if (run && !terminalCommitted) {
      await dependencies.failUncheckpointedRun(run.id, message, {
        tenantId: context.tenantId,
      }).catch(() => undefined);
    }
    if (run) {
      const event: AgentEvent = canceled
        ? { type: "canceled", message }
        : { type: "error", message };
      await appendTerminalEventSafely(
        dependencies,
        run.id,
        event,
        context.tenantId,
        executionScope,
      );
      yield event;
      return;
    }
    throw error;
  }
}

function assertRuntimeRequest(request: LoopV2ReadOnlyCanaryRequest) {
  if (
    request.securityContext.tenantId !== request.executionScope.tenantId ||
    request.securityContext.actorId !==
      request.executionScope.initiatingActorId ||
    request.executionScope.executingPrincipalType !== "agent" ||
    request.executionScope.executingPrincipalId !== request.agentId ||
    request.executionScope.purpose !== "agent.loop.v2.read_only_canary" ||
    request.mode !== "orchestrate" ||
    request.agentId !== "atlas" ||
    !isRecentRunsIntent(request.message)
  ) {
    throw new Error("Loop v2 runtime request is outside the read-only canary.");
  }
}

function isRecentRunsIntent(value: string) {
  return /^(?:please )?(?:show|list|get)(?: me)?(?: my)? (?:recent|latest)(?: agent)? runs(?: please)?$/
    .test(normalizedRecentRunsIntent(value));
}

function normalizedRecentRunsIntent(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Loop v2 request was aborted.");
}

function formatRecentRunsResponse(
  runs: z.infer<typeof recentRunSchema>[],
) {
  if (!runs.length) return "I couldn't find any earlier agent runs.";
  const lines = runs.map((run, index) => {
    const prompt = safeSingleLine(run.prompt, 120) || "Untitled run";
    const startedAt = new Date(run.startedAt).toISOString();
    return `${index + 1}. ${run.status} — ${startedAt} — ${prompt}`;
  });
  return `Here are your most recent agent runs:\n\n${lines.join("\n")}`;
}

function safeSingleLine(value: unknown, maxChars: number) {
  return String(redactSensitive(value || ""))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxChars);
}

function safeErrorMessage(error: unknown) {
  return String(
    redactSensitive(
      error instanceof Error ? error.message : "Loop v2 execution failed.",
    ),
  ).slice(0, 1_000);
}

function jsonCompatibleReceipt(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Loop v2 tool output cannot be bound to a JSON receipt.");
  }
  return JSON.parse(serialized) as unknown;
}

async function persistCheckpoint(
  checkpoint: LoopV2Checkpoint,
  executionScope: ExecutionScope,
) {
  return runWithDatabaseActorScope(
    checkpoint.tenantId,
    [checkpoint.ownerActorId],
    () =>
      getSql().transaction(
        (sql: LoopV2CheckpointWriterSql) =>
          recordLoopV2Checkpoint({ checkpoint, executionScope }, sql),
      ) as Promise<Awaited<ReturnType<typeof recordLoopV2Checkpoint>>>,
  );
}

async function persistTerminalCheckpoint(
  checkpoint: LoopV2Checkpoint,
  executionScope: ExecutionScope,
  terminal: { response?: string; error?: string },
) {
  return runWithDatabaseActorScope(
    checkpoint.tenantId,
    [checkpoint.ownerActorId],
    () =>
      getSql().transaction(
        (sql: LoopV2CheckpointWriterSql) =>
          finalizeLoopV2Run({
            checkpoint,
            executionScope,
            ...terminal,
          }, sql),
      ) as Promise<Awaited<ReturnType<typeof finalizeLoopV2Run>>>,
  );
}

async function appendTerminalEventSafely(
  dependencies: LoopV2RuntimeDependencies,
  runId: string,
  event: AgentEvent,
  tenantId: string,
  executionScope: ExecutionScope,
) {
  try {
    await dependencies.appendEvent(runId, event, {
      tenantId,
      executionScope,
    });
  } catch (error) {
    console.error(
      "Loop v2 terminal event persistence failed.",
      safeErrorMessage(error),
    );
  }
}
