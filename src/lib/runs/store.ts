import { createHash, randomUUID } from "node:crypto";
import { getDatabaseTenantContext, hasDatabaseUrl, ensureDatabaseSchema, getSql } from "@/lib/db/client";
import {
  appendDomainEvent,
  appendDomainEventSafely,
  appendScopedDomainEvent,
  listStreamEvents,
} from "@/lib/events/store";
import {
  enqueueOperationJob,
  getAgentResumeJobDedupeKey,
} from "@/lib/operations/job-queue";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { AgentEvent, AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { CitationSource, GroundingReport } from "@/lib/rag/citations";
import {
  buildLegacyTerminalReceiptV1,
  buildRunContractEnvelopeV1,
  buildRunContractEventPayloadV1,
  parseRunContractEnvelopeV1,
  runContractEventPayloadV1Schema,
  type RunContractEnvelopeV1,
  type RunContractEventPayloadV1,
} from "@/lib/runs/contracts";
import type { AgentRunContinuation, AgentRunEventRecord, AgentRunFeedback, AgentRunRecord, RunLedger, RunStatus } from "@/lib/runs/types";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { recordAiUsage } from "@/lib/usage/ledger";

export async function createAgentRun(input: {
  tenantId?: string;
  threadId?: string;
  mode: AgentMode;
  prompt: string;
  messages: ChatMessage[];
  model?: string;
  agentId?: string;
  specialistIds?: string[];
}) {
  const now = new Date().toISOString();
  const safeMessages = input.messages.map((message) => ({
    ...message,
    content: safeRunText(message.content, 30_000),
  }));
  const run: AgentRunRecord = {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
    threadId: input.threadId,
    mode: input.mode,
    status: "running",
    prompt: safeRunText(input.prompt, 30_000),
    messages: safeMessages,
    model: input.model,
    agentId: input.agentId || "atlas",
    specialistIds: Array.from(
      new Set([input.agentId || "atlas", ...(input.specialistIds || [])]),
    ).slice(0, 5),
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: now,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_agent_runs (
        id, tenant_id, thread_id, mode, status, prompt, messages, model, agent_id, specialist_ids, memory_context_count, started_at
      )
      VALUES (
        ${run.id}, ${run.tenantId}, ${run.threadId || null}, ${run.mode}, ${run.status}, ${run.prompt}, ${run.messages}::jsonb,
        ${run.model || null}, ${run.agentId}, ${run.specialistIds}, ${run.memoryContextCount}, ${run.startedAt}
      )
    `;
    return run;
  }

  await updateRunLedger((ledger) => {
    ledger.runs.unshift(run);
    return ledger;
  });
  return run;
}

/**
 * Persist a durable run before it is dispatched. The caller supplies a
 * deterministic id so supervisor retries converge on the same record.
 */
export async function createQueuedAgentRun(input: {
  id: string;
  tenantId?: string;
  mode: AgentMode;
  prompt: string;
  messages: ChatMessage[];
  model?: string;
  agentId: string;
}) {
  const now = new Date().toISOString();
  const safeMessages = input.messages.map((message) => ({
    ...message,
    content: safeRunText(message.content, 30_000),
  }));
  const run: AgentRunRecord = {
    id: safeRunId(input.id),
    tenantId: normalizeTenantId(input.tenantId),
    mode: input.mode,
    status: "queued",
    prompt: safeRunText(input.prompt, 30_000),
    messages: safeMessages,
    model: input.model,
    agentId: safeRunId(input.agentId),
    specialistIds: [safeRunId(input.agentId)],
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: now,
  };

  let saved = run;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      INSERT INTO omni_agent_runs (
        id, tenant_id, mode, status, prompt, messages, model, agent_id,
        specialist_ids, memory_context_count, started_at
      )
      VALUES (
        ${run.id}, ${run.tenantId}, ${run.mode}, ${run.status}, ${run.prompt},
        ${run.messages}::jsonb, ${run.model || null}, ${run.agentId},
        ${run.specialistIds}, ${run.memoryContextCount}, ${run.startedAt}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING *
    `;
    if (rows[0]) return runFromRow(rows[0]);
    const existing = await getAgentRun(run.id, { tenantId: run.tenantId });
    if (!existing) throw new Error("Queued agent run id collided without a readable record.");
    assertQueuedRunIdentity(existing, run);
    return existing;
  }

  await updateRunLedger((ledger) => {
    const existing = ledger.runs.find((item) =>
      item.id === run.id && normalizeTenantId(item.tenantId) === run.tenantId
    );
    if (existing) {
      assertQueuedRunIdentity(existing, run);
      saved = existing;
      return ledger;
    }
    ledger.runs.unshift(run);
    return ledger;
  });
  return saved;
}

const RUN_SCOPE_BOUND_EVENT_TYPE = "run.scope_bound";

export class AgentRunExecutionScopeBindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRunExecutionScopeBindingError";
  }
}

/**
 * Binds immutable execution attribution to a durable run before dispatch.
 * Duplicate identical bindings are harmless; conflicting bindings stop work.
 */
export async function bindAgentRunExecutionScope(
  runId: string,
  executionScope: ExecutionScope,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(executionScope, tenantId);
  const run = await getAgentRun(runId, { tenantId });
  if (!run) {
    throw new AgentRunExecutionScopeBindingError(
      "Execution scope cannot be bound to a missing agent run.",
    );
  }
  const existing = await getAgentRunExecutionScope(runId, { tenantId });
  if (existing) {
    if (!executionScopesEqual(existing, executionScope)) {
      throw new AgentRunExecutionScopeBindingError(
        "Agent run is already bound to another execution scope.",
      );
    }
    return existing;
  }

  await appendDomainEvent({
    streamId: `run:${runId}`,
    type: RUN_SCOPE_BOUND_EVENT_TYPE,
    tenantId,
    payload: {
      scopeVersion: executionScope.version,
      scopeSha256: createHash("sha256")
        .update(JSON.stringify(executionScope))
        .digest("hex"),
    },
    correlationId: executionScope.correlationId,
    executionScope,
  });

  const bound = await getAgentRunExecutionScope(runId, { tenantId });
  if (!bound || !executionScopesEqual(bound, executionScope)) {
    throw new AgentRunExecutionScopeBindingError(
      "Agent run execution scope binding could not be verified.",
    );
  }
  return bound;
}

