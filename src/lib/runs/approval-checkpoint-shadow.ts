import { z } from "zod";

import { hasDatabaseUrl } from "@/lib/db/client";
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

const enginePinSchema = z.object({
  rolloutCapabilityId: runContractIdSchema,
  engineVersionId: runContractIdSchema,
  contractVersionId: runContractIdSchema,
  configurationSha256: runContractSha256Schema,
  runContractEnvelopeId: runContractIdSchema,
  runContractEnvelopeSha256: runContractSha256Schema,
  harnessManifestId: runContractIdSchema,
  harnessManifestSha256: runContractSha256Schema,
  rolloutMode: z.literal("shadow"),
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

/**
 * Enrolls only a newly starting Postgres run under the exact active shadow
 * generation. The immutable pin is carried with the legacy continuation; it
 * never grants resume authority.
 */
export async function resolveApprovalCheckpointShadowEnrollment(input: {
  runId: string;
  tenantId: string;
  executionScope: ExecutionScope;
  runContractEnvelope: RunContractEnvelopeV1;
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
  if (!isSupportedActiveShadowRollout(rollout)) return undefined;

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
      rolloutMode: "shadow",
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

/** Builds the metadata-only waiting checkpoint from already verified rows. */
export function buildApprovalWaitingCheckpointShadow(input: {
  runId: string;
  executionScope: ExecutionScope;
  runContractEnvelope: RunContractEnvelopeV1;
  enrollment: ApprovalCheckpointShadowEnrollment;
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

  return buildRunCheckpointV1({
    runId: input.runId,
    executionScope: scope,
    boundary: {
      kind: "approval",
      phase: "waiting",
      boundaryId: input.approvalExecutionId,
      attempt: 1,
    },
    sequence: 0,
    parent: null,
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
      modelCallCount: input.resourceUsage.modelCallCount,
      modelInputTokenCount: input.resourceUsage.modelInputTokenCount,
      modelOutputTokenCount: input.resourceUsage.modelOutputTokenCount,
      cachedInputTokenCount: input.resourceUsage.cachedInputTokenCount,
      toolCallCount: input.resourceUsage.toolCallCount,
      toolResultByteCount: input.resourceUsage.toolResultByteCount,
      externalEffectCount: input.resourceUsage.externalEffectCount,
      boundaryExternalEffectCount: 0,
      elapsedMs: input.resourceUsage.elapsedMs,
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
    `SELECT checkpoint_id
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 1
     FOR SHARE`,
    [scope.tenantId, input.runId],
  );
  if (existing[0]) return noCheckpoint("already_recorded");

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
  if (usage.externalEffectCount !== 0) {
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
  return Object.freeze({
    checkpoint,
    outcome: "recorded" as const,
    resumeAuthorityGranted: false as const,
  });
}

function isSupportedActiveShadowRollout(
  rollout: TenantCapabilityRollout | null,
): rollout is TenantCapabilityRollout {
  return Boolean(
    rollout &&
      rollout.capabilityId === RUN_CHECKPOINT_CAPABILITY_ID &&
      rollout.engineVersion === RUN_CHECKPOINT_ENGINE_VERSION_ID &&
      rollout.contractVersionId === RUN_CHECKPOINT_CONTRACT_VERSION_ID &&
      rollout.configurationSha256 === RUN_CHECKPOINT_CONFIGURATION_SHA256 &&
      rollout.mode === "shadow" &&
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
  if (
    enrollment.runId !== input.runId ||
    enrollment.tenantId !== executionScope.tenantId ||
    runContractEnvelope.runId !== input.runId ||
    enrollment.enginePin.rolloutCapabilityId !== RUN_CHECKPOINT_CAPABILITY_ID ||
    enrollment.enginePin.engineVersionId !== RUN_CHECKPOINT_ENGINE_VERSION_ID ||
    enrollment.enginePin.contractVersionId !== RUN_CHECKPOINT_CONTRACT_VERSION_ID ||
    enrollment.enginePin.configurationSha256 !==
      RUN_CHECKPOINT_CONFIGURATION_SHA256 ||
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

export type { RunCheckpointEnginePinV1 };
