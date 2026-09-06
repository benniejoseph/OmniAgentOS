import {
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
} from "@/lib/db/client";
import { generateModelText } from "@/lib/models/gateway";
import type { ModelGenerationResult } from "@/lib/models/types";
import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
  LOOP_V2_MODEL_TEXT_INSTRUCTIONS,
  type LoopV2Checkpoint,
  type LoopV2EnginePin,
} from "@/lib/orchestration/loop-v2";
import {
  finalizeLoopV2Run,
  recordLoopV2Checkpoint,
  type LoopV2CheckpointWriterSql,
} from "@/lib/orchestration/loop-v2-store";
import {
  buildLoopV2PreExecutionRunContract,
  buildLoopV2TerminalRunContract,
  type LoopV2RunContractSnapshot,
} from "@/lib/orchestration/loop-v2-outcome";
import type { AgentEvent, AgentMode } from "@/lib/orchestration/types";
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
import type { ExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";
import {
  resolveRuntimeModelAssignment,
} from "@/lib/settings/runtime-models";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { appendThreadTurn } from "@/lib/threads/store";

const MODEL_TEXT_MIN_INPUT_CHARS = 80;
const MODEL_TEXT_MAX_INPUT_CHARS = 4_000;
const MODEL_TEXT_MAX_OUTPUT_CHARS = 4_000;
const MODEL_TEXT_MAX_OUTPUT_TOKENS = 256;
const MODEL_TEXT_MAX_PROVIDER_ATTEMPTS = 4;

export type LoopV2ModelTextEnrollment = Readonly<{
  enginePin: LoopV2EnginePin;
}>;

export type LoopV2ModelTextCandidate = Readonly<{
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
  resumeRunId?: string;
}>;

export type LoopV2ModelTextRequest = Readonly<{
  message: string;
  mode: AgentMode;
  threadId?: string;
  agentId: string;
  securityContext: SecurityContext;
  executionScope: ExecutionScope;
  enrollment: LoopV2ModelTextEnrollment;
}>;

export type LoopV2ModelTextDependencies = Readonly<{
  createRun: typeof createAgentRun;
  bindRunScope: typeof bindAgentRunExecutionScope;
  appendEvent: typeof appendRunEvent;
  appendAssistantTurn: typeof appendThreadTurn;
  resolveModelAssignment: typeof resolveRuntimeModelAssignment;
  generateText: typeof generateModelText;
  persistCheckpoint: typeof persistCheckpoint;
  finalizeRun: typeof persistTerminalCheckpoint;
  failUncheckpointedRun: typeof failAgentRun;
}>;

const runtimeDependencies: LoopV2ModelTextDependencies = Object.freeze({
  createRun: createAgentRun,
  bindRunScope: bindAgentRunExecutionScope,
  appendEvent: appendRunEvent,
  appendAssistantTurn: appendThreadTurn,
  resolveModelAssignment: resolveRuntimeModelAssignment,
  generateText: generateModelText,
  persistCheckpoint,
  finalizeRun: persistTerminalCheckpoint,
  failUncheckpointedRun: failAgentRun,
});

export function isLoopV2ModelTextCandidate(
  input: LoopV2ModelTextCandidate,
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
      !input.resumeRunId &&
      Boolean(parseSummaryRequest(input.message)),
  );
}

export async function resolveLoopV2ModelTextEnrollment(
  input: LoopV2ModelTextCandidate,
  getRollout: typeof getCurrentTenantCapabilityRollout =
    getCurrentTenantCapabilityRollout,
): Promise<LoopV2ModelTextEnrollment | null> {
  if (!isLoopV2ModelTextCandidate(input)) return null;
  const rollout = await getRollout({
    tenantId: input.tenantId,
    capabilityId: LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  });
  if (!rollout) return null;
  try {
    const enginePin = buildLoopV2EnginePin(rollout);
    return enginePin.capabilityId === LOOP_V2_MODEL_TEXT_CAPABILITY_ID
      ? Object.freeze({ enginePin })
      : null;
  } catch {
    return null;
  }
}