/** Returns the one canonical scope shared by all scope-binding events. */
export async function getAgentRunExecutionScope(
  runId: string,
  options: { tenantId?: string } = {},
): Promise<ExecutionScope | undefined> {
  const tenantId = normalizeTenantId(options.tenantId);
  const events = await listStreamEvents(`run:${runId}`, {
    tenantId,
    limit: 2_000,
    order: "asc",
  });
  let bound: ExecutionScope | undefined;
  for (const event of events) {
    if (event.type !== RUN_SCOPE_BOUND_EVENT_TYPE) continue;
    if (!event.executionScope) {
      throw new AgentRunExecutionScopeBindingError(
        "Agent run has an invalid execution scope binding.",
      );
    }
    try {
      assertExecutionScopeTenant(event.executionScope, tenantId);
    } catch {
      throw new AgentRunExecutionScopeBindingError(
        "Agent run execution scope binding has the wrong tenant.",
      );
    }
    if (
      (event.executionScope.initiatingActorId &&
        event.actorId !== event.executionScope.initiatingActorId) ||
      event.correlationId !== event.executionScope.correlationId
    ) {
      throw new AgentRunExecutionScopeBindingError(
        "Agent run execution scope binding metadata is inconsistent.",
      );
    }
    if (bound && !executionScopesEqual(bound, event.executionScope)) {
      throw new AgentRunExecutionScopeBindingError(
        "Agent run has conflicting execution scope bindings.",
      );
    }
    bound = event.executionScope;
  }
  return bound;
}

export type RunContractLifecycleEventType =
  | "run.contracts.bound"
  | "run.manifests.resolved"
  | "run.terminal_receipt.recorded";

/**
 * Strict, scoped writer for the additive P0.2 shadow contract lifecycle.
 * The compact payload is schema-closed and contains metadata only.
 */
export async function appendRunContractEvent(
  runId: string,
  type: RunContractLifecycleEventType,
  payload: RunContractEventPayloadV1,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(options.executionScope, tenantId);
  const parsed = runContractEventPayloadV1Schema.parse(payload);
  if (parsed.runId !== runId) {
    throw new Error("Run contract event is bound to another run.");
  }
  const run = await getAgentRun(runId, { tenantId });
  if (!run) {
    throw new Error("Run contract event requires an existing run.");
  }
  const boundScope = await getAgentRunExecutionScope(runId, { tenantId });
  if (!boundScope || !executionScopesEqual(boundScope, options.executionScope)) {
    throw new Error("Run contract event scope does not match the run binding.");
  }
  return appendScopedDomainEvent({
    streamId: `run:${runId}`,
    type,
    payload: parsed,
    executionScope: options.executionScope,
  });
}

/** Shadow telemetry must not change the legacy run control path. */
export async function appendRunContractEventSafely(
  runId: string,
  type: RunContractLifecycleEventType,
  payload: RunContractEventPayloadV1,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  try {
    return await appendRunContractEvent(runId, type, payload, options);
  } catch (error) {
    console.warn(
      "Run contract shadow event append failed.",
      String(redactSensitive(
        error instanceof Error ? error.message : "Unknown contract event error.",
      )).slice(0, 1_000),
    );
    return undefined;
  }
}

