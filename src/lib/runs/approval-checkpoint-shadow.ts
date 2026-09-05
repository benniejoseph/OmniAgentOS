import { z } from "zod";

import { hasDatabaseUrl } from "@/lib/db/client";
import { appendDomainEvent } from "@/lib/events/store";
import {
  getCurrentTenantCapabilityRollout,
  type TenantCapabilityRollout,
} from "@/lib/rollouts/tenant-capability-rollouts";
import {
  parseRunContractEnvelopeV1,
  runContractIdSchema,
  runContractSha256Schema,
  type RunContractEnvelopeV1,
} from "@/lib/runs/contracts";
import {
  recordRunCheckpointV1,
  type RunCheckpointWriterSql,
} from "@/lib/runs/checkpoint-store";
import {
  buildRunCheckpointV1,
  parseRunCheckpointV1,
  type RunCheckpointEnginePinV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import {
  deriveExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const RUN_CHECKPOINT_CAPABILITY_ID = "agent_run_checkpoints";
export const RUN_CHECKPOINT_ENGINE_VERSION_ID =
  "agent_approval_continuation_v1";
export const RUN_CHECKPOINT_CONTRACT_VERSION_ID = "run_checkpoint_v1";
export const RUN_CHECKPOINT_CONFIGURATION_SHA256 = canonicalJsonSha256({
  capabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
  engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID,
  contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  boundary: "approval_waiting",
  persistence: "shadow_only",
  resumeAuthority: false,
  schemaVersion: 1,
});
export const RUN_CHECKPOINT_CANARY_CONFIGURATION_SHA256 = canonicalJsonSha256({
  capabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
  engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID,
  contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  boundary: "approval_waiting",
  persistence: "checkpoint_v1",
  resumeAuthority: "token_fenced_read_only_canary",
  maxApprovalBoundaries: 1,
  schemaVersion: 1,
});
export const RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256 =
  canonicalJsonSha256({
    capabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
    engineVersionId: RUN_CHECKPOINT_ENGINE_VERSION_ID,
    contractVersionId: RUN_CHECKPOINT_CONTRACT_VERSION_ID,
    boundaries: ["model", "tool", "approval", "delegation", "verifier"],
    persistence: "shadow_only",
    resumeAuthority: false,
    schemaVersion: 1,
  });

const enginePinSchema = z.object({
  rolloutCapabilityId: runContractIdSchema,
  engineVersionId: runContractIdSchema,
  contractVersionId: runContractIdSchema,
  configurationSha256: runContractSha256Schema,
  runContractEnvelopeId: runContractIdSchema,
  runContractEnvelopeSha256: runContractSha256Schema,
  harnessManifestId: runContractIdSchema,
  harnessManifestSha256: runContractSha256Schema,
  rolloutMode: z.enum(["shadow", "canary"]),
  rolloutLifecycleStatus: z.literal("active"),
  rolloutGeneration: z.number().int().min(1).max(1_000_000_000),
  rolloutLifecycleRevision: z.number().int().min(1).max(1_000_000_000),
}).strict();

const approvalCheckpointShadowEnrollmentSchema = z.object({
  schemaVersion: z.literal(1),
  runId: runContractIdSchema,
  tenantId: runContractIdSchema,
  enrolledAt: z.string().datetime({ offset: true }),
  enginePin: enginePinSchema,
}).strict();

export type ApprovalCheckpointShadowEnrollment = Readonly<
  z.infer<typeof approvalCheckpointShadowEnrollmentSchema>
>;

type ApprovalCheckpointResourceUsage = Readonly<{
  modelCallCount: number;
  modelInputTokenCount: number;
  modelOutputTokenCount: number;
  cachedInputTokenCount: number;
  toolCallCount: number;
  toolResultByteCount: number;
  externalEffectCount: number;
  elapsedMs: number;
}>;

type ApprovalCheckpointState = Readonly<{
  runRecordSha256: string;
  approvalRequestSha256: string;
  toolExecutionSha256: string;
  continuationSha256: string;
}>;

export type ApprovalWaitingCheckpointShadowResult = Readonly<{
  checkpoint: RunCheckpointV1 | null;
  outcome: "recorded" | "not_enrolled" | "already_recorded" | "prior_effects";
  resumeAuthorityGranted: false;
}>;

export type ApprovalDecisionCheckpointShadowResult = Readonly<{
  checkpoint: RunCheckpointV1 | null;
  outcome: "recorded" | "not_enrolled" | "waiting_checkpoint_missing";
  resumeAuthorityGranted: false;
}>;

const approvalCheckpointComparisonPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  checkpointId: runContractIdSchema,
  checkpointSha256: runContractSha256Schema,
  runId: runContractIdSchema,
  boundaryKind: z.literal("approval"),
  boundaryPhase: z.enum(["waiting", "after"]),
  boundaryId: runContractIdSchema,
  comparison: z.literal("matched"),
  stateReferenceCount: z.number().int().min(1).max(64),
  externalEffectCount: z.number().int().min(0),
  resumeAuthorityGranted: z.literal(false),
}).strict();