export async function* runLoopV2ModelText(
  request: LoopV2ModelTextRequest,
  abortSignal?: AbortSignal,
  dependencies: LoopV2ModelTextDependencies = runtimeDependencies,
): AsyncGenerator<AgentEvent> {
  const context = request.securityContext;
  const executionScope = request.executionScope;
  let runId: string | undefined;
  let current: LoopV2Checkpoint | undefined;
  let runContract: LoopV2RunContractSnapshot | undefined;

  const emit = async (event: AgentEvent) => {
    if (!runId) throw new Error("Loop v2 cannot emit before creating its run.");
    await dependencies.appendEvent(runId, event, {
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
    const summaryInput = assertRuntimeRequest(request);
    throwIfAborted(abortSignal);

    const run = await dependencies.createRun({
      tenantId: context.tenantId,
      actorId: context.actorId,
      threadId: request.threadId,
      mode: request.mode,
      prompt: request.message,
      messages: [{ role: "user", content: request.message }],
      model: LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
      agentId: request.agentId,
      specialistIds: [request.agentId],
    });
    runId = run.id;
    await dependencies.bindRunScope(runId, executionScope, {
      tenantId: context.tenantId,
    });
    const root = createInitialLoopV2Checkpoint({
      tenantId: context.tenantId,
      runId,
      ownerActorId: context.actorId,
      executionScope,
      enginePin: request.enrollment.enginePin,
    });
    runContract = buildLoopV2PreExecutionRunContract({
      rootCheckpoint: root,
      executionScope,
      requestSha256: sourceContractSha256(request.message),
      requestedOutcomeSha256: sourceContractSha256({
        taskClass: "bounded_user_text_summary",
        semanticCorrectness: "model_assertion",
      }),
      agentId: request.agentId,
    });
    await dependencies.persistCheckpoint(root, executionScope, runContract);
    current = root;

    yield await emit({ type: "run", runId, threadId: request.threadId });
    yield await emit({
      type: "status",
      label: "Loop v2 model canary",
      detail: "Running one bounded, tool-free summary through persisted checkpoints.",
    });

    const runtimeModel = await dependencies.resolveModelAssignment({
      tenantId: context.tenantId,
      actorId: context.actorId,
      scope: "main_agent",
      tier: "fast",
      requiredFeature: "text",
    });
    if (!runtimeModel.configured || !runtimeModel.provider || !runtimeModel.model) {
      throw new Error("No configured text model is available for Loop v2.");
    }
    const credentialSource = runtimeModel.source === "tenant_assignment"
      ? "tenant_vault" as const
      : "deployment_environment" as const;
    await transition("plan_bound", {
      taskClass: "bounded_user_text_summary",
      inputSha256: sourceContractSha256(summaryInput),
      inputChars: summaryInput.length,
      instructionsSha256: sourceContractSha256(
        LOOP_V2_MODEL_TEXT_INSTRUCTIONS,
      ),
      modelAssignmentScope: runtimeModel.scope,
      modelAssignmentSource: runtimeModel.source,
      assignmentId: runtimeModel.assignmentId || null,
      provider: runtimeModel.provider,
      model: runtimeModel.model,
      maxLogicalModelCalls: 1,
      maxProviderAttempts: MODEL_TEXT_MAX_PROVIDER_ATTEMPTS,
      maxOutputTokens: MODEL_TEXT_MAX_OUTPUT_TOKENS,
      contextEvidenceCount: 0,
      toolCount: 0,
    });
    throwIfAborted(abortSignal);

    const callId = `${runId}:model-text:1`;
    await transition("action_started", {
      callIdSha256: sourceContractSha256(callId),
      operation: "text_generation",
      provider: runtimeModel.provider,
      model: runtimeModel.model,
      credentialSource,
    });

    const modelRequest = runtimeModel.bind({
      input: summaryInput,
      instructions: LOOP_V2_MODEL_TEXT_INSTRUCTIONS,
      tier: "fast" as const,
      preferredProvider: runtimeModel.provider,
      allowedProviders: [runtimeModel.provider],
      allowCrossProviderFallback: false,
      maxOutputTokens: MODEL_TEXT_MAX_OUTPUT_TOKENS,
      abortSignal,
      usageScope: {
        tenantId: context.tenantId,
        actorId: context.actorId,
        sourceStreamId: `run:${runId}`,
        operation: "text_generation" as const,
        purpose: "agent.loop.v2.model_text",
        correlationId: executionScope.correlationId,
        causationId: callId,
        executionScope,
        assignmentId: runtimeModel.assignmentId,
        credentialSource,
      },
    });
    const generated = await dependencies.generateText(modelRequest);
    throwIfAborted(abortSignal);

    const response = String(redactSensitive(generated.text)).trim();
    await transition("action_succeeded", {
      provider: generated.provider,
      model: generated.model,
      attemptCount: generated.attempts.length,
      completedAttemptCount: generated.attempts.filter(
        (attempt) => attempt.status === "completed",
      ).length,
      usage: generated.usage,
      outputSha256: sourceContractSha256(response),
      usageReceiptRecorded: generated.usageReceiptRecorded === true,
      usageReceiptId: generated.usageReceiptId || null,
    });
    yield await emit(modelEvent(generated, runtimeModel.assignmentId, credentialSource));

    await transition("observation_recorded", {
      outputSha256: sourceContractSha256(response),
      outputChars: response.length,
      provider: generated.provider,
      model: generated.model,
      usage: generated.usage,
      attemptCount: generated.attempts.length,
    });
    throwIfAborted(abortSignal);

    const verificationFailure = modelVerificationFailure(generated, response);
    if (verificationFailure) throw new Error(verificationFailure);

    const terminal = advanceLoopV2Checkpoint({
      current,
      executionScope,
      trigger: "verification_passed",
      outputReceiptSha256: sourceContractSha256({
        responseSha256: sourceContractSha256(response),
        provider: generated.provider,
        model: generated.model,
        usageReceiptId: generated.usageReceiptId,
        maxOutputTokens: MODEL_TEXT_MAX_OUTPUT_TOKENS,
        toolCount: 0,
      }),
    });
    const terminalRunContract = buildLoopV2TerminalRunContract({
      preExecution: runContract,
      terminalCheckpoint: terminal,
      response,
    });
    await dependencies.finalizeRun(
      terminal,
      executionScope,
      { response, terminalRunContract },
    );
    current = terminal;

    if (request.threadId) {
      await dependencies.appendAssistantTurn({
        tenantId: context.tenantId,
        threadId: request.threadId,
        runId,
        role: "assistant",
        content: response,
      }).catch((error: unknown) => {
        console.error(
          "Loop v2 model assistant turn persistence failed.",
          safeErrorMessage(error),
        );
      });
    }
    yield { type: "delta", text: response };
    await appendTerminalEventSafely(
      dependencies,
      runId,
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
    if (runId && current && current.toState !== "finish") {
      try {
        let terminal: LoopV2Checkpoint;
        if (canceled) {
          terminal = advanceLoopV2Checkpoint({
            current,
            executionScope,
            trigger: "canceled",
            outputReceiptSha256: sourceContractSha256({
              reason: "request_aborted",
            }),
          });
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
          terminal = advanceLoopV2Checkpoint({
            current,
            executionScope,
            trigger: "budget_exhausted",
            outputReceiptSha256: sourceContractSha256({
              failureSha256: sourceContractSha256(message),
              retryCount: current.retryCount,
              replanCount: current.replanCount,
            }),
          });
        }
        await dependencies.finalizeRun(
          terminal,
          executionScope,
          {
            error: message,
            terminalRunContract: runContract
              ? buildLoopV2TerminalRunContract({
                  preExecution: runContract,
                  terminalCheckpoint: terminal,
                })
              : undefined,
          },
        );
        current = terminal;
        terminalCommitted = true;
      } catch (terminalError) {
        console.error(
          "Loop v2 model terminal checkpoint persistence failed.",
          safeErrorMessage(terminalError),
        );
      }
    }
    if (runId && !terminalCommitted) {
      await dependencies.failUncheckpointedRun(runId, message, {
        tenantId: context.tenantId,
      }).catch(() => undefined);
    }
    if (runId) {
      const event: AgentEvent = canceled
        ? { type: "canceled", message }
        : { type: "error", message };
      await appendTerminalEventSafely(
        dependencies,
        runId,
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

function assertRuntimeRequest(request: LoopV2ModelTextRequest) {
  const summaryInput = parseSummaryRequest(request.message);
  if (
    !summaryInput ||
    request.securityContext.tenantId !== request.executionScope.tenantId ||
    request.securityContext.actorId !==
      request.executionScope.initiatingActorId ||
    request.executionScope.executingPrincipalType !== "agent" ||
    request.executionScope.executingPrincipalId !== request.agentId ||
    request.executionScope.purpose !== "agent.loop.v2.model_text_canary" ||
    request.executionScope.contextGrantIds.length !== 0 ||
    request.executionScope.missionId !== null ||
    request.mode !== "orchestrate" ||
    request.agentId !== "atlas" ||
    request.enrollment.enginePin.capabilityId !==
      LOOP_V2_MODEL_TEXT_CAPABILITY_ID
  ) {
    throw new Error("Loop v2 runtime request is outside the model-text canary.");
  }
  return summaryInput;
}

function parseSummaryRequest(value: string) {
  const match = value.trim().match(
    /^summarize(?: this text)?:[ \t]*([\s\S]+)$/i,
  );
  const input = match?.[1]?.trim() || "";
  return input.length >= MODEL_TEXT_MIN_INPUT_CHARS &&
      input.length <= MODEL_TEXT_MAX_INPUT_CHARS
    ? input
    : undefined;
}

function modelVerificationFailure(
  generated: ModelGenerationResult,
  response: string,
) {
  const completed = generated.attempts.filter(
    (attempt) => attempt.status === "completed",
  );
  if (!response || response.length > MODEL_TEXT_MAX_OUTPUT_CHARS) {
    return "Loop v2 model output was empty or exceeded its character bound.";
  }
  if (
    generated.provider === "local" ||
    generated.attempts.length < 1 ||
    generated.attempts.length > MODEL_TEXT_MAX_PROVIDER_ATTEMPTS ||
    completed.length !== 1 ||
    completed[0].provider !== generated.provider ||
    completed[0].model !== generated.model
  ) {
    return "Loop v2 model provider receipt failed verification.";
  }
  if (
    generated.usage.outputTokens > MODEL_TEXT_MAX_OUTPUT_TOKENS ||
    generated.usageReceiptRecorded !== true ||
    !generated.usageReceiptId
  ) {
    return "Loop v2 model usage receipt failed verification.";
  }
  return undefined;
}

function modelEvent(
  generated: ModelGenerationResult,
  assignmentId: string | undefined,
  credentialSource: "tenant_vault" | "deployment_environment",
): AgentEvent {
  return {
    type: "model",
    provider: generated.provider,
    model: generated.model,
    tier: "fast",
    inputTokens: generated.usage.inputTokens,
    outputTokens: generated.usage.outputTokens,
    cachedInputTokens: generated.usage.cachedInputTokens,
    totalTokens: generated.usage.totalTokens,
    latencyMs: generated.latencyMs,
    fallbackUsed: generated.attempts.some(
      (attempt) => attempt.status === "failed",
    ),
    estimatedCostUsd: generated.estimatedCostUsd,
    costKnown: generated.costKnown,
    attemptCount: generated.attempts.length,
    failedAttemptCount: generated.attempts.filter(
      (attempt) => attempt.status === "failed",
    ).length,
    callReceipts: generated.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      status: attempt.status,
      usage: attempt.usage || {},
      latencyMs: attempt.latencyMs,
      estimatedCostUsd: attempt.estimatedCostUsd,
      providerRequestId: attempt.providerRequestId,
      failureKind: attempt.failureKind,
      retryable: attempt.retryable,
    })),
    assignmentId,
    credentialSource,
    providerRequestId: generated.providerRequestId,
    usageReceiptRecorded: generated.usageReceiptRecorded,
    usageReceiptId: generated.usageReceiptId,
  };
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("Loop v2 request was aborted.");
}

function safeErrorMessage(error: unknown) {
  return String(
    redactSensitive(
      error instanceof Error ? error.message : "Loop v2 execution failed.",
    ),
  ).slice(0, 1_000);
}

async function persistCheckpoint(
  checkpoint: LoopV2Checkpoint,
  executionScope: ExecutionScope,
  runContractBinding?: LoopV2RunContractSnapshot,
) {
  return runWithDatabaseActorScope(
    checkpoint.tenantId,
    [checkpoint.ownerActorId],
    () =>
      getSql().transaction(
        (sql: LoopV2CheckpointWriterSql) =>
          recordLoopV2Checkpoint({
            checkpoint,
            executionScope,
            runContractBinding,
          }, sql),
      ) as Promise<Awaited<ReturnType<typeof recordLoopV2Checkpoint>>>,
  );
}

async function persistTerminalCheckpoint(
  checkpoint: LoopV2Checkpoint,
  executionScope: ExecutionScope,
  terminal: {
    response?: string;
    error?: string;
    terminalRunContract?: LoopV2RunContractSnapshot;
  },
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
  dependencies: LoopV2ModelTextDependencies,
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
      "Loop v2 model terminal event persistence failed.",
      safeErrorMessage(error),
    );
  }
}