/** Exactly one queue delivery may move a pre-created run into execution. */
export async function claimQueuedAgentRun(
  runId: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const startedAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status = 'running', started_at = ${startedAt}, completed_at = NULL,
          error = NULL
      WHERE id = ${runId} AND tenant_id = ${tenantId} AND status = 'queued'
      RETURNING *
    `;
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  let claimed: AgentRunRecord | undefined;
  await updateRunLedger((ledger) => {
    const run = ledger.runs.find((item) =>
      item.id === runId && normalizeTenantId(item.tenantId) === tenantId
    );
    if (run?.status === "queued") {
      run.status = "running";
      run.startedAt = startedAt;
      run.completedAt = undefined;
      run.error = undefined;
      claimed = { ...run };
    }
    return ledger;
  });
  return claimed;
}

export async function appendRunEvent(
  runId: string,
  event: AgentEvent,
  options: {
    tenantId?: string;
    executionScope?: ExecutionScope;
    runContractEnvelope?: RunContractEnvelopeV1;
  } = {},
) {
  const redactedEvent = redactSensitive(event) as AgentEvent;
  const record: AgentRunEventRecord = {
    id: randomUUID(),
    runId,
    type: event.type,
    payload: redactedEvent,
    createdAt: new Date().toISOString(),
  };

  // Text deltas are streaming transport rather than replayable decisions. The
  // completed response remains on the run, so persisting every token would
  // duplicate sensitive model output and inflate storage.
  if (event.type === "delta") {
    return record;
  }
  const meteredModelEvent = Boolean(
    redactedEvent.type === "model" &&
    (
      options.executionScope?.initiatingActorId ||
      redactedEvent.usageReceiptRecorded
    ),
  );
  const domainEvent = {
    streamId: `run:${runId}`,
    type: `run.${event.type}`,
    payload: {
      ...domainEventPayload(redactedEvent),
      ...(meteredModelEvent ? { usageLedgerVersion: 1 } : {}),
    },
    correlationId: options.executionScope?.correlationId || runId,
    executionScope: options.executionScope,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId
      ? normalizeTenantId(options.tenantId)
      : getDatabaseTenantContext() ||
        (await resolveAgentRunTenantId(runId));
    record.tenantId = tenantId;
    if (options.executionScope) {
      assertExecutionScopeTenant(options.executionScope, tenantId);
    }
    await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      if (redactedEvent.type === "harness" && redactedEvent.contextTraceId) {
        await lockActiveRetrievalTrace(
          sql,
          tenantId,
          redactedEvent.contextTraceId,
        );
      }
      const persistedDomainEvent = await appendDomainEvent(
        { ...domainEvent, tenantId },
        { sql },
      );
      if (
        redactedEvent.type === "model" &&
        options.executionScope?.initiatingActorId &&
        !redactedEvent.usageReceiptRecorded
      ) {
        await recordAiUsage({
          id: redactedEvent.usageReceiptId || `run-model:${record.id}`,
          tenantId,
          actorId: options.executionScope.initiatingActorId,
          sourceStreamId: `run:${runId}`,
          sourceEventId: persistedDomainEvent.id,
          operation: "tool_turn",
          purpose: "agent.turn",
          status: "completed",
          provider: redactedEvent.provider || "unknown",
          model: redactedEvent.model,
          usage: {
            inputTokens: redactedEvent.inputTokens,
            cachedInputTokens: redactedEvent.cachedInputTokens,
            outputTokens: redactedEvent.outputTokens,
            totalTokens: redactedEvent.totalTokens,
          },
          providerCallCount:
            redactedEvent.callReceipts?.length ||
            redactedEvent.attemptCount ||
            redactedEvent.iterationCount ||
            1,
          attemptCount:
            redactedEvent.attemptCount ||
            (redactedEvent.iterationCount || 1) +
              (redactedEvent.fallbackUsed ? 1 : 0),
          failedAttemptCount:
            redactedEvent.failedAttemptCount ??
            (redactedEvent.fallbackUsed ? 1 : 0),
          callReceipts: redactedEvent.callReceipts,
          latencyMs: redactedEvent.latencyMs,
          estimatedCostUsd: redactedEvent.costKnown === false
            ? undefined
            : redactedEvent.estimatedCostUsd,
          providerRequestId: redactedEvent.providerRequestId,
          assignmentId: redactedEvent.assignmentId,
          credentialSource: redactedEvent.credentialSource,
          correlationId: options.executionScope.correlationId,
          causationId: options.executionScope.causationId || undefined,
          executionScope: options.executionScope,
        }, { sql });
      }
      await sql`
        INSERT INTO omni_agent_events (id, tenant_id, run_id, type, payload, created_at)
        VALUES (${record.id}, ${tenantId}, ${record.runId}, ${record.type}, ${record.payload}::jsonb, ${record.createdAt})
      `;
    });
    await appendLegacyRunTerminalReceiptSafely(
      runId,
      redactedEvent,
      record.id,
      tenantId,
      options.executionScope,
      options.runContractEnvelope,
    );
    return record;
  }

  if (options.executionScope) {
    const ledger = await readRunLedger();
    const scopedRun = ledger.runs.find((run) => run.id === runId);
    if (!scopedRun) {
      throw new Error("Scoped agent run event requires an existing run.");
    }
    assertExecutionScopeTenant(
      options.executionScope,
      normalizeTenantId(scopedRun.tenantId),
    );
  }
  const persistedDomainEvent = await appendDomainEventSafely({
    ...domainEvent,
    tenantId: options.tenantId,
  });
  await updateRunLedger((ledger) => {
    const runTenantId = normalizeTenantId(
      ledger.runs.find((run) => run.id === runId)?.tenantId,
    );
    if (
      options.tenantId &&
      runTenantId !== normalizeTenantId(options.tenantId)
    ) {
      throw new Error("Agent run event tenant does not match the run.");
    }
    record.tenantId = runTenantId;
    ledger.events.push(record);
    return ledger;
  });
  if (
    persistedDomainEvent &&
    redactedEvent.type === "model" &&
    options.executionScope?.initiatingActorId &&
    !redactedEvent.usageReceiptRecorded
  ) {
    await recordAiUsage({
      id: redactedEvent.usageReceiptId || `run-model:${record.id}`,
      tenantId: record.tenantId || normalizeTenantId(options.tenantId),
      actorId: options.executionScope.initiatingActorId,
      sourceStreamId: `run:${runId}`,
      sourceEventId: persistedDomainEvent.id,
      operation: "tool_turn",
      purpose: "agent.turn",
      status: "completed",
      provider: redactedEvent.provider || "unknown",
      model: redactedEvent.model,
      usage: {
        inputTokens: redactedEvent.inputTokens,
        cachedInputTokens: redactedEvent.cachedInputTokens,
        outputTokens: redactedEvent.outputTokens,
        totalTokens: redactedEvent.totalTokens,
      },
      providerCallCount:
        redactedEvent.callReceipts?.length ||
        redactedEvent.attemptCount ||
        redactedEvent.iterationCount ||
        1,
      attemptCount:
        redactedEvent.attemptCount ||
        (redactedEvent.iterationCount || 1) +
          (redactedEvent.fallbackUsed ? 1 : 0),
      failedAttemptCount:
        redactedEvent.failedAttemptCount ??
        (redactedEvent.fallbackUsed ? 1 : 0),
      callReceipts: redactedEvent.callReceipts,
      latencyMs: redactedEvent.latencyMs,
      estimatedCostUsd: redactedEvent.costKnown === false
        ? undefined
        : redactedEvent.estimatedCostUsd,
      providerRequestId: redactedEvent.providerRequestId,
      assignmentId: redactedEvent.assignmentId,
      credentialSource: redactedEvent.credentialSource,
      correlationId: options.executionScope.correlationId,
      causationId: options.executionScope.causationId || undefined,
      executionScope: options.executionScope,
    });
  }
  await appendLegacyRunTerminalReceiptSafely(
    runId,
    redactedEvent,
    record.id,
    record.tenantId || normalizeTenantId(options.tenantId),
    options.executionScope,
    options.runContractEnvelope,
  );
  return record;
}

async function lockActiveRetrievalTrace(
  sql: ReturnType<typeof getSql>,
  tenantId: string,
  retrievalTraceId: string,
) {
  const rows = await sql`
    SELECT id
    FROM omni_retrieval_traces
    WHERE tenant_id = ${tenantId}
      AND id = ${retrievalTraceId}
      AND NOT omni_memory_ids_have_deletion_barrier(tenant_id, memory_ids)
    FOR KEY SHARE
  `;
  if (!rows[0]) {
    throw new Error(
      "Run context was invalidated before it could be admitted.",
    );
  }
}

async function appendLegacyRunTerminalReceiptSafely(
  runId: string,
  event: AgentEvent,
  sourceEventId: string,
  tenantId: string,
  executionScope?: ExecutionScope,
  runContractEnvelope?: RunContractEnvelopeV1,
) {
  if (
    !runContractEnvelope ||
    event.type !== "waiting_approval" &&
      event.type !== "done" &&
      event.type !== "error" &&
      event.type !== "canceled"
  ) {
    return;
  }

  try {
    const terminalExecutionScope = executionScope ||
      await getAgentRunExecutionScope(runId, { tenantId });
    if (!terminalExecutionScope) return;
    const currentRun = await getAgentRun(runId, { tenantId });
    const expectedStatus: RunStatus = event.type === "waiting_approval"
      ? "waiting_approval"
      : event.type === "done"
        ? "completed"
        : event.type === "canceled"
          ? "canceled"
          : "failed";
    if (currentRun?.status !== expectedStatus) return;
    const legacyStatus = event.type === "waiting_approval"
      ? "waiting_approval" as const
      : event.type === "done"
        ? "completed" as const
        : event.type === "canceled"
          ? "canceled" as const
          : "failed" as const;
    const pendingApprovalIds = event.type === "waiting_approval"
      ? [runContractReferenceId("approval", event.executionId)]
      : [];
    const outputSha256 = event.type === "done"
      ? createHash("sha256").update(event.response).digest("hex")
      : null;
    const receipt = buildLegacyTerminalReceiptV1({
      terminalReceiptId: runContractReferenceId(
        "receipt",
        `${runId}:receipt:${sourceEventId}:v1`,
      ),
      runId,
      legacyStatus,
      pendingApprovalIds,
      outputSha256,
    });
    const {
      schemaVersion: _schemaVersion,
      ...activeEnvelope
    } = runContractEnvelope;
    void _schemaVersion;
    const terminalEnvelope = buildRunContractEnvelopeV1({
      ...activeEnvelope,
      envelopeId: runContractReferenceId(
        "envelope",
        `${runId}:terminal:${sourceEventId}:v1`,
      ),
      terminalReceipt: receipt,
    });
    const terminalPayload = buildRunContractEventPayloadV1({
      envelope: terminalEnvelope,
      envelopeSha256: createHash("sha256")
        .update(JSON.stringify(terminalEnvelope))
        .digest("hex"),
    });
    await appendRunContractEvent(
      runId,
      "run.terminal_receipt.recorded",
      terminalPayload,
      { tenantId, executionScope: terminalExecutionScope },
    );
  } catch (error) {
    console.warn(
      "Run terminal receipt shadow append failed.",
      String(redactSensitive(
        error instanceof Error ? error.message : "Unknown terminal receipt error.",
      )).slice(0, 1_000),
    );
  }
}

function runContractReferenceId(prefix: string, value: string) {
  const normalized = value.trim();
  if (/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,239}$/.test(normalized)) {
    return normalized;
  }
  return `${prefix}:${createHash("sha256").update(normalized).digest("hex")}`;
}

function domainEventPayload(event: AgentEvent): Record<string, unknown> {
  const schemaVersion = 1;
  switch (event.type) {
    case "run":
      return {
        schemaVersion,
        type: event.type,
        runId: event.runId,
        threadId: event.threadId,
        missionId: event.missionId,
      };
    case "delegated":
      return {
        schemaVersion,
        type: event.type,
        threadId: event.threadId,
        workflowId: event.workflowId,
        missionId: event.missionId,
        ...hashedTextFields("acknowledgement", event.acknowledgement),
        ...hashedTextFields("reason", event.reason),
      };
    case "status":
      return {
        schemaVersion,
        type: event.type,
        ...hashedTextFields("label", event.label),
        ...hashedTextFields("detail", event.detail),
      };
    case "harness":
      return {
        schemaVersion,
        type: event.type,
        version: event.version,
        mode: event.mode,
        provider: event.provider,
        model: event.model,
        tier: event.tier,
        memoryScope: event.memoryScope,
        contextDecision: event.contextDecision,
        contextMode: event.contextMode,
        contextCount: event.contextCount,
        contextTraceId: event.contextTraceId,
        liveWeb: event.liveWeb,
        toolCount: event.toolCount,
        approvalToolCount: event.approvalToolCount,
        toolboxSha256: event.toolboxSha256,
        instructionsSha256: event.instructionsSha256,
        maxToolSteps: event.maxToolSteps,
        maxToolCallsPerTurn: event.maxToolCallsPerTurn,
        maxToolResultChars: event.maxToolResultChars,
        maxOutputTokens: event.maxOutputTokens,
        approvalPolicy: event.approvalPolicy,
        autonomy: event.autonomy,
        learningState: event.learningState,
        learningSampleSize: event.learningSampleSize,
        learningGuidanceCount: event.learningGuidanceCount,
        learningGuidanceSha256: event.learningGuidanceSha256,
      };
    case "memory":
      return {
        schemaVersion,
        type: event.type,
        count: event.count,
        ...hashedTextFields("title", event.title),
      };
    case "model":
      return { schemaVersion, ...event };
    case "council_member":
      return {
        schemaVersion,
        type: event.type,
        agentId: event.agentId,
        status: event.status,
        confidence: event.confidence,
        durationMs: event.durationMs,
        ...hashedTextFields("summary", event.summary),
      };
    case "council_verdict":
      return {
        schemaVersion,
        type: event.type,
        status: event.status,
        score: event.score,
        requiredChangeCount: event.requiredChanges.length,
        ...hashedTextFields("assessment", event.assessment),
        requiredChangesSha256: sha256Json(event.requiredChanges),
      };
    case "tool":
      return {
        schemaVersion,
        type: event.type,
        toolId: event.toolId,
        status: event.status,
        riskLevel: event.riskLevel,
        dryRun: event.dryRun,
        executionId: event.executionId,
        ...hashedTextFields("summary", event.summary),
      };
    case "waiting_approval":
      return {
        schemaVersion,
        type: event.type,
        executionId: event.executionId,
        toolId: event.toolId,
        ...hashedTextFields("message", event.message),
      };
    case "done":
      return {
        schemaVersion,
        type: event.type,
        responseLength: event.response.length,
        responseSha256: sha256Text(event.response),
        grounding: event.grounding
          ? {
              status: event.grounding.status,
              citedIds: event.grounding.citedIds,
              invalidCitationCount: event.grounding.invalidIds.length,
            }
          : undefined,
      };
    case "canceled":
    case "error":
      return {
        schemaVersion,
        type: event.type,
        ...hashedTextFields("message", event.message),
      };
    case "delta":
      return { schemaVersion, type: event.type };
  }
}

function hashedTextFields(name: string, value?: string) {
  return value
    ? {
        [`${name}Length`]: value.length,
        [`${name}Sha256`]: sha256Text(value),
      }
    : {};
}

function sha256Text(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function sha256Json(value: unknown) {
  return sha256Text(JSON.stringify(value));
}

export async function updateRunContextCount(runId: string, count: number) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_agent_runs
      SET memory_context_count = ${count}
      WHERE id = ${runId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    run.memoryContextCount = count;
  });
}

export async function recordRunConsolidation(
  runId: string,
  result: { count: number; error?: string },
  options: { tenantId?: string } = {},
) {
  const consolidatedAt = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId
      ? normalizeTenantId(options.tenantId)
      : await resolveAgentRunTenantId(runId);
    await getSql()`
      UPDATE omni_agent_runs
      SET consolidation_count = ${result.count},
          consolidation_error = ${result.error ? safeRunText(result.error, 2_000) : null},
          consolidated_at = ${consolidatedAt}
      WHERE id = ${runId}
        AND tenant_id = ${tenantId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    if (
      options.tenantId &&
      normalizeTenantId(run.tenantId) !== normalizeTenantId(options.tenantId)
    ) {
      throw new Error("Agent run consolidation tenant does not match the run.");
    }
    run.consolidationCount = result.count;
    run.consolidationError = result.error
      ? safeRunText(result.error, 2_000)
      : undefined;
    run.consolidatedAt = consolidatedAt;
  });
}