/**
 * Enrolls only a newly starting Postgres run under an exact supported active
 * generation. Canary enrollment is additionally limited to read-only runs.
 * The immutable pin itself never grants resume authority.
 */
export async function resolveApprovalCheckpointShadowEnrollment(input: {
  runId: string;
  tenantId: string;
  executionScope: ExecutionScope;
  runContractEnvelope: RunContractEnvelopeV1;
  readOnly?: boolean;
  enrolledAt?: string;
}): Promise<ApprovalCheckpointShadowEnrollment | undefined> {
  if (!hasDatabaseUrl()) return undefined;

  const scope = parsePersistedExecutionScope(input.executionScope);
  const envelope = parseRunContractEnvelopeV1(input.runContractEnvelope);
  if (!scope || !envelope) {
    throw new Error("Checkpoint shadow enrollment requires exact run contracts.");
  }
  if (
    input.runId !== envelope.runId ||
    input.tenantId !== scope.tenantId
  ) {
    throw new Error("Checkpoint shadow enrollment changed its run scope.");
  }

  const rollout = await getCurrentTenantCapabilityRollout({
    tenantId: scope.tenantId,
    capabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
  });
  if (!isSupportedActiveCheckpointRollout(rollout)) return undefined;
  if (rollout.mode === "canary" && input.readOnly !== true) return undefined;

  return approvalCheckpointShadowEnrollmentSchema.parse({
    schemaVersion: 1,
    runId: input.runId,
    tenantId: scope.tenantId,
    enrolledAt: input.enrolledAt || new Date().toISOString(),
    enginePin: {
      rolloutCapabilityId: rollout.capabilityId,
      engineVersionId: rollout.engineVersion,
      contractVersionId: rollout.contractVersionId,
      configurationSha256: rollout.configurationSha256,
      runContractEnvelopeId: envelope.envelopeId,
      runContractEnvelopeSha256: canonicalJsonSha256(envelope),
      harnessManifestId: envelope.harnessManifest.harnessManifestId,
      harnessManifestSha256: canonicalJsonSha256(envelope.harnessManifest),
      rolloutMode: rollout.mode,
      rolloutLifecycleStatus: "active",
      rolloutGeneration: rollout.rolloutGeneration,
      rolloutLifecycleRevision: rollout.lifecycleRevision,
    },
  });
}

export function parseApprovalCheckpointShadowEnrollment(
  value: unknown,
): ApprovalCheckpointShadowEnrollment | undefined {
  if (value === undefined) return undefined;
  return approvalCheckpointShadowEnrollmentSchema.parse(value);
}

export function isExpandedCheckpointShadowEnrollment(
  value: ApprovalCheckpointShadowEnrollment | undefined,
): value is ApprovalCheckpointShadowEnrollment {
  return value?.enginePin.rolloutMode === "shadow" &&
    value.enginePin.configurationSha256 ===
      RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256;
}

