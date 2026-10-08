import { createHash, randomUUID } from "node:crypto";
import {
  getDatabaseTenantContext,
  hasDatabaseUrl,
  ensureDatabaseSchema,
  getSql,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
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
  canonicalActorIdFromExactRequestBinding,
  type CanonicalRequestActorBindingV1,
} from "@/lib/security/canonical-actor";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import type { AgentEvent, AgentMode, ChatMessage } from "@/lib/orchestration/types";
import {
  parseLoopV2ContextBindingV1,
  type LoopV2ContextBindingV1,
} from "@/lib/orchestration/loop-v2-context-contract";
import { loopV2ExecutionScopeSha256 } from "@/lib/orchestration/loop-v2";
import type { CitationSource, GroundingReport } from "@/lib/rag/citations";
import { parseRuntimeClaimEvidenceV1 } from "@/lib/rag/claim-evidence-runtime";
import {
  parseContextCompilerV2AutomaticReceipt,
  parseContextCompilerV2CanaryReceipt,
  parseContextCompilerV2ShadowReceipt,
  type ContextCompilerV2AutomaticReceipt,
  type ContextCompilerV2CanaryReceipt,
  type ContextCompilerV2ShadowReceipt,
} from "@/lib/rag/context-compiler-v2";
import {
  parseContextUseReceiptV1,
  type ContextUseReceiptV1,
} from "@/lib/rag/context-use-receipt";
import {
  buildLegacyTerminalReceiptV1,
  buildRunContractEnvelopeV1,
  buildRunContractEventPayloadV1,
  parseRunContractEnvelopeV1,
  runContractIdSchema,
  runContractEventPayloadV1Schema,
  terminalReceiptV1Schema,
  type RunContractEnvelopeV1,
  type RunContractEventPayloadV1,
} from "@/lib/runs/contracts";
import { parsePersistedRunBudgetStateV1 } from "@/lib/runs/budgets";
import {
  parseApprovalCheckpointShadowEnrollment,
  recordApprovalWaitingCheckpointShadow,
} from "@/lib/runs/approval-checkpoint-shadow";
import {
  completeRunCheckpointResumeClaim,
  runCheckpointResumeClaimTokenSha256,
  type RunCheckpointResumeClaim,
} from "@/lib/runs/checkpoint-resume-claim";
import { recordRunEventCursor } from "@/lib/runs/event-cursor";
import type { AgentRunContinuation, AgentRunEventRecord, AgentRunFeedback, AgentRunRecord, RunLedger, RunStatus } from "@/lib/runs/types";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { recordAiUsage } from "@/lib/usage/ledger";
import { modelConversationSchema } from "@/lib/models/conversation";
import { parseCarriedDelegationReceipts } from "@/lib/delegation/receipt-summary";
import { commandModelSelectionRequestSchema } from "@/lib/models/command-selection";
import {
  agentRunIdentityPinV1Schema,
  parseAgentRunIdentityPinV1,
  type AgentRunIdentityPinV1,
} from "@/lib/agents/identity-contracts";

export async function createAgentRun(input: {
  /** Trusted server-owned identity for a new run. Never accept this from an unvalidated client. */
  id?: string;
  tenantId?: string;
  actorId?: string;
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
    id: input.id ? exactTrustedRunId(input.id) : randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
    ownerActorId: requiredOwnerActorId(
      input.actorId || (hasDatabaseUrl() ? "" : "local:file-runtime"),
    ),
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

  // A request-derived id reaches this insert again only when a retry or a
  // concurrent duplicate of one request races the original; neither may
  // overwrite or re-execute the run it already started.
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const inserted = await getSql()`
      INSERT INTO omni_agent_runs (
        id, tenant_id, owner_actor_id, thread_id, mode, status, prompt, messages, model, agent_id, specialist_ids, memory_context_count, started_at
      )
      VALUES (
        ${run.id}, ${run.tenantId}, ${run.ownerActorId}, ${run.threadId || null}, ${run.mode}, ${run.status}, ${run.prompt}, ${run.messages}::jsonb,
        ${run.model || null}, ${run.agentId}, ${run.specialistIds}, ${run.memoryContextCount}, ${run.startedAt}
      )
      ON CONFLICT (id) DO NOTHING
      RETURNING id
    `;
    if (!inserted[0]) throw new AgentRunAlreadyExistsError();
    return run;
  }

  let duplicate = false;
  await updateRunLedger((ledger) => {
    if (ledger.runs.some((existing) => existing.id === run.id)) {
      duplicate = true;
      return ledger;
    }
    ledger.runs.unshift(run);
    return ledger;
  });
  if (duplicate) throw new AgentRunAlreadyExistsError();
  return run;
}

/**
 * Persist a durable run before it is dispatched. The caller supplies a
 * deterministic id so supervisor retries converge on the same record.
 */