export async function recordAgentRunFeedback(
  runId: string,
  input: { verdict: AgentRunFeedback["verdict"]; correction?: string },
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const feedback: AgentRunFeedback = {
    verdict: input.verdict,
    correction: input.correction
      ? safeRunText(input.correction.trim(), 2_000)
      : undefined,
    updatedAt: new Date().toISOString(),
  };

  let updated: AgentRunRecord | undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET feedback = ${feedback}::jsonb
      WHERE id = ${runId}
        AND tenant_id = ${tenantId}
        AND status = 'completed'
      RETURNING *
    `;
    updated = rows[0] ? runFromRow(rows[0]) : undefined;
  } else {
    await updateFileRun(runId, (run) => {
      if (
        normalizeTenantId(run.tenantId) === tenantId &&
        run.status === "completed"
      ) {
        run.feedback = feedback;
        updated = run;
      }
    });
  }

  if (updated) {
    await appendDomainEventSafely({
      tenantId,
      streamId: `run:${runId}`,
      type: "run.feedback",
      payload: {
        verdict: feedback.verdict,
        hasCorrection: Boolean(feedback.correction),
      },
      correlationId: runId,
    });
  }
  return updated ? sanitizeAgentRunRecord(updated) : undefined;
}

export async function getAgentFeedbackGuidance(
  agentId: string,
  options: { tenantId?: string; limit?: number } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 3, 1), 5);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT feedback
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
        AND agent_id = ${agentId}
        AND feedback->>'verdict' = 'needs_work'
        AND COALESCE(feedback->>'correction', '') <> ''
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows
      .map((row) => parseAgentRunFeedback(row.feedback)?.correction)
      .filter((value): value is string => Boolean(value));
  }

  const ledger = await readRunLedger();
  return ledger.runs
    .filter((run) =>
      normalizeTenantId(run.tenantId) === tenantId &&
      (run.agentId || "atlas") === agentId &&
      run.feedback?.verdict === "needs_work" &&
      Boolean(run.feedback.correction)
    )
    .slice(0, limit)
    .map((run) => run.feedback?.correction)
    .filter((value): value is string => Boolean(value));
}

export async function completeAgentRun(runId: string, response: string, grounding?: GroundingReport) {
  return setRunStatus(runId, "completed", { response, grounding });
}

export async function failAgentRun(runId: string, error: string) {
  return setRunStatus(runId, "failed", { error });
}

export async function cancelAgentRun(runId: string, reason = "Canceled by the operator.") {
  return setRunStatus(runId, "canceled", { error: reason });
}

/** Fail stale initial runs and interrupted resume claims without replaying work. */
export async function repairStuckAgentRuns({
  staleAfterMs = 7 * 60 * 1000,
  tenantId: requestedTenantId,
}: {
  staleAfterMs?: number;
  tenantId?: string;
} = {}) {
  const tenantId = normalizeTenantId(requestedTenantId);
  const staleBeforeEpoch = new Date(Date.now() - staleAfterMs).toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    // Use epoch arithmetic to avoid named-parameter / type issues with intervals.
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status       = 'failed',
          error        = CASE
            WHEN status = 'resuming'
              THEN 'Approved run resume was interrupted; side effects were not replayed.'
            WHEN status = 'queued'
              THEN 'Queued durable agent run expired before dispatch.'
            ELSE 'Run timed out (function invocation limit exceeded).'
          END,
          continuation = NULL,
          completed_at = NOW()
      WHERE tenant_id = ${tenantId}
        AND (
          (status IN ('queued', 'running') AND started_at <= ${staleBeforeEpoch}::timestamptz)
          OR (
            status = 'resuming'
            AND COALESCE(
              (continuation->>'resumeClaimedAt')::timestamptz,
              started_at
            ) <= ${staleBeforeEpoch}::timestamptz
          )
        )
      RETURNING id
    `;
    return rows.length;
  }
  let repaired = 0;
  await updateRunLedger((ledger) => {
    const staleBefore = Date.parse(staleBeforeEpoch);
    for (const run of ledger.runs) {
      if (normalizeTenantId(run.tenantId) !== tenantId) {
        continue;
      }
      const staleInitial =
        (run.status === "queued" || run.status === "running") &&
        Date.parse(run.startedAt) <= staleBefore;
      const resumeClaimedAt =
        run.continuation?.resumeClaimedAt || run.startedAt;
      const staleResuming =
        run.status === "resuming" &&
        Date.parse(resumeClaimedAt) <= staleBefore;
      if (!staleInitial && !staleResuming) {
        continue;
      }
      repaired += 1;
      const wasQueued = run.status === "queued";
      run.status = "failed";
      run.error = staleResuming
        ? "Approved run resume was interrupted; side effects were not replayed."
        : wasQueued
          ? "Queued durable agent run expired before dispatch."
          : "Run timed out (function invocation limit exceeded).";
      run.continuation = undefined;
      run.completedAt = new Date().toISOString();
    }
    return ledger;
  });
  return repaired;
}