/** Builds the metadata-only waiting checkpoint from already verified rows. */
export function buildApprovalWaitingCheckpointShadow(input: {
  runId: string;
  executionScope: ExecutionScope;
  runContractEnvelope: RunContractEnvelopeV1;
  enrollment: ApprovalCheckpointShadowEnrollment;
  parent?: RunCheckpointV1 | null;
  approvalExecutionId: string;
  state: ApprovalCheckpointState;
  resourceUsage: ApprovalCheckpointResourceUsage;
  recordedAt: string;
}): RunCheckpointV1 {
  const enrollment = approvalCheckpointShadowEnrollmentSchema.parse(
    input.enrollment,
  );
  const scope = parsePersistedExecutionScope(input.executionScope);
  const envelope = parseRunContractEnvelopeV1(input.runContractEnvelope);
  if (!scope || !envelope) {
    throw new Error("Approval checkpoint requires exact persisted contracts.");
  }
  assertEnrollmentBinding({
    enrollment,
    runId: input.runId,
    executionScope: scope,
    runContractEnvelope: envelope,
  });
  const parent = input.parent || null;
  if (
    parent &&
    (parent.runId !== input.runId ||
      parent.executionScope.tenantId !== scope.tenantId ||
      parent.enginePin.configurationSha256 !==
        enrollment.enginePin.configurationSha256 ||
      parent.lifecycleState !== "active" ||
      parent.resumeDisposition !== "resumable" ||
      parent.boundary.phase !== "after")
  ) {
    throw new Error("Approval checkpoint parent changed its active run binding.");
  }
  // Entering approval wait does not itself complete a model or tool call. The
  // legacy event projection includes the pending tool execution ID, so its
  // aggregate toolCallCount can be one ahead of an expanded checkpoint parent.
  // Preserve the parent's cumulative counters and advance only elapsed time;
  // the paired tool after-boundary records the completed call after approval.
  const resourceUsage = parent
    ? {
        modelCallCount: parent.resourceUsage.modelCallCount,
        modelInputTokenCount: parent.resourceUsage.modelInputTokenCount,
        modelOutputTokenCount: parent.resourceUsage.modelOutputTokenCount,
        cachedInputTokenCount: parent.resourceUsage.cachedInputTokenCount,
        toolCallCount: parent.resourceUsage.toolCallCount,
        toolResultByteCount: parent.resourceUsage.toolResultByteCount,
        externalEffectCount: parent.resourceUsage.externalEffectCount,
        elapsedMs: Math.max(
          parent.resourceUsage.elapsedMs,
          input.resourceUsage.elapsedMs,
        ),
      }
    : input.resourceUsage;

  return buildRunCheckpointV1({
    runId: input.runId,
    executionScope: scope,
    boundary: {
      kind: "approval",
      phase: "waiting",
      boundaryId: input.approvalExecutionId,
      attempt: 1,
    },
    sequence: parent ? parent.sequence + 1 : 0,
    parent: parent
      ? {
          checkpointId: parent.checkpointId,
          checkpointSha256: parent.checkpointSha256,
          sequence: parent.sequence,
        }
      : null,
    enginePin: enrollment.enginePin,
    stateReferences: [
      {
        kind: "run_record",
        referenceId: input.runId,
        referenceSha256: input.state.runRecordSha256,
        versionId: "agent_run_v1",
      },
      {
        kind: "harness_manifest",
        referenceId: envelope.harnessManifest.harnessManifestId,
        referenceSha256: enrollment.enginePin.harnessManifestSha256,
        versionId: "harness_manifest_v1",
      },
      {
        kind: "model_continuation",
        referenceId: `${input.runId}:continuation:${input.approvalExecutionId}`,
        referenceSha256: input.state.continuationSha256,
        versionId: "legacy_agent_continuation_v1",
      },
      {
        kind: "tool_execution",
        referenceId: input.approvalExecutionId,
        referenceSha256: input.state.toolExecutionSha256,
        versionId: "governed_tool_execution_v1",
      },
      {
        kind: "approval_request",
        referenceId: input.approvalExecutionId,
        referenceSha256: input.state.approvalRequestSha256,
        versionId: "governed_tool_approval_v1",
      },
    ],
    toolBinding: null,
    resourceUsage: {
      modelCallCount: resourceUsage.modelCallCount,
      modelInputTokenCount: resourceUsage.modelInputTokenCount,
      modelOutputTokenCount: resourceUsage.modelOutputTokenCount,
      cachedInputTokenCount: resourceUsage.cachedInputTokenCount,
      toolCallCount: resourceUsage.toolCallCount,
      toolResultByteCount: resourceUsage.toolResultByteCount,
      externalEffectCount: resourceUsage.externalEffectCount,
      boundaryExternalEffectCount: 0,
      elapsedMs: resourceUsage.elapsedMs,
    },
    lifecycleState: "waiting",
    resumeDisposition: "awaiting_signal",
    recordedAt: input.recordedAt,
  });
}

/**
 * Writes the first enrolled approval-wait boundary in the caller's canonical
 * continuation transaction. It is deliberately not a loader or resume claim.
 */
