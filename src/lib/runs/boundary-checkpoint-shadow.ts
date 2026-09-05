import { z } from "zod";

import { getSql } from "@/lib/db/client";
import { appendDomainEvent } from "@/lib/events/store";
import {
  isExpandedCheckpointShadowEnrollment,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
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
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

type ModelCheckpointEvent = Readonly<{
  id: string;
  createdAt: string;
  status?: "completed" | "failed";
  failureKind?: string;
  model: string;
  provider?: string;
  tier: "fast" | "reasoning";
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  latencyMs: number;
  iteration?: number;
  providerRequestId?: string;
  usageReceiptId?: string;
}>;

const comparisonPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  checkpointId: runContractIdSchema,
  checkpointSha256: runContractSha256Schema,
  runId: runContractIdSchema,
  boundaryKind: z.literal("model"),
  boundaryPhase: z.enum(["before", "after"]),
  boundaryId: runContractIdSchema,
  comparison: z.literal("matched"),
  stateReferenceCount: z.number().int().min(1).max(64),
  externalEffectCount: z.number().int().min(0),
  resumeAuthorityGranted: z.literal(false),
}).strict();

export function modelCheckpointBoundaryId(runId: string, attempt: number) {
  return runContractIdSchema.parse(`${runId}:model:${attempt}`);
}

export async function persistModelBeforeCheckpointShadow(
  input: Parameters<typeof recordModelBeforeCheckpointShadow>[0],
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  return getSql().transaction((sql: RunCheckpointWriterSql) =>
    recordModelBeforeCheckpointShadow(input, sql)
  );
}

export async function persistModelAfterCheckpointShadow(
  input: Parameters<typeof recordModelAfterCheckpointShadow>[0],
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  return getSql().transaction((sql: RunCheckpointWriterSql) =>
    recordModelAfterCheckpointShadow(input, sql)
  );
}

export async function recordModelBeforeCheckpointShadow(
  input: {
    runId: string;
    attempt: number;
    provider: string;
    model: string;
    tier: "fast" | "reasoning";
    recordedAt: string;
    executionScope: ExecutionScope;
    runContractEnvelope: RunContractEnvelopeV1;
    enrollment: ApprovalCheckpointShadowEnrollment | undefined;
  },
  sql: RunCheckpointWriterSql,
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  const common = await loadCommonState(input, sql);
  const attempt = common.parent
    ? common.parent.resourceUsage.modelCallCount + 1
    : 1;
  const boundaryId = modelCheckpointBoundaryId(input.runId, attempt);
  const existing = await existingBoundary(sql, common.scope.tenantId, input.runId, boundaryId, "before");
  if (existing) return existing;
  assertCanAppendModelBefore(common.parent);
  const checkpoint = buildRunCheckpointV1({
    runId: input.runId,
    executionScope: common.scope,
    boundary: { kind: "model", phase: "before", boundaryId, attempt },
    sequence: common.parent ? common.parent.sequence + 1 : 0,
    parent: parentReference(common.parent),
    enginePin: input.enrollment.enginePin,
    stateReferences: baseReferences(common).concat({
      kind: "model_turn",
      referenceId: boundaryId,
      referenceSha256: canonicalJsonSha256({
        schemaVersion: 1,
        phase: "before",
        runId: input.runId,
        boundaryId,
        attempt,
        callerAttempt: input.attempt,
        provider: input.provider,
        model: input.model,
        tier: input.tier,
      }),
      versionId: "model_turn_request_v1",
    }),
    toolBinding: null,
    resourceUsage: resourceUsage(common.parent, input.recordedAt, common.startedAt),
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: canonicalTimestamp(input.recordedAt),
  });
  await recordRunCheckpointV1({ checkpoint, executionScope: common.scope }, sql);
  await appendComparison(checkpoint, common.scope, sql);
  return checkpoint;
}