export async function createQueuedAgentRun(input: {
  id: string;
  tenantId?: string;
  actorId?: string;
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
    ownerActorId: requiredOwnerActorId(
      input.actorId || (hasDatabaseUrl() ? "" : "local:file-runtime"),
    ),
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
        id, tenant_id, owner_actor_id, mode, status, prompt, messages, model, agent_id,
        specialist_ids, memory_context_count, started_at
      )
      VALUES (
        ${run.id}, ${run.tenantId}, ${run.ownerActorId}, ${run.mode}, ${run.status}, ${run.prompt},
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

/** A run with this id already exists; the request that minted it owns it. */
export class AgentRunAlreadyExistsError extends Error {
  constructor() {
    super("This request is already running. Check Activity for its progress.");
    this.name = "AgentRunAlreadyExistsError";
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
    limit: 100,
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

export async function appendAgentRunIdentityPin(
  runId: string,
  pinValue: AgentRunIdentityPinV1,
  options: {
    tenantId: string;
    executionScope: ExecutionScope;
    requestActorBinding?: CanonicalRequestActorBindingV1;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(options.executionScope, tenantId);
  const pin = parseAgentRunIdentityPinV1(pinValue);
  const run = await getAgentRun(runId, { tenantId });
  if (
    pin.runId !== runId ||
    pin.tenantId !== tenantId ||
    !run ||
    pin.logicalAgentId !== run.agentId ||
    run.ownerActorId !== options.executionScope.initiatingActorId ||
    options.executionScope.executingPrincipalType !== "agent" ||
    options.executionScope.executingPrincipalId !== pin.principalId
  ) {
    throw new Error("Agent run identity pin does not match its run boundary.");
  }
  if (
    pin.actorId !== run.ownerActorId &&
    canonicalActorIdFromExactRequestBinding(
      run.ownerActorId,
      options.requestActorBinding,
    ) !== pin.actorId
  ) {
    throw new Error(
      "Agent run identity pin does not match its authenticated owner binding.",
    );
  }
  const boundScope = await getAgentRunExecutionScope(runId, { tenantId });
  if (!boundScope || !executionScopesEqual(boundScope, options.executionScope)) {
    throw new Error("Agent run identity pin scope does not match the run binding.");
  }
  return appendScopedDomainEvent({
    // The event id is deliberately run-scoped rather than pin-scoped. The
    // event store's idempotency check accepts an exact retry but rejects a
    // different payload, including concurrent attempts to rebind the run.
    id: `run-agent-identity:${runId}`,
    streamId: `run:${runId}`,
    type: "run.agent_identity.bound",
    payload: agentRunIdentityPinV1Schema.parse(pin),
    executionScope: options.executionScope,
  });
}

export async function getAgentRunIdentityPin(
  runId: string,
  options: { tenantId?: string } = {},
) {
  const events = await listStreamEvents(`run:${runId}`, {
    tenantId: normalizeTenantId(options.tenantId),
    limit: 2_000,
    order: "asc",
  });
  const pins = events.filter((event) => event.type === "run.agent_identity.bound");
  if (pins.length > 1) {
    throw new Error("Agent run has conflicting identity bindings.");
  }
  if (!pins[0]) return undefined;
  const { _executionScope: _scope, ...payload } = pins[0].payload;
  void _scope;
  return parseAgentRunIdentityPinV1(payload);
}

/**
 * Commits the metadata-only context authority selected for a context-aware
 * Loop v2 run. The fixed event identity turns a retry into either an exact
 * replay or a rejected attempt to rebind the run.
 */
export async function appendLoopV2ContextBinding(
  runId: string,
  bindingValue: LoopV2ContextBindingV1,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(options.executionScope, tenantId);
  const binding = parseLoopV2ContextBindingV1(bindingValue);
  const run = await getAgentRun(runId, { tenantId });
  if (
    !run ||
    binding.runId !== runId ||
    binding.tenantId !== tenantId ||
    binding.ownerActorId !== run.ownerActorId ||
    binding.agentPrincipalId !== options.executionScope.executingPrincipalId ||
    binding.executionScopeSha256 !== loopV2ExecutionScopeSha256(
      options.executionScope,
    )
  ) {
    throw new Error("Loop v2 context binding does not match its run.");
  }
  const boundScope = await getAgentRunExecutionScope(runId, { tenantId });
  if (!boundScope || !executionScopesEqual(boundScope, options.executionScope)) {
    throw new Error("Loop v2 context binding scope does not match the run.");
  }
  return appendScopedDomainEvent({
    id: `run-loop-v2-context:${runId}`,
    streamId: `run:${runId}`,
    type: "run.loop_v2.context_bound",
    payload: binding,
    executionScope: options.executionScope,
  });
}

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

export async function appendContextCompilerV2ShadowEvent(
  runId: string,
  receipt: ContextCompilerV2ShadowReceipt,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(options.executionScope, tenantId);
  const parsed = parseContextCompilerV2ShadowReceipt(receipt);
  if (parsed.runId !== runId || parsed.tenantId !== tenantId) {
    throw new Error("Context Compiler v2 receipt is bound to another run scope.");
  }
  const run = await getAgentRun(runId, { tenantId });
  if (!run) {
    throw new Error("Context Compiler v2 receipt requires an existing run.");
  }
  const boundScope = await getAgentRunExecutionScope(runId, { tenantId });
  if (!boundScope || !executionScopesEqual(boundScope, options.executionScope)) {
    throw new Error("Context Compiler v2 receipt scope does not match the run binding.");
  }
  return appendScopedDomainEvent({
    streamId: `run:${runId}`,
    type: "run.context_compiler_v2.shadow",
    payload: parsed,
    executionScope: options.executionScope,
  });
}

/** Shadow comparison telemetry cannot change the active run control path. */
export async function appendContextCompilerV2ShadowEventSafely(
  runId: string,
  receipt: ContextCompilerV2ShadowReceipt,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  try {
    return await appendContextCompilerV2ShadowEvent(runId, receipt, options);
  } catch (error) {
    console.warn(
      "Context Compiler v2 shadow event append failed.",
      String(redactSensitive(
        error instanceof Error ? error.message : "Unknown context compiler event error.",
      )).slice(0, 1_000),
    );
    return undefined;
  }
}

/**
 * The explicit-private canary receipt is a disclosure barrier: it must commit
 * before the selected context may be sent to a model, so this writer has no
 * best-effort variant.
 */
export async function appendContextCompilerV2CanaryEvent(
  runId: string,
  receipt: ContextCompilerV2CanaryReceipt,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(options.executionScope, tenantId);
  const parsed = parseContextCompilerV2CanaryReceipt(receipt);
  if (parsed.runId !== runId || parsed.tenantId !== tenantId) {
    throw new Error("Context Compiler v2 canary receipt is bound to another run scope.");
  }
  const run = await getAgentRun(runId, { tenantId });
  if (!run) {
    throw new Error("Context Compiler v2 canary receipt requires an existing run.");
  }
  const boundScope = await getAgentRunExecutionScope(runId, { tenantId });
  if (!boundScope || !executionScopesEqual(boundScope, options.executionScope)) {
    throw new Error("Context Compiler v2 canary receipt scope does not match the run binding.");
  }
  return appendScopedDomainEvent({
    streamId: `run:${runId}`,
    type: "run.context_compiler_v2.canary",
    payload: parsed,
    executionScope: options.executionScope,
  });
}

/**
 * Standing-consent personal context is also a strict disclosure barrier. The
 * authoritative automatic receipt must be durable before a model sees text.
 */
export async function appendContextCompilerV2AutomaticEvent(
  runId: string,
  receipt: ContextCompilerV2AutomaticReceipt,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(options.executionScope, tenantId);
  const parsed = parseContextCompilerV2AutomaticReceipt(receipt);
  if (parsed.runId !== runId || parsed.tenantId !== tenantId) {
    throw new Error(
      "Automatic Context Compiler v2 receipt is bound to another run scope.",
    );
  }
  const run = await getAgentRun(runId, { tenantId });
  if (!run) {
    throw new Error(
      "Automatic Context Compiler v2 receipt requires an existing run.",
    );
  }
  const boundScope = await getAgentRunExecutionScope(runId, { tenantId });
  if (!boundScope || !executionScopesEqual(boundScope, options.executionScope)) {
    throw new Error(
      "Automatic Context Compiler v2 receipt scope does not match the run binding.",
    );
  }
  return appendScopedDomainEvent({
    streamId: `run:${runId}`,
    type: "run.context_compiler_v2.automatic",
    payload: parsed,
    executionScope: options.executionScope,
  });
}

/**
 * Persists the content-free, user-lock-bound record of the saved context that
 * was actually compiled for a run. Locked selections fail closed if this
 * receipt cannot be committed before model disclosure.
 */
export async function appendContextUseReceiptEvent(
  runId: string,
  receipt: ContextUseReceiptV1,
  options: { tenantId: string; executionScope: ExecutionScope },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  assertExecutionScopeTenant(options.executionScope, tenantId);
  const parsed = parseContextUseReceiptV1(receipt);
  if (parsed.runId !== runId) {
    throw new Error("Context use receipt is bound to another run.");
  }
  const run = await getAgentRun(runId, { tenantId });
  if (!run) throw new Error("Context use receipt requires an existing run.");
  const boundScope = await getAgentRunExecutionScope(runId, { tenantId });
  if (!boundScope || !executionScopesEqual(boundScope, options.executionScope)) {
    throw new Error("Context use receipt scope does not match the run binding.");
  }
  return appendScopedDomainEvent({
    streamId: `run:${runId}`,
    type: "run.context.receipt",
    payload: parsed,
    executionScope: options.executionScope,
  });
}

export async function getRunContextUseReceipt(
  runId: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const events = await listStreamEvents(`run:${runId}`, {
    tenantId,
    limit: 2_000,
    order: "asc",
  });
  const event = [...events].reverse().find((item) =>
    item.type === "run.context.receipt"
  );
  if (!event) return undefined;
  const { _executionScope: _scope, ...payload } = event.payload;
  void _scope;
  return parseContextUseReceiptV1(payload);
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
  // The domain event shares the record's id, so a tail can read the record
  // back in stream order by joining on it.
  const domainEvent = {
    id: record.id,
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
    const persistedSeq = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
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
      return persistedDomainEvent.seq;
    }) as number | undefined;
    record.seq = persistedSeq;
    recordRunEventCursor(event, persistedSeq);
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
  record.seq = persistedDomainEvent?.seq;
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
  recordRunEventCursor(event, record.seq);
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
    case "clarification":
      return {
        schemaVersion,
        type: event.type,
        runId: event.runId,
        threadId: event.threadId,
        reasonCode: event.reasonCode,
        ...hashedTextFields("message", event.message),
      };
    case "research_progress":
      return {
        schemaVersion, type: event.type,
        depth: event.progress.depth, stage: event.progress.stage,
        searches: event.progress.searches, sourcesRead: event.progress.sourcesRead,
        questionCount: event.progress.questions.length,
        gapCount: event.progress.gaps.length,
        limitationCount: event.progress.limitations.length,
        reportStatus: event.progress.reportStatus,
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
        memoryFormation: event.memoryFormation,
        contextScope: event.contextScope,
        contextDecision: event.contextDecision,
        contextMode: event.contextMode,
        contextCount: event.contextCount,
        contextTraceId: event.contextTraceId,
        liveWeb: event.liveWeb,
        toolCount: event.toolCount,
        toolIds: event.toolIds,
        approvalToolCount: event.approvalToolCount,
        skillIds: event.skillIds,
        toolboxSha256: event.toolboxSha256,
        instructionsSha256: event.instructionsSha256,
        maxToolSteps: event.maxToolSteps,
        maxToolCallsPerTurn: event.maxToolCallsPerTurn,
        maxToolResultChars: event.maxToolResultChars,
        maxOutputTokens: event.maxOutputTokens,
        budgetLimits: event.budgetLimits,
        budgetLimitsSha256: event.budgetLimitsSha256,
        approvalPolicy: event.approvalPolicy,
        autonomy: event.autonomy,
        learningState: event.learningState,
        learningSampleSize: event.learningSampleSize,
        learningGuidanceCount: event.learningGuidanceCount,
        learningGuidanceSha256: event.learningGuidanceSha256,
        adaptationState: event.adaptationState,
        adaptationEvidenceCount: event.adaptationEvidenceCount,
        adaptationConfidence: event.adaptationConfidence,
        adaptationActivationVersions: event.adaptationActivationVersions,
        adaptationGuidanceSha256: event.adaptationGuidanceSha256,
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
        taskId: event.taskId,
        delegationId: event.delegationId,
        lifecycleState: event.lifecycleState,
        lifecycleRevision: event.lifecycleRevision,
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
    case "budget_exhausted":
      return {
        schemaVersion,
        type: event.type,
        dimension: event.dimension,
        limit: event.limit,
        attempted: event.attempted,
        requiresAuthorization: event.requiresAuthorization,
        ...hashedTextFields("message", event.message),
      };
    case "execution_target_retired":
      return {
        schemaVersion,
        type: event.type,
        code: event.code,
        target: event.target,
        ...hashedTextFields("message", event.message),
      };
    case "model_route_degraded":
      return {
        schemaVersion,
        type: event.type,
        outcome: event.outcome,
        code: event.code,
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
              claimEvidence: event.grounding.claimEvidence
                ? claimEvidenceEventSummary(event.grounding.claimEvidence)
                : undefined,
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

function claimEvidenceEventSummary(
  value: NonNullable<GroundingReport["claimEvidence"]>,
) {
  const map = value.claimEvidenceMap;
  const byState = Object.fromEntries(
    ["supported", "inferred", "disputed", "stale", "unsupported"].map(
      (state) => [
        state,
        map.claims.filter((claim) => claim.supportState === state).length,
      ],
    ),
  );
  return {
    schemaVersion: 1,
    claimEvidenceMapId: map.claimEvidenceMapId,
    claimEvidenceMapSha256: map.claimEvidenceMapSha256,
    structuralVerificationId:
      value.structuralVerification.structuralVerificationId,
    claimCount: map.claims.length,
    materialClaimCount: map.coverage.materialClaimCount,
    supportedMaterialClaimCount: map.coverage.supportedMaterialClaimCount,
    coverageBps: map.coverage.coverageBps,
    byState,
  };
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
  options: { tenantId?: string; executionScope?: ExecutionScope } = {},
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
    if (options.executionScope) {
      assertExecutionScopeTenant(options.executionScope, tenantId);
    }
    updated = await getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql`
          UPDATE omni_agent_runs
          SET feedback = ${feedback}::jsonb
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
            AND status = 'completed'
          RETURNING *
        `;
        if (!rows[0]) return undefined;
        await appendDomainEvent({
          tenantId,
          streamId: `run:${runId}`,
          type: "run.feedback",
          payload: {
            verdict: feedback.verdict,
            hasCorrection: Boolean(feedback.correction),
          },
          correlationId: options.executionScope?.correlationId || runId,
          executionScope: options.executionScope,
        }, { sql });
        return runFromRow(rows[0]);
      },
    ) as AgentRunRecord | undefined;
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

  if (updated && !hasDatabaseUrl()) {
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

export type AgentRunResumeFence = Readonly<{
  claim: RunCheckpointResumeClaim;
  executionScope: ExecutionScope;
}>;

export type AgentRunTerminalOptions = Readonly<{
  tenantId?: string;
  resumeFence?: AgentRunResumeFence;
  executionScope?: ExecutionScope;
  runContractEnvelope?: RunContractEnvelopeV1;
}>;

export async function completeAgentRun(
  runId: string,
  response: string,
  grounding?: GroundingReport,
  options: AgentRunTerminalOptions = {},
) {
  return setRunStatus(runId, "completed", { response, grounding }, options);
}

export async function failAgentRun(
  runId: string,
  error: string,
  options: AgentRunTerminalOptions = {},
) {
  return setRunStatus(runId, "failed", { error }, options);
}

export async function cancelAgentRun(
  runId: string,
  reason = "Canceled by the operator.",
  options: AgentRunTerminalOptions = {},
) {
  return setRunStatus(runId, "canceled", { error: reason }, options);
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
    const repaired = await runWithDatabaseSystemScope(
      `Repair stale agent runs for tenant ${tenantId}.`,
      () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const candidates = await sql`
          SELECT id, owner_actor_id, status
          FROM omni_agent_runs AS run
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
            AND NOT (
              status = 'resuming'
              AND continuation ? 'checkpointResumeClaim'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM omni_agent_loop_v2_checkpoints AS checkpoint
              WHERE checkpoint.tenant_id = run.tenant_id
                AND checkpoint.run_id = run.id
                AND checkpoint.lifecycle_state = 'active'
                AND checkpoint.sequence = (
                  SELECT MAX(latest.sequence)
                  FROM omni_agent_loop_v2_checkpoints AS latest
                  WHERE latest.tenant_id = run.tenant_id
                    AND latest.run_id = run.id
                )
            )
          FOR UPDATE SKIP LOCKED
        `;
        let count = 0;
        for (const candidate of candidates) {
          const runId = String(candidate.id);
          const actorId = requiredOwnerActorId(String(candidate.owner_actor_id));
          const priorStatus = String(candidate.status);
          const message = priorStatus === "resuming"
            ? "Approved run resume was interrupted; side effects were not replayed."
            : priorStatus === "queued"
              ? "Queued durable agent run expired before dispatch."
              : "Run timed out (function invocation limit exceeded).";
          const rows = await sql`
            UPDATE omni_agent_runs
            SET status = 'failed', error = ${message}, continuation = NULL,
                completed_at = NOW()
            WHERE id = ${runId} AND tenant_id = ${tenantId}
              AND status = ${priorStatus}
            RETURNING id
          `;
          if (!rows[0]) continue;
          const event: AgentEvent = { type: "error", message };
          await appendRunEventInTransaction({
            sql,
            tenantId,
            executionScope: createExecutionScope({
              tenantId,
              initiatingActorId: actorId,
              executingPrincipalType: "system",
              executingPrincipalId: "omniagent-maintenance",
              correlationId: runId,
              purpose: "run.repair_stale",
            }),
            record: {
              id: randomUUID(),
              tenantId,
              runId,
              type: event.type,
              payload: event,
              createdAt: new Date().toISOString(),
            },
            event,
          });
          count += 1;
        }
        return count;
      }),
    ) as number;
    return repaired;
  }
  let repaired = 0;
  const repairedRuns: Array<{ runId: string; message: string }> = [];
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
      repairedRuns.push({ runId: run.id, message: run.error });
      run.continuation = undefined;
      run.completedAt = new Date().toISOString();
    }
    return ledger;
  });
  for (const repairedRun of repairedRuns) {
    await appendRunEvent(repairedRun.runId, {
      type: "error",
      message: repairedRun.message,
    }, { tenantId });
  }
  return repaired;
}

export async function markAgentRunWaitingForApproval(
  runId: string,
  values: {
    response: string;
    continuation: AgentRunContinuation;
    message?: string;
  },
  options: { resumeFence?: AgentRunResumeFence } = {},
) {
  const tenantId = normalizeTenantId(values.continuation.context.tenantId);
  const executionId = values.continuation.pendingToolCall.executionId;
  const waitingEvent: AgentEvent = {
    type: "waiting_approval",
    executionId,
    toolId: values.continuation.pendingToolCall.toolId,
    message: values.message || "Run paused for governed tool approval.",
  };
  const waitingEventRecord: AgentRunEventRecord = {
    id: randomUUID(),
    tenantId,
    runId,
    type: waitingEvent.type,
    payload: redactSensitive(waitingEvent) as AgentEvent,
    createdAt: values.continuation.createdAt,
  };
  const resumeJobInput = {
    tenantId,
    type: "agent.resume" as const,
    dedupeKey: getAgentResumeJobDedupeKey(executionId),
    payload: {
      agentRunId: runId,
      executionId,
      actorId: values.continuation.context.actorId,
    },
    priority: 20,
    maxAttempts: 10,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const parked = await getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const resumeFence = options.resumeFence;
        if (resumeFence) {
          assertExecutionScopeTenant(resumeFence.executionScope, tenantId);
          if (
            resumeFence.claim.tenantId !== tenantId ||
            resumeFence.claim.runId !== runId
          ) {
            throw new Error("Agent next-wait fence changed its run scope.");
          }
        }
        const rows = resumeFence
          ? await sql.query(
              `UPDATE omni_agent_runs run
               SET status = 'waiting_approval', response = $3,
                   continuation = $4::jsonb, completed_at = NULL
               WHERE run.id = $1 AND run.tenant_id = $2
                 AND run.status = 'resuming'
                 AND EXISTS (
                   SELECT 1 FROM omni_run_checkpoint_resume_claims claim
                   WHERE claim.tenant_id = run.tenant_id
                     AND claim.run_id = run.id
                     AND claim.checkpoint_id = $5
                     AND claim.checkpoint_sha256 = $6
                     AND claim.operation_job_id = $7
                     AND claim.lease_generation = $8
                     AND claim.claim_token_sha256 = $9
                     AND claim.status = 'claimed'
                     AND claim.lease_expires_at > statement_timestamp()
                 )
               RETURNING run.id`,
              [
                runId,
                tenantId,
                values.response
                  ? safeRunText(values.response, 100_000)
                  : null,
                values.continuation,
                resumeFence.claim.checkpointId,
                resumeFence.claim.checkpointSha256,
                resumeFence.claim.operationJobId,
                resumeFence.claim.leaseGeneration,
                runCheckpointResumeClaimTokenSha256(
                  resumeFence.claim.claimToken,
                ),
              ],
            )
          : await sql`
              UPDATE omni_agent_runs
              SET status = 'waiting_approval',
                  response = ${values.response ? safeRunText(values.response, 100_000) : null},
                  continuation = ${values.continuation}::jsonb,
                  completed_at = NULL
              WHERE id = ${runId}
                AND tenant_id = ${tenantId}
                AND status IN ('running', 'resuming')
                AND NOT (
                  status = 'resuming'
                  AND continuation ? 'checkpointResumeClaim'
                )
              RETURNING id
            `;
        if (!rows[0]) {
          return { parked: false, resumeJob: undefined };
        }
        const resumeJob = await enqueueOperationJob(resumeJobInput, { sql });
        await recordApprovalWaitingCheckpointShadow({
          runId,
          continuation: values.continuation,
          executionScope: values.continuation.executionScope,
          runContractEnvelope: values.continuation.runContractEnvelope,
          enrollment: values.continuation.checkpointShadowEnrollment,
          approvalExecutionId: executionId,
          response: values.response,
          recordedAt: values.continuation.createdAt,
        }, sql);
        if (resumeFence) {
          const completed = await completeRunCheckpointResumeClaim({
            ...resumeFence.claim,
            executionScope: resumeFence.executionScope,
          }, sql);
          if (!completed) {
            throw new Error("Agent next-wait checkpoint fence became stale.");
          }
        }
        await appendRunEventInTransaction({
          sql,
          tenantId,
          executionScope: values.continuation.executionScope,
          record: waitingEventRecord,
          event: waitingEvent,
        });
        return { parked: true, resumeJob };
      },
    ) as {
      parked: boolean;
      resumeJob:
        | Awaited<ReturnType<typeof enqueueOperationJob>>
        | undefined;
    };
    if (parked.parked) {
      await appendLegacyRunTerminalReceiptSafely(
        runId,
        waitingEvent,
        waitingEventRecord.id,
        tenantId,
        values.continuation.executionScope,
        values.continuation.runContractEnvelope,
      );
    }
    return parked;
  }

  // File mode has no cross-file transaction. Pre-arm the durable job first;
  // the resume worker defers it while the continuation write is incomplete.
  if (options.resumeFence) {
    throw new Error("Checkpoint resume fences require Postgres.");
  }
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
  if (parked) {
    await appendRunEvent(runId, waitingEvent, {
      tenantId,
      executionScope: values.continuation.executionScope,
      runContractEnvelope: values.continuation.runContractEnvelope,
    });
  }
  return { parked, resumeJob };
}