export async function recordApprovalWaitingCheckpointShadow(
  input: {
    runId: string;
    continuation: unknown;
    executionScope: ExecutionScope | undefined;
    runContractEnvelope: RunContractEnvelopeV1 | undefined;
    enrollment: ApprovalCheckpointShadowEnrollment | undefined;
    approvalExecutionId: string;
    response: string;
    recordedAt: string;
  },
  sql: RunCheckpointWriterSql,
): Promise<ApprovalWaitingCheckpointShadowResult> {
  if (!input.enrollment) return noCheckpoint("not_enrolled");
  if (!sql.transactionScoped) {
    throw new Error("Approval checkpoint shadow requires the run transaction.");
  }
  const enrollment = approvalCheckpointShadowEnrollmentSchema.parse(
    input.enrollment,
  );
  const scope = parsePersistedExecutionScope(input.executionScope);
  const envelope = parseRunContractEnvelopeV1(input.runContractEnvelope);
  if (!scope || !envelope) {
    throw new Error("Enrolled approval checkpoint lost its exact contracts.");
  }
  assertEnrollmentBinding({
    enrollment,
    runId: input.runId,
    executionScope: scope,
    runContractEnvelope: envelope,
  });

  const existing = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 1
     FOR SHARE`,
    [scope.tenantId, input.runId],
  );
  const parent = existing[0]
    ? parseRunCheckpointV1(existing[0].checkpoint_json)
    : null;
  if (
    parent &&
    !isExpandedCheckpointShadowEnrollment(enrollment)
  ) {
    return noCheckpoint("already_recorded");
  }
  if (
    parent &&
    parent.boundary.kind === "approval" &&
    parent.boundary.phase === "waiting" &&
    parent.boundary.boundaryId === input.approvalExecutionId
  ) {
    return Object.freeze({
      checkpoint: parent,
      outcome: "recorded" as const,
      resumeAuthorityGranted: false as const,
    });
  }

  const runRows = await sql.query(
    `SELECT id, tenant_id, status, response, continuation, started_at
     FROM omni_agent_runs
     WHERE id = $1 AND tenant_id = $2
     LIMIT 2
     FOR UPDATE`,
    [input.runId, scope.tenantId],
  );
  const runRow = exactlyOne(runRows, "approval checkpoint run");
  if (String(runRow.status) !== "waiting_approval") {
    throw new Error("Approval checkpoint run is not durably waiting.");
  }
  if (
    canonicalJsonSha256(runRow.continuation) !==
      canonicalJsonSha256(input.continuation)
  ) {
    throw new Error("Approval checkpoint continuation changed in storage.");
  }

  const toolRows = await sql.query(
    `SELECT id, tenant_id, actor_id, tool_id, tool_name, risk_level, status,
            dry_run, approval_required, input, output, reason, created_at
     FROM omni_tool_executions
     WHERE id = $1 AND COALESCE(tenant_id, 'default') = $2
     LIMIT 2
     FOR SHARE`,
    [input.approvalExecutionId, scope.tenantId],
  );
  const toolRow = exactlyOne(toolRows, "approval checkpoint tool execution");
  if (
    String(toolRow.status) !== "approval_required" ||
    toolRow.approval_required !== true ||
    toolRow.dry_run !== false ||
    String(toolRow.tool_id) === "" ||
    String(toolRow.actor_id || "") !== scope.initiatingActorId
  ) {
    throw new Error("Approval checkpoint tool request is not governed.");
  }

  const bindingRows = await sql.query(
    `SELECT payload
     FROM omni_events
     WHERE tenant_id = $1
       AND stream_id = $2
       AND type = 'tool.scope_bound'
     ORDER BY seq ASC
     LIMIT 2
     FOR SHARE`,
    [scope.tenantId, `tool_execution:${input.approvalExecutionId}`],
  );
  const bindingPayload = exactlyOne(
    bindingRows,
    "approval checkpoint tool scope",
  ).payload as Record<string, unknown>;
  const boundScope = parsePersistedExecutionScope(bindingPayload?._executionScope);
  const pendingToolCall = objectValue(
    objectValue(input.continuation).pendingToolCall,
  );
  const pendingCallId = typeof pendingToolCall.callId === "string"
    ? pendingToolCall.callId.trim()
    : "";
  if (!pendingCallId) {
    throw new Error("Approval checkpoint continuation lost its tool call ID.");
  }
  const expectedToolScope = deriveExecutionScope(scope, {
    causationId: pendingCallId,
    purpose: "agent.tool.execute",
  });
  if (
    !boundScope ||
    !executionScopesEqual(boundScope, expectedToolScope) ||
    String(bindingPayload.toolId || "") !== String(toolRow.tool_id) ||
    !runContractSha256Schema.safeParse(bindingPayload.inputSha256).success ||
    !runContractSha256Schema.safeParse(bindingPayload.scopeSha256).success
  ) {
    throw new Error("Approval checkpoint tool scope binding is invalid.");
  }

  const agentEventRows = await sql.query(
    `SELECT type, payload
     FROM omni_agent_events
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY created_at ASC, id ASC`,
    [scope.tenantId, input.runId],
  );
  const toolExecutionIds = uniqueToolExecutionIds(agentEventRows);
  const meteredToolRows = toolExecutionIds.length
    ? await sql.query(
        `SELECT id, status, output, effect_receipt
         FROM omni_tool_executions
         WHERE COALESCE(tenant_id, 'default') = $1
           AND id = ANY($2::text[])
         ORDER BY id ASC`,
        [scope.tenantId, toolExecutionIds],
      )
    : [];
  const usage = checkpointUsage(
    agentEventRows,
    meteredToolRows,
    String(runRow.started_at),
    input.recordedAt,
  );
  if (usage.externalEffectCount !== 0 && !parent) {
    return noCheckpoint("prior_effects");
  }

  const continuationSha256 = canonicalJsonSha256(input.continuation);
  const toolExecutionSha256 = canonicalJsonSha256({
    schemaVersion: 1,
    executionId: toolRow.id,
    tenantId: toolRow.tenant_id,
    actorId: toolRow.actor_id,
    toolId: toolRow.tool_id,
    riskLevel: toolRow.risk_level,
    status: toolRow.status,
    dryRun: toolRow.dry_run,
    approvalRequired: toolRow.approval_required,
    inputSha256: bindingPayload.inputSha256,
    scopeSha256: bindingPayload.scopeSha256,
    createdAt: canonicalTimestamp(toolRow.created_at),
  });
  const approvalRequestSha256 = canonicalJsonSha256({
    schemaVersion: 1,
    executionId: input.approvalExecutionId,
    toolExecutionSha256,
    toolId: toolRow.tool_id,
    riskLevel: toolRow.risk_level,
    status: "approval_required",
    approvalRequired: true,
    requesterRole: bindingPayload.requesterRole,
    createdAt: canonicalTimestamp(toolRow.created_at),
  });
  const runRecordSha256 = canonicalJsonSha256({
    schemaVersion: 1,
    runId: input.runId,
    tenantId: scope.tenantId,
    status: "waiting_approval",
    approvalExecutionId: input.approvalExecutionId,
    continuationSha256,
    responseSha256: canonicalJsonSha256(input.response),
    startedAt: canonicalTimestamp(runRow.started_at),
  });

  const checkpoint = buildApprovalWaitingCheckpointShadow({
    runId: input.runId,
    executionScope: scope,
    runContractEnvelope: envelope,
    enrollment,
    parent,
    approvalExecutionId: input.approvalExecutionId,
    state: {
      runRecordSha256,
      approvalRequestSha256,
      toolExecutionSha256,
      continuationSha256,
    },
    resourceUsage: usage,
    recordedAt: input.recordedAt,
  });
  await recordRunCheckpointV1({ checkpoint, executionScope: scope }, sql);
  await appendCheckpointComparisonEvent(checkpoint, scope, sql);
  return Object.freeze({
    checkpoint,
    outcome: "recorded" as const,
    resumeAuthorityGranted: false as const,
  });
}

/**
 * Records the matching approval decision before an approved effect executes,
 * or alongside a rejected tool decision. The legacy run remains authoritative.
 */
export async function recordApprovalDecisionCheckpointShadow(
  input: {
    tenantId: string;
    approvalExecutionId: string;
    decision: "approved" | "rejected";
  },
  sql: RunCheckpointWriterSql,
): Promise<ApprovalDecisionCheckpointShadowResult> {
  if (!sql.transactionScoped) {
    throw new Error("Approval checkpoint decision requires the tool transaction.");
  }
  const runRows = await sql.query(
    `SELECT id, tenant_id, status, response, continuation, started_at
     FROM omni_agent_runs
     WHERE tenant_id = $1
       AND status = 'waiting_approval'
       AND continuation->'pendingToolCall'->>'executionId' = $2
     ORDER BY id ASC
     LIMIT 2
     FOR SHARE`,
    [input.tenantId, input.approvalExecutionId],
  );
  if (runRows.length === 0) return noDecisionCheckpoint("not_enrolled");
  const runRow = exactlyOne(runRows, "approval decision run");
  const continuation = objectValue(runRow.continuation);
  const enrollment = parseApprovalCheckpointShadowEnrollment(
    continuation.checkpointShadowEnrollment,
  );
  if (!enrollment) return noDecisionCheckpoint("not_enrolled");
  const scope = parsePersistedExecutionScope(continuation.executionScope);
  const envelope = parseRunContractEnvelopeV1(
    continuation.runContractEnvelope,
  );
  if (!scope || !envelope) {
    throw new Error("Approval decision checkpoint lost its exact contracts.");
  }
  assertEnrollmentBinding({
    enrollment,
    runId: String(runRow.id),
    executionScope: scope,
    runContractEnvelope: envelope,
  });
  if (scope.tenantId !== input.tenantId) {
    throw new Error("Approval decision checkpoint changed tenant scope.");
  }

  const checkpointRows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 2
     FOR SHARE`,
    [scope.tenantId, String(runRow.id)],
  );
  if (checkpointRows.length === 0) {
    return noDecisionCheckpoint("waiting_checkpoint_missing");
  }
  const parent = parseRunCheckpointV1(
    exactlyOne(checkpointRows, "approval waiting checkpoint").checkpoint_json,
  );
  if (
    parent.boundary.kind !== "approval" ||
    parent.boundary.phase !== "waiting" ||
    parent.boundary.boundaryId !== input.approvalExecutionId ||
    parent.lifecycleState !== "waiting" ||
    parent.resumeDisposition !== "awaiting_signal"
  ) {
    throw new Error("Approval decision checkpoint has the wrong waiting parent.");
  }

  const toolRows = await sql.query(
    `SELECT id, tenant_id, actor_id, tool_id, tool_name, risk_level, status,
            dry_run, approval_required, approval_decision, approved_by,
            approved_at, input, output, reason, effect_receipt, created_at
     FROM omni_tool_executions
     WHERE id = $1 AND COALESCE(tenant_id, 'default') = $2
     LIMIT 2
     FOR SHARE`,
    [input.approvalExecutionId, scope.tenantId],
  );
  const toolRow = exactlyOne(toolRows, "approval decision tool execution");
  const expectedStatus = input.decision === "approved" ? "executing" : "rejected";
  if (
    String(toolRow.status) !== expectedStatus ||
    String(toolRow.approval_decision) !== input.decision ||
    toolRow.effect_receipt != null
  ) {
    throw new Error("Approval decision checkpoint observed an invalid tool state.");
  }

  const bindingPayload = await toolScopeBindingPayload(
    sql,
    scope.tenantId,
    input.approvalExecutionId,
  );
  const pendingToolCall = objectValue(continuation.pendingToolCall);
  const pendingCallId = typeof pendingToolCall.callId === "string"
    ? pendingToolCall.callId.trim()
    : "";
  if (!pendingCallId) {
    throw new Error("Approval decision continuation lost its tool call ID.");
  }
  const expectedToolScope = deriveExecutionScope(scope, {
    causationId: pendingCallId,
    purpose: "agent.tool.execute",
  });
  assertToolScopeBinding(bindingPayload, toolRow, expectedToolScope);

  const decisionEventType = input.decision === "approved"
    ? "tool.approval.recorded"
    : "tool.approval.rejected";
  const decisionOutcome = input.decision === "approved"
    ? "execution_claimed"
    : "rejected";
  const decisionRows = await sql.query(
    `SELECT id, type, actor_id, payload, at
     FROM omni_events
     WHERE tenant_id = $1
       AND stream_id = $2
       AND type = $3
       AND payload->>'outcome' = $4
     ORDER BY seq DESC
     LIMIT 2
     FOR SHARE`,
    [
      scope.tenantId,
      `tool_execution:${input.approvalExecutionId}`,
      decisionEventType,
      decisionOutcome,
    ],
  );
  const decisionRow = exactlyOne(
    decisionRows,
    "approval decision event",
  );
  const decisionPayload = objectValue(decisionRow.payload);
  if (
    String(decisionPayload.executionId) !== input.approvalExecutionId ||
    String(decisionPayload.decision) !== input.decision
  ) {
    throw new Error("Approval decision event changed its execution binding.");
  }

  const toolExecutionSha256 = toolExecutionStateSha256(
    toolRow,
    bindingPayload,
  );
  const decisionSha256 = canonicalJsonSha256({
    schemaVersion: 1,
    eventId: decisionRow.id,
    type: decisionRow.type,
    actorId: decisionRow.actor_id,
    payload: decisionPayload,
    at: canonicalTimestamp(decisionRow.at),
  });
  const stateReferences = parent.stateReferences
    .filter((reference) =>
      reference.kind !== "tool_execution" &&
      reference.kind !== "approval_decision"
    )
    .concat([
      {
        kind: "tool_execution" as const,
        referenceId: input.approvalExecutionId,
        referenceSha256: toolExecutionSha256,
        versionId: "governed_tool_execution_v1",
      },
      {
        kind: "approval_decision" as const,
        referenceId: input.approvalExecutionId,
        referenceSha256: decisionSha256,
        versionId: "governed_tool_approval_v1",
      },
    ]);
  const usage = parent.resourceUsage;
  const checkpoint = buildRunCheckpointV1({
    runId: parent.runId,
    executionScope: scope,
    boundary: {
      ...parent.boundary,
      phase: "after",
    },
    sequence: parent.sequence + 1,
    parent: {
      checkpointId: parent.checkpointId,
      checkpointSha256: parent.checkpointSha256,
      sequence: parent.sequence,
    },
    enginePin: enrollment.enginePin,
    stateReferences,
    toolBinding: null,
    resourceUsage: {
      modelCallCount: usage.modelCallCount,
      modelInputTokenCount: usage.modelInputTokenCount,
      modelOutputTokenCount: usage.modelOutputTokenCount,
      cachedInputTokenCount: usage.cachedInputTokenCount,
      toolCallCount: usage.toolCallCount,
      toolResultByteCount: usage.toolResultByteCount,
      externalEffectCount: usage.externalEffectCount,
      boundaryExternalEffectCount: 0,
      elapsedMs: usage.elapsedMs,
    },
    lifecycleState: input.decision === "approved" ? "active" : "terminal",
    resumeDisposition: input.decision === "approved"
      ? "resumable"
      : "not_resumable",
    recordedAt: canonicalTimestamp(decisionRow.at),
  });
  await recordRunCheckpointV1({ checkpoint, executionScope: scope }, sql);
  await appendCheckpointComparisonEvent(checkpoint, scope, sql);
  return Object.freeze({
    checkpoint,
    outcome: "recorded" as const,
    resumeAuthorityGranted: false as const,
  });
}