export async function markAgentRunWaitingForApproval(
  runId: string,
  values: { response: string; continuation: AgentRunContinuation },
) {
  const tenantId = normalizeTenantId(values.continuation.context.tenantId);
  const executionId = values.continuation.pendingToolCall.executionId;
  const resumeJobInput = {
    tenantId,
    type: "agent.resume" as const,
    dedupeKey: getAgentResumeJobDedupeKey(executionId),
    payload: { agentRunId: runId, executionId },
    priority: 20,
    maxAttempts: 10,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql`
          UPDATE omni_agent_runs
          SET status = 'waiting_approval',
              response = ${values.response ? safeRunText(values.response, 100_000) : null},
              continuation = ${values.continuation}::jsonb,
              completed_at = NULL
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
            AND status IN ('running', 'resuming')
          RETURNING id
        `;
        if (!rows[0]) {
          return { parked: false, resumeJob: undefined };
        }
        const resumeJob = await enqueueOperationJob(resumeJobInput, { sql });
        return { parked: true, resumeJob };
      },
    ) as Promise<{
      parked: boolean;
      resumeJob:
        | Awaited<ReturnType<typeof enqueueOperationJob>>
        | undefined;
    }>;
  }

  // File mode has no cross-file transaction. Pre-arm the durable job first;
  // the resume worker defers it while the continuation write is incomplete.
  const resumeJob = await enqueueOperationJob(resumeJobInput);
  let parked = false;
  await updateFileRun(runId, (run) => {
    if (
      normalizeTenantId(run.tenantId) !== tenantId ||
      !["running", "resuming"].includes(run.status)
    ) {
      return;
    }
    run.status = "waiting_approval";
    run.response = safeRunText(values.response, 100_000);
    run.continuation = values.continuation;
    run.completedAt = undefined;
    parked = true;
  });
  return { parked, resumeJob };
}