/**
 * Conditional transition: only one caller can move a run from
 * waiting_approval to resuming. Returns false if another approval already
 * claimed the run, so concurrent decisions cannot double-resume it.
 */
export async function markAgentRunResuming(
  runId: string,
  options: { tenantId?: string; executionScope?: ExecutionScope } = {},
): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  const tenantId = options.tenantId
    ? normalizeTenantId(options.tenantId)
    : hasDatabaseUrl()
      ? await resolveAgentRunTenantId(runId)
      : normalizeTenantId();
  const event: AgentEvent = {
    type: "status",
    label: "resuming after approval",
    detail: "A governed tool approval resolved; continuing the same agent run.",
  };
  const record: AgentRunEventRecord = {
    id: randomUUID(),
    tenantId,
    runId,
    type: event.type,
    payload: event,
    createdAt: claimedAt,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const executionScope = options.executionScope ||
      await getAgentRunExecutionScope(runId, { tenantId });
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
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
          AND tenant_id = ${tenantId}
          AND status = 'waiting_approval'
        RETURNING id
      `;
      if (!rows[0]) return false;
      await appendRunEventInTransaction({
        sql,
        tenantId,
        executionScope,
        record,
        event,
      });
      return true;
    }) as Promise<boolean>;
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
  if (transitioned) {
    await appendRunEvent(runId, event, {
      tenantId: options.tenantId,
      executionScope: options.executionScope,
    });
  }
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

const RUN_EVENT_PAGE_DEFAULT = 200;
const RUN_EVENT_PAGE_MAX = 500;

/**
 * Lists a run's persisted events after a stream position, oldest first, for
 * a client resuming a dropped event stream. Positions come from the run's
 * `run:<id>` domain stream, which shares ids with the event records; records
 * written before that pairing have no position and are not listed.
 */
export async function listAgentRunEventsAfter(
  runId: string,
  options: { tenantId: string; afterSeq?: number; limit?: number },
): Promise<AgentRunEventRecord[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const afterSeq = Number.isSafeInteger(options.afterSeq) &&
      (options.afterSeq as number) > 0
    ? options.afterSeq as number
    : 0;
  const limit = Math.min(
    Math.max(Math.trunc(options.limit || RUN_EVENT_PAGE_DEFAULT), 1),
    RUN_EVENT_PAGE_MAX,
  );

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT record.id, record.tenant_id, record.run_id, record.type,
             record.payload, record.created_at, event.seq
      FROM omni_events event
      JOIN omni_agent_events record
        ON record.id = event.id
       AND record.tenant_id = event.tenant_id
      WHERE event.tenant_id = ${tenantId}
        AND event.stream_id = ${`run:${runId}`}
        AND event.seq > ${afterSeq}
        AND record.run_id = ${runId}
      ORDER BY event.seq ASC
      LIMIT ${limit}
    `;
    return rows.flatMap((row: Record<string, unknown>) => {
      const seq = Number(row.seq);
      const payload = row.payload;
      if (
        !Number.isSafeInteger(seq) ||
        !payload ||
        typeof payload !== "object" ||
        typeof (payload as { type?: unknown }).type !== "string"
      ) {
        return [];
      }
      return [{
        id: String(row.id),
        tenantId: String(row.tenant_id),
        runId: String(row.run_id),
        type: String(row.type),
        payload,
        createdAt: row.created_at instanceof Date
          ? row.created_at.toISOString()
          : String(row.created_at),
        seq,
      }];
    });
  }

  const ledger = await readRunLedger();
  return ledger.events
    .filter((event) =>
      event.runId === runId &&
      normalizeTenantId(event.tenantId) === tenantId &&
      typeof event.seq === "number" &&
      event.seq > afterSeq
    )
    .sort((left, right) => (left.seq as number) - (right.seq as number))
    .slice(0, limit);
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