function isSupportedActiveCheckpointRollout(
  rollout: TenantCapabilityRollout | null,
): rollout is TenantCapabilityRollout {
  const supportedConfiguration = rollout?.mode === "canary"
    ? rollout.configurationSha256 === RUN_CHECKPOINT_CANARY_CONFIGURATION_SHA256
    : rollout?.configurationSha256 === RUN_CHECKPOINT_CONFIGURATION_SHA256 ||
      rollout?.configurationSha256 ===
        RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256;
  return Boolean(
    rollout &&
      rollout.capabilityId === RUN_CHECKPOINT_CAPABILITY_ID &&
      rollout.engineVersion === RUN_CHECKPOINT_ENGINE_VERSION_ID &&
      rollout.contractVersionId === RUN_CHECKPOINT_CONTRACT_VERSION_ID &&
      supportedConfiguration &&
      (rollout.mode === "shadow" || rollout.mode === "canary") &&
      rollout.status === "active",
  );
}

function assertEnrollmentBinding(input: {
  enrollment: ApprovalCheckpointShadowEnrollment;
  runId: string;
  executionScope: ExecutionScope;
  runContractEnvelope: RunContractEnvelopeV1;
}) {
  const { enrollment, executionScope, runContractEnvelope } = input;
  const supportedConfiguration = enrollment.enginePin.rolloutMode === "canary"
    ? enrollment.enginePin.configurationSha256 ===
      RUN_CHECKPOINT_CANARY_CONFIGURATION_SHA256
    : enrollment.enginePin.configurationSha256 ===
        RUN_CHECKPOINT_CONFIGURATION_SHA256 ||
      enrollment.enginePin.configurationSha256 ===
        RUN_CHECKPOINT_EXPANDED_SHADOW_CONFIGURATION_SHA256;
  if (
    enrollment.runId !== input.runId ||
    enrollment.tenantId !== executionScope.tenantId ||
    runContractEnvelope.runId !== input.runId ||
    enrollment.enginePin.rolloutCapabilityId !== RUN_CHECKPOINT_CAPABILITY_ID ||
    enrollment.enginePin.engineVersionId !== RUN_CHECKPOINT_ENGINE_VERSION_ID ||
    enrollment.enginePin.contractVersionId !== RUN_CHECKPOINT_CONTRACT_VERSION_ID ||
    !supportedConfiguration ||
    enrollment.enginePin.runContractEnvelopeId !==
      runContractEnvelope.envelopeId ||
    enrollment.enginePin.runContractEnvelopeSha256 !==
      canonicalJsonSha256(runContractEnvelope) ||
    enrollment.enginePin.harnessManifestId !==
      runContractEnvelope.harnessManifest.harnessManifestId ||
    enrollment.enginePin.harnessManifestSha256 !==
      canonicalJsonSha256(runContractEnvelope.harnessManifest)
  ) {
    throw new Error("Approval checkpoint enrollment binding changed.");
  }
}