export async function recordModelAfterCheckpointShadow(
  input: {
    runId: string;
    event: ModelCheckpointEvent;
    executionScope: ExecutionScope;
    runContractEnvelope: RunContractEnvelopeV1;
    enrollment: ApprovalCheckpointShadowEnrollment | undefined;
  },
  sql: RunCheckpointWriterSql,
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  const common = await loadCommonState(input, sql);
  const parent = common.parent;
  if (
    !parent ||
    parent.boundary.kind !== "model" ||
    parent.boundary.phase !== "before"
  ) {
    throw new Error("Model after-checkpoint lacks its exact before boundary.");
  }
  const attempt = parent.boundary.attempt;
  const boundaryId = parent.boundary.boundaryId;
  const existing = await existingBoundary(sql, common.scope.tenantId, input.runId, boundaryId, "after");
  if (existing) return existing;
  const eventTimestamp = canonicalTimestamp(input.event.createdAt);
  const checkpoint = buildRunCheckpointV1({
    runId: input.runId,
    executionScope: common.scope,
    boundary: { kind: "model", phase: "after", boundaryId, attempt },
    sequence: parent.sequence + 1,
    parent: parentReference(parent),
    enginePin: input.enrollment.enginePin,
    stateReferences: baseReferences(common).concat({
      kind: "model_turn",
      referenceId: boundaryId,
      referenceSha256: canonicalJsonSha256({
        schemaVersion: 1,
        phase: "after",
        runId: input.runId,
        boundaryId,
        attempt,
        eventId: input.event.id,
        status: input.event.status || "completed",
        failureKind: input.event.failureKind || null,
        provider: input.event.provider || "unknown",
        model: input.event.model,
        tier: input.event.tier,
        inputTokens: boundedCounter(input.event.inputTokens),
        outputTokens: boundedCounter(input.event.outputTokens),
        cachedInputTokens: boundedCounter(input.event.cachedInputTokens),
        totalTokens: boundedCounter(input.event.totalTokens),
        latencyMs: boundedCounter(input.event.latencyMs),
        providerRequestIdSha256: input.event.providerRequestId
          ? canonicalJsonSha256(input.event.providerRequestId)
          : null,
        usageReceiptId: input.event.usageReceiptId || null,
        recordedAt: eventTimestamp,
      }),
      versionId: "model_turn_receipt_v1",
    }),
    toolBinding: null,
    resourceUsage: {
      modelCallCount: parent.resourceUsage.modelCallCount + 1,
      modelInputTokenCount:
        parent.resourceUsage.modelInputTokenCount + boundedCounter(input.event.inputTokens),
      modelOutputTokenCount:
        parent.resourceUsage.modelOutputTokenCount + boundedCounter(input.event.outputTokens),
      cachedInputTokenCount:
        parent.resourceUsage.cachedInputTokenCount + boundedCounter(input.event.cachedInputTokens),
      toolCallCount: parent.resourceUsage.toolCallCount,
      toolResultByteCount: parent.resourceUsage.toolResultByteCount,
      externalEffectCount: parent.resourceUsage.externalEffectCount,
      boundaryExternalEffectCount: 0,
      elapsedMs: elapsedMs(common.startedAt, eventTimestamp),
    },
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: eventTimestamp,
  });
  await recordRunCheckpointV1({ checkpoint, executionScope: common.scope }, sql);
  await appendComparison(checkpoint, common.scope, sql);
  return checkpoint;
}