/**
 * The run paused on each of these tool executions, keyed by execution id,
 * so an approval can link back to its conversation. The newest run wins
 * when two name the same execution.
 */
export async function findAgentRunsWaitingForToolApprovals(
  executionIds: readonly string[],
  options: { tenantId?: string } = {},
) {
  const boundedIds = [...new Set(
    executionIds.map((id) => id.trim()).filter(Boolean),
  )].slice(0, 200);
  const origins = new Map<
    string,
    { runId: string; threadId?: string; ownerActorId: string }
  >();
  if (!boundedIds.length) return origins;
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        id, owner_actor_id, thread_id,
        continuation->'pendingToolCall'->>'executionId' AS execution_id
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
        AND status IN ('waiting_approval', 'resuming')
        AND continuation->'pendingToolCall'->>'executionId' = ANY(${boundedIds}::text[])
      ORDER BY started_at DESC, id
    `;
    for (const row of rows) {
      const executionId = String(row.execution_id);
      if (origins.has(executionId)) continue;
      origins.set(executionId, {
        runId: String(row.id),
        threadId: row.thread_id ? String(row.thread_id) : undefined,
        ownerActorId: String(row.owner_actor_id || ""),
      });
    }
    return origins;
  }

  const ids = new Set(boundedIds);
  const ledger = await readRunLedger();
  for (const run of ledger.runs) {
    const executionId = run.continuation?.pendingToolCall.executionId;
    if (
      !executionId ||
      !ids.has(executionId) ||
      origins.has(executionId) ||
      (run.status !== "waiting_approval" && run.status !== "resuming") ||
      normalizeTenantId(run.tenantId) !== tenantId
    ) {
      continue;
    }
    origins.set(executionId, {
      runId: run.id,
      threadId: run.threadId,
      ownerActorId: run.ownerActorId,
    });
  }
  return origins;
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
        id, tenant_id, owner_actor_id, mode, status,
        LEFT(prompt, 2000) AS prompt,
        LEFT(response, 4000) AS response,
        error,
        CASE
          WHEN status IN ('waiting_approval', 'resuming') THEN continuation
          ELSE NULL
        END AS continuation,
        agent_id, specialist_ids,
        started_at, completed_at
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
      ORDER BY started_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(runFromRow).map(projectAgentRunSummary);
  }

  const ledger = await readRunLedger();
  return ledger.runs
    .filter((run) => normalizeTenantId(run.tenantId) === tenantId)
    .slice(0, boundedLimit)
    .map(projectAgentRunSummary);
}

function projectAgentRunSummary(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    prompt: run.prompt.slice(0, 2_000),
    messages: [],
    response: run.response?.slice(0, 4_000),
    grounding: undefined,
    feedback: undefined,
    continuation: ["waiting_approval", "resuming"].includes(run.status)
      ? run.continuation
      : undefined,
  };
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
  options: AgentRunTerminalOptions = {},
) {
  const completedAt = new Date().toISOString();
  const safeResponse = values.response
    ? safeRunText(values.response, 100_000)
    : undefined;
  const safeError = values.error ? safeRunText(values.error, 2_000) : undefined;
  const terminalEvent = redactSensitive(
    status === "completed"
      ? { type: "done", response: safeResponse || "", grounding: values.grounding }
      : status === "canceled"
        ? { type: "canceled", message: safeError || "Canceled." }
        : { type: "error", message: safeError || "Agent run failed." },
  ) as AgentEvent;
  const terminalEventRecord: AgentRunEventRecord = {
    id: randomUUID(),
    runId,
    type: terminalEvent.type,
    payload: terminalEvent,
    createdAt: completedAt,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = normalizeTenantId(options.tenantId);
    const executionScope = options.executionScope ||
      options.resumeFence?.executionScope ||
      await getAgentRunExecutionScope(runId, { tenantId });
    if (executionScope) {
      assertExecutionScopeTenant(executionScope, tenantId);
    }
    terminalEventRecord.tenantId = tenantId;
    if (options.resumeFence) {
      const resumeFence = options.resumeFence;
      assertExecutionScopeTenant(resumeFence.executionScope, tenantId);
      if (
        resumeFence.claim.tenantId !== tenantId ||
        resumeFence.claim.runId !== runId
      ) {
        throw new Error("Agent terminal fence changed its run scope.");
      }
      const changed = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql.query(
          `UPDATE omni_agent_runs run
           SET status = $3, response = $4, grounding = $5::jsonb,
               error = $6, continuation = NULL, completed_at = $7
           WHERE run.id = $1 AND run.tenant_id = $2
             AND run.status = 'resuming'
             AND EXISTS (
               SELECT 1 FROM omni_run_checkpoint_resume_claims claim
               WHERE claim.tenant_id = run.tenant_id
                 AND claim.run_id = run.id
                 AND claim.checkpoint_id = $8
                 AND claim.checkpoint_sha256 = $9
                 AND claim.operation_job_id = $10
                 AND claim.lease_generation = $11
                 AND claim.claim_token_sha256 = $12
                 AND claim.status = 'claimed'
                 AND claim.lease_expires_at > statement_timestamp()
             )
           RETURNING run.id`,
          [
            runId,
            tenantId,
            status,
            safeResponse || null,
            values.grounding || null,
            safeError || null,
            completedAt,
            resumeFence.claim.checkpointId,
            resumeFence.claim.checkpointSha256,
            resumeFence.claim.operationJobId,
            resumeFence.claim.leaseGeneration,
            runCheckpointResumeClaimTokenSha256(
              resumeFence.claim.claimToken,
            ),
          ],
        );
        if (!rows[0]) return false;
        const completed = await completeRunCheckpointResumeClaim({
          ...resumeFence.claim,
          executionScope: resumeFence.executionScope,
        }, sql);
        if (!completed) {
          throw new Error("Agent terminal checkpoint fence became stale.");
        }
        await appendRunEventInTransaction({
          sql,
          tenantId,
          executionScope,
          record: terminalEventRecord,
          event: terminalEvent,
        });
        return true;
      }) as boolean;
      if (changed) {
        await appendLegacyRunTerminalReceiptSafely(
          runId,
          terminalEvent,
          terminalEventRecord.id,
          tenantId,
          executionScope,
          options.runContractEnvelope,
        );
      }
      return changed;
    }
    let pendingExecutionId: string | undefined;
    const changed = await getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        if (status === "canceled") {
          const pending = await sql`
            SELECT continuation #>> '{pendingToolCall,executionId}' AS execution_id
            FROM omni_agent_runs
            WHERE id = ${runId} AND tenant_id = ${tenantId}
            FOR UPDATE
          `;
          pendingExecutionId = typeof pending[0]?.execution_id === "string"
            ? pending[0].execution_id
            : undefined;
        }
        const rows = await sql`
          UPDATE omni_agent_runs
          SET status = ${status}, response = ${safeResponse || null},
              grounding = ${values.grounding || null}::jsonb,
              error = ${safeError || null}, continuation = NULL,
              completed_at = ${completedAt}
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
            AND status NOT IN ('completed', 'failed', 'canceled')
            AND (
              ${status} = 'canceled'
              OR NOT (
                status = 'resuming'
                AND continuation ? 'checkpointResumeClaim'
              )
            )
          RETURNING id
        `;
        if (!rows[0]) return false;
        await appendRunEventInTransaction({
          sql,
          tenantId,
          executionScope,
          record: terminalEventRecord,
          event: terminalEvent,
        });
        return true;
      },
    ) as boolean;
    if (changed) {
      await appendLegacyRunTerminalReceiptSafely(
        runId,
        terminalEvent,
        terminalEventRecord.id,
        tenantId,
        executionScope,
        options.runContractEnvelope,
      );
      if (status === "canceled") {
        await withdrawCanceledRunApprovalsSafely({
          runId,
          tenantId,
          legacyExecutionId: pendingExecutionId,
          executionScope,
        });
      }
    }
    return changed;
  }

  if (options.resumeFence) {
    throw new Error("Checkpoint resume fences require Postgres.");
  }

  let changed = false;
  let pendingExecutionId: string | undefined;
  await updateFileRun(runId, (run) => {
    if (["completed", "failed", "canceled"].includes(run.status)) {
      return;
    }
    changed = true;
    pendingExecutionId = run.continuation?.pendingToolCall?.executionId;
    run.status = status;
    run.response = safeResponse;
    run.grounding = values.grounding;
    run.error = safeError;
    run.continuation = undefined;
    run.completedAt = completedAt;
  });
  if (changed) {
    await appendRunEvent(runId, terminalEvent, {
      tenantId: options.tenantId,
      executionScope: options.executionScope,
      runContractEnvelope: options.runContractEnvelope,
    });
    if (status === "canceled") {
      await withdrawCanceledRunApprovalsSafely({
        runId,
        tenantId: options.tenantId,
        legacyExecutionId: pendingExecutionId,
        executionScope: options.executionScope,
      });
    }
  }
  return changed;
}

/**
 * Withdraws a canceled run's pending approvals after the cancel commits. The
 * approval claim checks the run again, so a failure here is logged and the
 * cancel still stands.
 */
async function withdrawCanceledRunApprovalsSafely(input: {
  runId: string;
  tenantId?: string;
  legacyExecutionId?: string;
  executionScope?: ExecutionScope;
}) {
  try {
    const { withdrawAgentRunPendingToolExecutions } = await import(
      "@/lib/tools/audit-store"
    );
    await withdrawAgentRunPendingToolExecutions(input);
  } catch (error) {
    console.warn(
      "Canceled run approvals could not be withdrawn.",
      String(redactSensitive(
        error instanceof Error ? error.message : "Unknown withdrawal error.",
      )).slice(0, 1_000),
    );
  }
}

async function appendRunEventInTransaction(input: {
  sql: ReturnType<typeof getSql>;
  tenantId: string;
  executionScope?: ExecutionScope;
  record: AgentRunEventRecord;
  event: AgentEvent;
}) {
  await appendDomainEvent({
    id: input.record.id,
    streamId: `run:${input.record.runId}`,
    type: `run.${input.event.type}`,
    tenantId: input.tenantId,
    payload: domainEventPayload(input.event),
    correlationId: input.executionScope?.correlationId || input.record.runId,
    executionScope: input.executionScope,
  }, { sql: input.sql });
  await input.sql`
    INSERT INTO omni_agent_events (id, tenant_id, run_id, type, payload, created_at)
    VALUES (
      ${input.record.id}, ${input.tenantId}, ${input.record.runId},
      ${input.record.type}, ${input.record.payload}::jsonb,
      ${input.record.createdAt}
    )
  `;
}

function safeRunText(value: string, maxChars: number) {
  return String(redactSensitive(value)).slice(0, maxChars);
}

function safeRunId(value: string) {
  const safe = value.trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 200);
  if (!safe) throw new Error("Agent run identity is required.");
  return safe;
}

function exactTrustedRunId(value: string) {
  const safe = safeRunId(value);
  if (safe !== value) {
    throw new Error("Trusted agent run identity must already be a safe opaque id.");
  }
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
    ["queued", "running", "waiting_clarification", "waiting_approval", "resuming"].includes(run.status),
  );
  const terminal = ledger.runs.filter(
    (run) => !["queued", "running", "waiting_clarification", "waiting_approval", "resuming"].includes(run.status),
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
    ownerActorId: requiredOwnerActorId(String(row.owner_actor_id || "")),
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
    continuation: parseAgentRunContinuation(row.continuation),
    terminalReceipt: row.terminal_receipt
      ? terminalReceiptV1Schema.parse(row.terminal_receipt)
      : undefined,
    startedAt: normalizeDate(row.started_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    consolidatedAt: row.consolidated_at ? normalizeDate(row.consolidated_at) : undefined,
  });
}

function requiredOwnerActorId(value: string) {
  const actorId = value.trim();
  if (!actorId || actorId.length > 320 || actorId.includes("\0")) {
    throw new Error("Agent runs require a valid owner actor id.");
  }
  return actorId;
}

function sanitizeAgentRunRecord(run: AgentRunRecord): AgentRunRecord {
  const continuation = run.continuation
    ? sanitizeAgentRunContinuation(run.continuation)
    : undefined;
  return {
    ...run,
    prompt: String(redactSensitive(run.prompt)).slice(0, 20_000),
    messages: redactSensitive(run.messages) as ChatMessage[],
    response: run.response
      ? String(redactSensitive(run.response))
      : undefined,
    grounding: run.grounding
      ? sanitizeGroundingReport(run.grounding)
      : undefined,
    error: run.error
      ? String(redactSensitive(run.error)).slice(0, 2_000)
      : undefined,
    consolidationError: run.consolidationError
      ? String(redactSensitive(run.consolidationError)).slice(0, 2_000)
      : undefined,
    continuation,
  };
}

function sanitizeAgentRunContinuation(value: AgentRunContinuation) {
  const parsed = parseAgentRunContinuation(value);
  if (!parsed) return undefined;
  const redacted = redactSensitive(parsed) as AgentRunContinuation;
  return {
    ...redacted,
    // Token counts are bounded execution metadata, not provider credentials.
    // Preserve the validated numeric state after the generic key redactor.
    budgetState: parsed.budgetState,
    // Receipts hold only validated task IDs and states.
    ...(parsed.delegationReceipts
      ? { delegationReceipts: parsed.delegationReceipts }
      : {}),
  };
}

function sanitizeGroundingReport(report: GroundingReport): GroundingReport {
  const { claimEvidence, ...legacy } = report;
  const sanitizedLegacy = redactSensitive(legacy) as Omit<
    GroundingReport,
    "claimEvidence"
  >;
  return {
    ...sanitizedLegacy,
    claimEvidence: claimEvidence
      ? parseRuntimeClaimEvidenceV1(claimEvidence)
      : undefined,
  };
}

function parseGroundingReport(value: unknown): GroundingReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<GroundingReport>;
  if (!candidate.status || !["verified", "not_required", "missing", "invalid"].includes(candidate.status)) {
    return undefined;
  }
  let claimEvidence: GroundingReport["claimEvidence"];
  if (candidate.claimEvidence !== undefined) {
    try {
      claimEvidence = parseRuntimeClaimEvidenceV1(candidate.claimEvidence);
    } catch {
      claimEvidence = undefined;
    }
  }
  return {
    status: candidate.status,
    citedIds: parseCitationIds(candidate.citedIds),
    invalidIds: parseCitationIds(candidate.invalidIds),
    sources: parseCitationSources(candidate.sources),
    claimEvidence,
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

export function parseAgentRunContinuation(
  value: unknown,
): AgentRunContinuation | undefined {
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
  let authUserBinding: AgentRunContinuation["context"]["authUserBinding"];
  try {
    authUserBinding = parseContinuationAuthUserBinding(
      (candidate.context as { authUserBinding?: unknown } | undefined)
        ?.authUserBinding,
    );
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
  let checkpointShadowEnrollment:
    | AgentRunContinuation["checkpointShadowEnrollment"];
  try {
    checkpointShadowEnrollment = parseApprovalCheckpointShadowEnrollment(
      candidate.checkpointShadowEnrollment,
    );
  } catch {
    return undefined;
  }
  let checkpointResumeClaim: AgentRunContinuation["checkpointResumeClaim"];
  try {
    checkpointResumeClaim = parseCheckpointResumeClaimMetadata(
      candidate.checkpointResumeClaim,
    );
  } catch {
    return undefined;
  }
  const budgetState = candidate.budgetState === undefined
    ? undefined
    : parsePersistedRunBudgetStateV1(candidate.budgetState);
  if (candidate.budgetState !== undefined && !budgetState) return undefined;
  if (candidate.maxOutputTokens !== undefined && (
    !Number.isSafeInteger(candidate.maxOutputTokens) ||
    Number(candidate.maxOutputTokens) < 1 ||
    Number(candidate.maxOutputTokens) > 65_536
  )) return undefined;
  if (
    candidate.maxToolSteps !== undefined &&
    (
      !Number.isSafeInteger(candidate.maxToolSteps) ||
      Number(candidate.maxToolSteps) < 1
    )
  ) {
    return undefined;
  }
  if (
    candidate.computerUseTarget !== undefined &&
    candidate.computerUseTarget !== "isolated_browser" &&
    candidate.computerUseTarget !== "local_macos"
  ) {
    return undefined;
  }
  const canonicalConversation = candidate.canonicalConversation === undefined
    ? undefined
    : modelConversationSchema.safeParse(candidate.canonicalConversation);
  if (canonicalConversation && !canonicalConversation.success) return undefined;
  const commandModelSelection = candidate.commandModelSelection === undefined
    ? undefined
    : commandModelSelectionRequestSchema.safeParse(
        candidate.commandModelSelection,
      );
  if (commandModelSelection && !commandModelSelection.success) return undefined;
  const delegationReceipts = candidate.delegationReceipts === undefined
    ? undefined
    : parseCarriedDelegationReceipts(candidate.delegationReceipts);
  if (candidate.delegationReceipts !== undefined && !delegationReceipts) {
    return undefined;
  }

  return {
    computerUseTarget: candidate.computerUseTarget as
      | AgentRunContinuation["computerUseTarget"]
      | undefined,
    executionScope,
    runContractEnvelope,
    checkpointShadowEnrollment,
    checkpointResumeClaim,
    commandModelSelection: commandModelSelection?.success
      ? commandModelSelection.data
      : undefined,
    budgetState,
    conversationItems: Array.isArray(candidate.conversationItems)
      ? (candidate.conversationItems as Array<Record<string, unknown>>)
      : [],
    canonicalConversation: canonicalConversation?.success
      ? canonicalConversation.data
      : undefined,
    instructions: candidate.instructions,
    response: typeof candidate.response === "string" ? candidate.response : "",
    toolSteps: Number.isInteger(candidate.toolSteps) ? (candidate.toolSteps as number) : 0,
    maxOutputTokens: candidate.maxOutputTokens === undefined
      ? undefined
      : Number(candidate.maxOutputTokens),
    maxToolSteps: candidate.maxToolSteps === undefined
      ? undefined
      : Number(candidate.maxToolSteps),
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
      authUserBinding,
    },
    toolPolicy: parseToolPolicy(candidate.toolPolicy),
    memoryScope:
      candidate.memoryScope === "session" ||
      candidate.memoryScope === "project" ||
      candidate.memoryScope === "all"
        ? candidate.memoryScope
        : "all",
    memoryFormation:
      candidate.memoryFormation === "durable" ||
      candidate.memoryFormation === "withheld"
        ? candidate.memoryFormation
        : undefined,
    citationSources: parseCitationSources(candidate.citationSources),
    delegationReceipts,
    providerToolState: parseProviderToolState(candidate.providerToolState),
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
    resumeClaimedAt:
      typeof candidate.resumeClaimedAt === "string"
        ? candidate.resumeClaimedAt
        : undefined,
  };
}

function parseContinuationAuthUserBinding(
  value: unknown,
): AgentRunContinuation["context"]["authUserBinding"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Continuation auth-user binding is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (
    keys.join("\0") !== [
      "authUserId",
      "canonicalActorId",
      "email",
      "source",
      "version",
    ].sort().join("\0") ||
    candidate.version !== 1 ||
    (candidate.source !== "session" && candidate.source !== "mobile") ||
    typeof candidate.authUserId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(
      candidate.authUserId,
    ) ||
    typeof candidate.email !== "string" ||
    candidate.email !== candidate.email.trim() ||
    candidate.email.length < 3 ||
    candidate.email.length > 320 ||
    candidate.email.includes("\0") ||
    candidate.canonicalActorId !== `actor:${candidate.authUserId}`
  ) {
    throw new Error("Continuation auth-user binding is invalid.");
  }
  return Object.freeze({
    version: 1,
    source: candidate.source,
    authUserId: candidate.authUserId,
    email: candidate.email,
    canonicalActorId: candidate.canonicalActorId,
  });
}

function parseCheckpointResumeClaimMetadata(
  value: unknown,
): AgentRunContinuation["checkpointResumeClaim"] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Checkpoint resume claim metadata is invalid.");
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.leaseGeneration) ||
    Number(candidate.leaseGeneration) < 1 ||
    typeof candidate.checkpointSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.checkpointSha256)
  ) {
    throw new Error("Checkpoint resume claim metadata is invalid.");
  }
  return {
    schemaVersion: 1,
    checkpointId: runContractIdSchema.parse(candidate.checkpointId),
    checkpointSha256: candidate.checkpointSha256,
    operationJobId: runContractIdSchema.parse(candidate.operationJobId),
    leaseGeneration: Number(candidate.leaseGeneration),
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
    ...(typeof candidate.forceApprovalAboveRisk === "number" &&
        Number.isInteger(candidate.forceApprovalAboveRisk) &&
        candidate.forceApprovalAboveRisk >= 0 &&
        candidate.forceApprovalAboveRisk <= 3
      ? { forceApprovalAboveRisk: candidate.forceApprovalAboveRisk }
      : {}),
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
  const conversation = candidate.conversation === undefined
    ? undefined
    : modelConversationSchema.safeParse(candidate.conversation);
  if (conversation && !conversation.success) return undefined;
  return {
    provider,
    state,
    ...(conversation?.success ? { conversation: conversation.data } : {}),
  };
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