async function toolScopeBindingPayload(
  sql: RunCheckpointWriterSql,
  tenantId: string,
  executionId: string,
) {
  const bindingRows = await sql.query(
    `SELECT payload
     FROM omni_events
     WHERE tenant_id = $1
       AND stream_id = $2
       AND type = 'tool.scope_bound'
     ORDER BY seq ASC
     LIMIT 2
     FOR SHARE`,
    [tenantId, `tool_execution:${executionId}`],
  );
  return objectValue(
    exactlyOne(bindingRows, "approval checkpoint tool scope").payload,
  );
}

function assertToolScopeBinding(
  bindingPayload: Record<string, unknown>,
  toolRow: Record<string, unknown>,
  expectedToolScope: ExecutionScope,
) {
  const boundScope = parsePersistedExecutionScope(bindingPayload._executionScope);
  if (
    !boundScope ||
    !executionScopesEqual(boundScope, expectedToolScope) ||
    String(bindingPayload.toolId || "") !== String(toolRow.tool_id) ||
    !runContractSha256Schema.safeParse(bindingPayload.inputSha256).success ||
    !runContractSha256Schema.safeParse(bindingPayload.scopeSha256).success
  ) {
    throw new Error("Approval checkpoint tool scope binding is invalid.");
  }
}

function toolExecutionStateSha256(
  toolRow: Record<string, unknown>,
  bindingPayload: Record<string, unknown>,
) {
  return canonicalJsonSha256({
    schemaVersion: 1,
    executionId: toolRow.id,
    tenantId: toolRow.tenant_id,
    actorId: toolRow.actor_id,
    toolId: toolRow.tool_id,
    riskLevel: toolRow.risk_level,
    status: toolRow.status,
    dryRun: toolRow.dry_run,
    approvalRequired: toolRow.approval_required,
    approvalDecision: toolRow.approval_decision || null,
    approvedBy: toolRow.approved_by || null,
    approvedAt: toolRow.approved_at
      ? canonicalTimestamp(toolRow.approved_at)
      : null,
    inputSha256: bindingPayload.inputSha256,
    scopeSha256: bindingPayload.scopeSha256,
    createdAt: canonicalTimestamp(toolRow.created_at),
  });
}