/**
 * Conditional transition: only one caller can move a run from
 * waiting_approval to resuming. Returns false if another approval already
 * claimed the run, so concurrent decisions cannot double-resume it.
 */
export async function markAgentRunResuming(runId: string): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status = 'resuming',
          continuation = jsonb_set(
            continuation,
            '{resumeClaimedAt}',
            to_jsonb(${claimedAt}::text),
            true
          ),
          completed_at = NULL
      WHERE id = ${runId}
        AND status = 'waiting_approval'
      RETURNING id
    `;
    return Boolean(rows[0]);
  }

  let transitioned = false;
  await updateFileRun(runId, (run) => {
    if (run.status === "waiting_approval") {
      run.status = "resuming";
      if (run.continuation) {
        run.continuation = {
          ...run.continuation,
          resumeClaimedAt: claimedAt,
        };
      }
      run.completedAt = undefined;
      transitioned = true;
    }
  });
  return transitioned;
}

export async function getAgentRun(runId: string, options: { tenantId?: string } = {}) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId ? normalizeTenantId(options.tenantId) : undefined;
    const rows = tenantId
      ? await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
          LIMIT 1
        `
      : await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE id = ${runId}
          LIMIT 1
        `;
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  const ledger = await readRunLedger();
  return ledger.runs.find((run) => run.id === runId && (!options.tenantId || normalizeTenantId(run.tenantId) === normalizeTenantId(options.tenantId)));
}

export async function findAgentRunWaitingForToolApproval(
  executionId: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = options.tenantId ? normalizeTenantId(options.tenantId) : undefined;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = tenantId
      ? await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE tenant_id = ${tenantId}
            AND status IN ('waiting_approval', 'resuming')
            AND continuation->'pendingToolCall'->>'executionId' = ${executionId}
          ORDER BY started_at DESC
          LIMIT 1
        `
      : await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE status IN ('waiting_approval', 'resuming')
            AND continuation->'pendingToolCall'->>'executionId' = ${executionId}
          ORDER BY started_at DESC
          LIMIT 1
        `;
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  const ledger = await readRunLedger();
  return ledger.runs.find((run) =>
    (run.status === "waiting_approval" || run.status === "resuming") &&
    run.continuation?.pendingToolCall.executionId === executionId &&
    (!tenantId || normalizeTenantId(run.tenantId) === tenantId)
  );
}

export async function listAgentRuns(limit = 20, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.map(runFromRow);
  }

  const ledger = await readRunLedger();
  return ledger.runs.filter((run) => normalizeTenantId(run.tenantId) === tenantId).slice(0, limit);
}

export async function listAgentRunSummaries(
  limit = 20,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 50);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        id, tenant_id, mode, status, prompt, response, grounding, feedback, error, continuation, agent_id, specialist_ids,
        started_at, completed_at
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
      ORDER BY started_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(runFromRow);
  }

  const ledger = await readRunLedger();
  return ledger.runs
    .filter((run) => normalizeTenantId(run.tenantId) === tenantId)
    .slice(0, boundedLimit);
}

export async function getRunStats(options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const totals = await getSql()`
      SELECT status, COUNT(*)::int AS count
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
      GROUP BY status
    `;
    const byStatus = totals.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.status)] = Number(row.count);
      return acc;
    }, {});
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const consolidatedRows = await getSql()`
      SELECT COUNT(*)::int AS runs,
             COALESCE(SUM(consolidation_count), 0)::int AS memories
      FROM omni_agent_runs
      WHERE consolidated_at IS NOT NULL
        AND tenant_id = ${tenantId}
    `;

    return {
      total,
      byStatus,
      consolidated: {
        runs: Number(consolidatedRows[0]?.runs || 0),
        memories: Number(consolidatedRows[0]?.memories || 0),
      },
      latest: await listAgentRuns(5, { tenantId }),
    };
  }

  const ledger = await readRunLedger();
  const runs = ledger.runs.filter((run) => normalizeTenantId(run.tenantId) === tenantId);
  const byStatus = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});

  return {
    total: runs.length,
    byStatus,
    consolidated: {
      runs: runs.filter((run) => run.consolidatedAt).length,
      memories: runs.reduce((sum, run) => sum + (run.consolidationCount || 0), 0),
    },
    latest: runs.slice(0, 5),
  };
}

async function setRunStatus(
  runId: string,
  status: RunStatus,
  values: { response?: string; error?: string; grounding?: GroundingReport },
) {
  const completedAt = new Date().toISOString();
  const safeResponse = values.response
    ? safeRunText(values.response, 100_000)
    : undefined;
  const safeError = values.error ? safeRunText(values.error, 2_000) : undefined;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status = ${status},
          response = ${safeResponse || null},
          grounding = ${values.grounding || null}::jsonb,
          error = ${safeError || null},
          continuation = NULL,
          completed_at = ${completedAt}
      WHERE id = ${runId}
        AND status NOT IN ('completed', 'failed', 'canceled')
      RETURNING id
    `;
    return Boolean(rows[0]);
  }

  let changed = false;
  await updateFileRun(runId, (run) => {
    if (["completed", "failed", "canceled"].includes(run.status)) {
      return;
    }
    changed = true;
    run.status = status;
    run.response = safeResponse;
    run.grounding = values.grounding;
    run.error = safeError;
    run.continuation = undefined;
    run.completedAt = completedAt;
  });
  return changed;
}

function safeRunText(value: string, maxChars: number) {
  return String(redactSensitive(value)).slice(0, maxChars);
}

function safeRunId(value: string) {
  const safe = value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 200);
  if (!safe) throw new Error("Agent run identity is required.");
  return safe;
}

function assertQueuedRunIdentity(
  existing: AgentRunRecord,
  expected: AgentRunRecord,
) {
  if (
    normalizeTenantId(existing.tenantId) !== expected.tenantId ||
    existing.mode !== expected.mode ||
    existing.prompt !== expected.prompt ||
    existing.agentId !== expected.agentId
  ) {
    throw new Error(
      "Durable agent run id is already bound to a different specialist request.",
    );
  }
}