async function loadCommonState(
  input: {
    runId: string;
    executionScope: ExecutionScope;
    runContractEnvelope: RunContractEnvelopeV1;
    enrollment: ApprovalCheckpointShadowEnrollment | undefined;
  },
  sql: RunCheckpointWriterSql,
) {
  if (!sql.transactionScoped) {
    throw new Error("Model checkpoint shadow requires a run transaction.");
  }
  const scope = parsePersistedExecutionScope(input.executionScope);
  const envelope = parseRunContractEnvelopeV1(input.runContractEnvelope);
  if (!scope || !envelope || !input.enrollment) {
    throw new Error("Model checkpoint shadow lost its exact contracts.");
  }
  if (
    input.runId !== envelope.runId ||
    input.enrollment.runId !== input.runId ||
    input.enrollment.tenantId !== scope.tenantId ||
    input.enrollment.enginePin.runContractEnvelopeId !== envelope.envelopeId ||
    input.enrollment.enginePin.runContractEnvelopeSha256 !== canonicalJsonSha256(envelope)
  ) {
    throw new Error("Model checkpoint shadow changed its run binding.");
  }
  const runRows = await sql.query(
    `SELECT id, tenant_id, status, model, agent_id, started_at
     FROM omni_agent_runs
     WHERE tenant_id = $1 AND id = $2
     LIMIT 2
     FOR SHARE`,
    [scope.tenantId, input.runId],
  );
  if (runRows.length !== 1 || !["running", "resuming"].includes(String(runRows[0].status))) {
    throw new Error("Model checkpoint run is not active.");
  }
  const checkpointRows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 1
     FOR SHARE`,
    [scope.tenantId, input.runId],
  );
  const parent = checkpointRows[0]
    ? parseRunCheckpointV1(checkpointRows[0].checkpoint_json)
    : null;
  const runRow = runRows[0];
  const startedAt = canonicalTimestamp(runRow.started_at);
  return {
    scope,
    envelope,
    parent,
    startedAt,
    runRecordSha256: canonicalJsonSha256({
      schemaVersion: 1,
      runId: runRow.id,
      tenantId: runRow.tenant_id,
      status: runRow.status,
      model: runRow.model || null,
      agentId: runRow.agent_id,
      startedAt,
    }),
  };
}

function baseReferences(
  common: Awaited<ReturnType<typeof loadCommonState>>,
): Array<RunCheckpointV1["stateReferences"][number]> {
  return [
    {
      kind: "run_record" as const,
      referenceId: common.envelope.runId,
      referenceSha256: common.runRecordSha256,
      versionId: "agent_run_v1",
    },
    {
      kind: "harness_manifest" as const,
      referenceId: common.envelope.harnessManifest.harnessManifestId,
      referenceSha256: canonicalJsonSha256(common.envelope.harnessManifest),
      versionId: "harness_manifest_v1",
    },
  ];
}

function parentReference(parent: RunCheckpointV1 | null) {
  return parent
    ? {
        checkpointId: parent.checkpointId,
        checkpointSha256: parent.checkpointSha256,
        sequence: parent.sequence,
      }
    : null;
}

function resourceUsage(parent: RunCheckpointV1 | null, recordedAt: string, startedAt: string) {
  return {
    modelCallCount: parent?.resourceUsage.modelCallCount || 0,
    modelInputTokenCount: parent?.resourceUsage.modelInputTokenCount || 0,
    modelOutputTokenCount: parent?.resourceUsage.modelOutputTokenCount || 0,
    cachedInputTokenCount: parent?.resourceUsage.cachedInputTokenCount || 0,
    toolCallCount: parent?.resourceUsage.toolCallCount || 0,
    toolResultByteCount: parent?.resourceUsage.toolResultByteCount || 0,
    externalEffectCount: parent?.resourceUsage.externalEffectCount || 0,
    boundaryExternalEffectCount: 0 as const,
    elapsedMs: elapsedMs(startedAt, recordedAt),
  };
}

function assertCanAppendModelBefore(parent: RunCheckpointV1 | null) {
  if (
    parent &&
    (parent.lifecycleState !== "active" ||
      parent.resumeDisposition !== "resumable" ||
      (parent.boundary.phase === "before" &&
        (parent.boundary.kind === "model" ||
          parent.boundary.kind === "tool")) ||
      parent.boundary.phase === "waiting")
  ) {
    throw new Error("Model before-checkpoint cannot follow an unresolved boundary.");
  }
}

async function existingBoundary(
  sql: RunCheckpointWriterSql,
  tenantId: string,
  runId: string,
  boundaryId: string,
  phase: "before" | "after",
) {
  const rows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
       AND boundary_kind = 'model' AND boundary_phase = $3
       AND boundary_id = $4
     LIMIT 2
     FOR SHARE`,
    [tenantId, runId, phase, boundaryId],
  );
  if (rows.length > 1) throw new Error("Model checkpoint identity is ambiguous.");
  return rows[0] ? parseRunCheckpointV1(rows[0].checkpoint_json) : null;
}

async function appendComparison(
  checkpoint: RunCheckpointV1,
  executionScope: ExecutionScope,
  sql: RunCheckpointWriterSql,
) {
  const payload = comparisonPayloadSchema.parse({
    schemaVersion: 1,
    checkpointId: checkpoint.checkpointId,
    checkpointSha256: checkpoint.checkpointSha256,
    runId: checkpoint.runId,
    boundaryKind: "model",
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
    executionScope,
    payload,
  }, { sql });
}

function boundedCounter(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function elapsedMs(startedAt: string, recordedAt: string) {
  return Math.max(
    0,
    Date.parse(canonicalTimestamp(recordedAt)) - Date.parse(canonicalTimestamp(startedAt)),
  );
}

function canonicalTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Model checkpoint timestamp is invalid.");
  }
  return date.toISOString();
}