async function appendCheckpointComparisonEvent(
  checkpoint: RunCheckpointV1,
  executionScope: ExecutionScope,
  sql: RunCheckpointWriterSql,
) {
  const payload = approvalCheckpointComparisonPayloadSchema.parse({
    schemaVersion: 1,
    checkpointId: checkpoint.checkpointId,
    checkpointSha256: checkpoint.checkpointSha256,
    runId: checkpoint.runId,
    boundaryKind: "approval",
    boundaryPhase: checkpoint.boundary.phase,
    boundaryId: checkpoint.boundary.boundaryId,
    comparison: "matched",
    stateReferenceCount: checkpoint.stateReferences.length,
    externalEffectCount: checkpoint.resourceUsage.externalEffectCount,
    resumeAuthorityGranted: false,
  });
  await appendDomainEvent({
    id: `run-checkpoint-shadow-compared:${checkpoint.checkpointSha256}`,
    streamId: `run:${checkpoint.runId}`,
    type: "run.checkpoint.shadow_compared",
    tenantId: executionScope.tenantId,
    actorId: executionScope.initiatingActorId || undefined,
    correlationId: executionScope.correlationId,
    causationId: executionScope.causationId || undefined,
    executionScope,
    payload,
  }, { sql });
}

function checkpointUsage(
  agentEvents: Record<string, unknown>[],
  toolRows: Record<string, unknown>[],
  startedAt: string,
  recordedAt: string,
): ApprovalCheckpointResourceUsage {
  let modelCallCount = 0;
  let modelInputTokenCount = 0;
  let modelOutputTokenCount = 0;
  let cachedInputTokenCount = 0;
  for (const row of agentEvents) {
    if (String(row.type) !== "model") continue;
    const payload = objectValue(row.payload);
    modelCallCount += 1;
    modelInputTokenCount += boundedCounter(payload.inputTokens);
    modelOutputTokenCount += boundedCounter(payload.outputTokens);
    cachedInputTokenCount += boundedCounter(payload.cachedInputTokens);
  }
  return Object.freeze({
    modelCallCount,
    modelInputTokenCount,
    modelOutputTokenCount,
    cachedInputTokenCount,
    toolCallCount: uniqueToolExecutionIds(agentEvents).length,
    toolResultByteCount: toolRows.reduce((total, row) => {
      if (String(row.status) === "approval_required" || row.output == null) {
        return total;
      }
      return total + Buffer.byteLength(JSON.stringify(row.output), "utf8");
    }, 0),
    externalEffectCount: toolRows.filter((row) => row.effect_receipt != null)
      .length,
    elapsedMs: Math.max(
      0,
      Date.parse(recordedAt) - Date.parse(canonicalTimestamp(startedAt)),
    ),
  });
}