async function updateFileRun(runId: string, mutate: (run: AgentRunRecord) => void) {
  await updateRunLedger((ledger) => {
    const run = ledger.runs.find((item) => item.id === runId);
    if (run) {
      mutate(run);
    }
    return ledger;
  });
}

async function readRunLedger() {
  const ledger = await readJsonFile<RunLedger>(
    getRunsFile(),
    { runs: [], events: [] },
  );
  return {
    runs: ledger.runs.map(sanitizeAgentRunRecord),
    events: redactSensitive(ledger.events) as RunLedger["events"],
  };
}

async function updateRunLedger(mutate: (ledger: RunLedger) => RunLedger) {
  return updateJsonFile<RunLedger>(getRunsFile(), { runs: [], events: [] }, (ledger) =>
    trimLedger(mutate(ledger)),
  );
}

function trimLedger(ledger: RunLedger): RunLedger {
  const nonterminal = ledger.runs.filter((run) =>
    ["queued", "running", "waiting_approval", "resuming"].includes(run.status),
  );
  const terminal = ledger.runs.filter(
    (run) => !["queued", "running", "waiting_approval", "resuming"].includes(run.status),
  );
  const runs = [
    ...nonterminal,
    ...terminal.slice(0, Math.max(0, 100 - nonterminal.length)),
  ];
  const runIds = new Set(runs.map((run) => run.id));
  return {
    runs,
    events: ledger.events.filter((event) => runIds.has(event.runId)).slice(-1000),
  };
}

function runFromRow(row: Record<string, unknown>): AgentRunRecord {
  return sanitizeAgentRunRecord({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    threadId: row.thread_id ? String(row.thread_id) : undefined,
    mode: String(row.mode) as AgentMode,
    status: String(row.status) as RunStatus,
    prompt: String(row.prompt || ""),
    messages: Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [],
    model: row.model ? String(row.model) : undefined,
    agentId: row.agent_id ? String(row.agent_id) : "atlas",
    specialistIds: Array.isArray(row.specialist_ids) ? row.specialist_ids.map(String) : [],
    feedback: parseAgentRunFeedback(row.feedback),
    memoryContextCount: Number(row.memory_context_count || 0),
    consolidationCount: Number(row.consolidation_count || 0),
    response: row.response ? String(row.response) : undefined,
    grounding: parseGroundingReport(row.grounding),
    error: row.error ? String(row.error) : undefined,
    consolidationError: row.consolidation_error ? String(row.consolidation_error) : undefined,
    continuation: parseContinuation(row.continuation),
    startedAt: normalizeDate(row.started_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    consolidatedAt: row.consolidated_at ? normalizeDate(row.consolidated_at) : undefined,
  });
}

function sanitizeAgentRunRecord(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    prompt: String(redactSensitive(run.prompt)).slice(0, 20_000),
    messages: redactSensitive(run.messages) as ChatMessage[],
    response: run.response
      ? String(redactSensitive(run.response))
      : undefined,
    grounding: run.grounding
      ? (redactSensitive(run.grounding) as GroundingReport)
      : undefined,
    error: run.error
      ? String(redactSensitive(run.error)).slice(0, 2_000)
      : undefined,
    consolidationError: run.consolidationError
      ? String(redactSensitive(run.consolidationError)).slice(0, 2_000)
      : undefined,
    continuation: run.continuation
      ? (redactSensitive(run.continuation) as AgentRunContinuation)
      : undefined,
  };
}

function parseGroundingReport(value: unknown): GroundingReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<GroundingReport>;
  if (!candidate.status || !["verified", "not_required", "missing", "invalid"].includes(candidate.status)) {
    return undefined;
  }
  return {
    status: candidate.status,
    citedIds: parseCitationIds(candidate.citedIds),
    invalidIds: parseCitationIds(candidate.invalidIds),
    sources: parseCitationSources(candidate.sources),
  };
}

function parseCitationIds(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(isCitationId)
    .slice(0, 100);
}

function isCitationId(value: unknown): value is string {
  return typeof value === "string" &&
    /^(?:memory|knowledge|graph|web):[^\]\s]{1,240}$/.test(value);
}

function isCitationKind(value: unknown): value is CitationSource["kind"] {
  return value === "memory" || value === "knowledge" || value === "graph" || value === "web";
}

function parseCitationSources(value: unknown): GroundingReport["sources"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const kind = source.kind;
    if (!isCitationKind(kind)) return [];
    if (
      !isCitationId(source.citationId) ||
      typeof source.evidenceId !== "string" ||
      typeof source.title !== "string" ||
      !source.citationId.startsWith(`${kind}:`)
    ) return [];
    return [{
      citationId: source.citationId.slice(0, 256),
      evidenceId: source.evidenceId.slice(0, 2_000),
      kind,
      title: source.title.slice(0, 1_000),
      confidence: typeof source.confidence === "number" && Number.isFinite(source.confidence)
        ? Math.min(Math.max(source.confidence, 0), 1)
        : undefined,
      url: typeof source.url === "string" ? source.url.slice(0, 2_000) : undefined,
      snippet: typeof source.snippet === "string" ? source.snippet.slice(0, 2_000) : undefined,
      accessedAt: typeof source.accessedAt === "string" ? source.accessedAt.slice(0, 100) : undefined,
    }];
  }).slice(0, 100);
}

function parseAgentRunFeedback(value: unknown): AgentRunFeedback | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<AgentRunFeedback>;
  if (candidate.verdict !== "useful" && candidate.verdict !== "needs_work") return undefined;
  return {
    verdict: candidate.verdict,
    correction: candidate.correction ? safeRunText(String(candidate.correction), 2_000) : undefined,
    updatedAt: candidate.updatedAt ? String(candidate.updatedAt) : new Date(0).toISOString(),
  };
}