function uniqueToolExecutionIds(rows: Record<string, unknown>[]) {
  return [...new Set(rows.flatMap((row) => {
    if (String(row.type) !== "tool") return [];
    const executionId = objectValue(row.payload).executionId;
    return typeof executionId === "string" && executionId.trim()
      ? [executionId.trim()]
      : [];
  }))].sort();
}

function boundedCounter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function canonicalTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Approval checkpoint timestamp is invalid.");
  }
  return date.toISOString();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function exactlyOne(rows: Record<string, unknown>[], label: string) {
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one ${label}.`);
  }
  return rows[0] as Record<string, unknown>;
}

function noCheckpoint(
  outcome: Exclude<ApprovalWaitingCheckpointShadowResult["outcome"], "recorded">,
): ApprovalWaitingCheckpointShadowResult {
  return Object.freeze({
    checkpoint: null,
    outcome,
    resumeAuthorityGranted: false as const,
  });
}

function noDecisionCheckpoint(
  outcome: Exclude<ApprovalDecisionCheckpointShadowResult["outcome"], "recorded">,
): ApprovalDecisionCheckpointShadowResult {
  return Object.freeze({
    checkpoint: null,
    outcome,
    resumeAuthorityGranted: false as const,
  });
}

export type { RunCheckpointEnginePinV1 };