function parseContinuation(value: unknown): AgentRunContinuation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.instructions !== "string" ||
    !candidate.pendingToolCall ||
    typeof (candidate.pendingToolCall as { executionId?: unknown }).executionId !== "string"
  ) {
    return undefined;
  }

  let executionScope: ExecutionScope | undefined;
  try {
    executionScope = parsePersistedExecutionScope(candidate.executionScope);
  } catch {
    return undefined;
  }
  let runContractEnvelope: RunContractEnvelopeV1 | undefined;
  try {
    runContractEnvelope = parseRunContractEnvelopeV1(
      candidate.runContractEnvelope,
    );
  } catch {
    return undefined;
  }

  return {
    executionScope,
    runContractEnvelope,
    conversationItems: Array.isArray(candidate.conversationItems)
      ? (candidate.conversationItems as Array<Record<string, unknown>>)
      : [],
    instructions: candidate.instructions,
    response: typeof candidate.response === "string" ? candidate.response : "",
    toolSteps: Number.isInteger(candidate.toolSteps) ? (candidate.toolSteps as number) : 0,
    outputsBeforeApproval: Array.isArray(candidate.outputsBeforeApproval)
      ? (candidate.outputsBeforeApproval as unknown[]).filter(isFunctionCallOutput)
      : [],
    pendingToolCall: {
      callId: String((candidate.pendingToolCall as { callId?: unknown }).callId || ""),
      toolId: String((candidate.pendingToolCall as { toolId?: unknown }).toolId || ""),
      toolName: String((candidate.pendingToolCall as { toolName?: unknown; toolId?: unknown }).toolName || (candidate.pendingToolCall as { toolId?: unknown }).toolId || ""),
      riskLevel: typeof (candidate.pendingToolCall as { riskLevel?: unknown }).riskLevel === "number" ? (candidate.pendingToolCall as { riskLevel: number }).riskLevel : undefined,
      executionId: (candidate.pendingToolCall as { executionId: string }).executionId,
    },
    context: {
      tenantId: String((candidate.context as { tenantId?: unknown })?.tenantId || "default"),
      actorId: String((candidate.context as { actorId?: unknown })?.actorId || "agent"),
      role: normalizeRole((candidate.context as { role?: unknown })?.role),
    },
    toolPolicy: parseToolPolicy(candidate.toolPolicy),
    memoryScope:
      candidate.memoryScope === "session" ||
      candidate.memoryScope === "project" ||
      candidate.memoryScope === "all"
        ? candidate.memoryScope
        : "all",
    citationSources: parseCitationSources(candidate.citationSources),
    providerToolState: parseProviderToolState(candidate.providerToolState),
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
    resumeClaimedAt:
      typeof candidate.resumeClaimedAt === "string"
        ? candidate.resumeClaimedAt
        : undefined,
  };
}

function parseToolPolicy(
  value: unknown,
): AgentRunContinuation["toolPolicy"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    !Array.isArray(candidate.allowedToolIds) ||
    typeof candidate.readOnly !== "boolean" ||
    typeof candidate.forceApproval !== "boolean"
  ) {
    return undefined;
  }
  return {
    allowedToolIds: candidate.allowedToolIds
      .filter((id): id is string => typeof id === "string")
      .map((id) => id.slice(0, 512))
      .slice(0, 50),
    readOnly: candidate.readOnly,
    forceApproval: candidate.forceApproval,
  };
}

function parseProviderToolState(
  value: unknown,
): AgentRunContinuation["providerToolState"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const provider = parseToolProvider(candidate.provider);
  const tier = candidate.tier === "fast" || candidate.tier === "reasoning"
    ? candidate.tier
    : undefined;
  const continuation = parseModelToolContinuation(candidate.continuation);
  const pendingCall = parseModelToolCall(candidate.pendingCall);
  if (
    !provider ||
    !tier ||
    typeof candidate.model !== "string" ||
    typeof candidate.prompt !== "string" ||
    !continuation ||
    continuation.provider !== provider ||
    !pendingCall ||
    !Array.isArray(candidate.queuedCalls) ||
    !Array.isArray(candidate.toolResultsBeforeApproval)
  ) {
    return undefined;
  }

  const queuedCalls = candidate.queuedCalls
    .map((call) => {
      const parsed = parseModelToolCall(call);
      if (!parsed) return undefined;
      const skipReason =
        call &&
        typeof call === "object" &&
        !Array.isArray(call) &&
        typeof (call as { skipReason?: unknown }).skipReason === "string"
          ? (call as { skipReason: string }).skipReason
          : undefined;
      return { ...parsed, skipReason };
    })
    .filter((call): call is NonNullable<typeof call> => Boolean(call));
  const toolResultsBeforeApproval = candidate.toolResultsBeforeApproval
    .map(parseModelToolResult)
    .filter((result): result is NonNullable<typeof result> => Boolean(result));

  return {
    provider,
    tier,
    model: candidate.model,
    prompt: candidate.prompt,
    continuation,
    pendingCall,
    queuedCalls,
    toolResultsBeforeApproval,
  };
}

function parseToolProvider(
  value: unknown,
): "openai" | "google" | "anthropic" | "aws_bedrock" | undefined {
  return value === "openai" ||
    value === "google" ||
    value === "anthropic" ||
    value === "aws_bedrock"
    ? value
    : undefined;
}

function parseModelToolContinuation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const provider = parseToolProvider(candidate.provider);
  if (!provider || !Array.isArray(candidate.state)) {
    return undefined;
  }
  const state = candidate.state.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && !Array.isArray(item)),
  );
  if (state.length !== candidate.state.length) {
    return undefined;
  }
  return { provider, state };
}

function parseModelToolCall(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.callId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.argumentsJson !== "string"
  ) {
    return undefined;
  }
  return {
    callId: candidate.callId,
    name: candidate.name,
    argumentsJson: candidate.argumentsJson,
  };
}

function parseModelToolResult(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.callId !== "string" ||
    typeof candidate.name !== "string" ||
    typeof candidate.output !== "string"
  ) {
    return undefined;
  }
  return {
    callId: candidate.callId,
    name: candidate.name,
    output: candidate.output,
    isError:
      typeof candidate.isError === "boolean" ? candidate.isError : undefined,
  };
}

function isFunctionCallOutput(value: unknown): value is AgentRunContinuation["outputsBeforeApproval"][number] {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "function_call_output" &&
    typeof (value as { call_id?: unknown }).call_id === "string" &&
    typeof (value as { output?: unknown }).output === "string",
  );
}

async function resolveAgentRunTenantId(runId: string) {
  const rows = await getSql()`
    SELECT tenant_id
    FROM omni_agent_runs
    WHERE id = ${runId}
    LIMIT 1
  `;
  return normalizeTenantId(rows[0]?.tenant_id ? String(rows[0].tenant_id) : getDatabaseTenantContext());
}

function getRunsFile() {
  return getDataPath("runs.json");
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function normalizeRole(value: unknown): AgentRunContinuation["context"]["role"] {
  return value === "viewer" || value === "operator" || value === "admin" || value === "system"
    ? value
    : "operator";
}
