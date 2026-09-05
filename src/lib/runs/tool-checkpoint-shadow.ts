import { getSql } from "@/lib/db/client";
import { appendDomainEvent } from "@/lib/events/store";
import {
  isExpandedCheckpointShadowEnrollment,
  type ApprovalCheckpointShadowEnrollment,
} from "@/lib/runs/approval-checkpoint-shadow";
import {
  parseRunContractEnvelopeV1,
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
  deriveExecutionScope,
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { getToolExecutionEffectIntentV2 } from "@/lib/tools/audit-store";
import {
  canonicalJsonSha256,
  parseEffectReceiptV1,
} from "@/lib/tools/effect-receipt";
import { parseEffectReceiptV2 } from "@/lib/tools/effect-receipt-v2";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import { toolApprovalFingerprint } from "@/lib/tools/fingerprint";
import type {
  ToolDefinition,
  ToolExecutionRecord,
} from "@/lib/tools/types";

type ToolCheckpointOperationClass = "read_only" | "mutation";

type ToolCheckpointInput = Readonly<{
  runId: string;
  record: ToolExecutionRecord;
  tool: ToolDefinition;
  operationClass: ToolCheckpointOperationClass;
  executionScope: ExecutionScope;
  toolExecutionScope: ExecutionScope;
  runContractEnvelope: RunContractEnvelopeV1;
  enrollment: ApprovalCheckpointShadowEnrollment | undefined;
}>;

export async function persistToolBeforeCheckpointShadow(
  input: ToolCheckpointInput & { recordedAt: string },
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  return getSql().transaction((sql: RunCheckpointWriterSql) =>
    recordToolBeforeCheckpointShadow(input, sql)
  );
}

export async function persistToolAfterCheckpointShadow(
  input: ToolCheckpointInput,
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  return getSql().transaction((sql: RunCheckpointWriterSql) =>
    recordToolAfterCheckpointShadow(input, sql)
  );
}

export async function recordToolBeforeCheckpointShadow(
  input: ToolCheckpointInput & { recordedAt: string },
  sql: RunCheckpointWriterSql,
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  if (input.record.status !== "executing" || input.record.dryRun) {
    throw new Error("A tool before-checkpoint requires a claimed live execution.");
  }
  const common = await loadCommonState(input, sql);
  const existing = await existingBoundary(
    sql,
    common.scope.tenantId,
    input.runId,
    input.record.id,
    "before",
  );
  if (existing) return existing;
  assertCanAppendToolBefore(common.parent);
  if (
    common.status === "waiting_approval" &&
    (input.record.approvalDecision !== "approved" ||
      common.parent?.boundary.kind !== "approval" ||
      common.parent.boundary.phase !== "after" ||
      common.parent.boundary.boundaryId !== input.record.id)
  ) {
    throw new Error(
      "An approval-route tool checkpoint requires its exact approved predecessor.",
    );
  }
  const binding = toolBinding(input, "before");
  const checkpoint = buildRunCheckpointV1({
    runId: input.runId,
    executionScope: common.scope,
    boundary: {
      kind: "tool",
      phase: "before",
      boundaryId: input.record.id,
      attempt: 1,
    },
    sequence: common.parent ? common.parent.sequence + 1 : 0,
    parent: parentReference(common.parent),
    enginePin: input.enrollment.enginePin,
    stateReferences: toolStateReferences(common, input, binding),
    toolBinding: binding,
    resourceUsage: inheritedResourceUsage(
      common.parent,
      input.recordedAt,
      common.startedAt,
    ),
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: canonicalTimestamp(input.recordedAt),
  });
  await recordRunCheckpointV1({ checkpoint, executionScope: common.scope }, sql);
  await appendComparison(checkpoint, common.scope, sql);
  return checkpoint;
}

export async function recordToolAfterCheckpointShadow(
  input: ToolCheckpointInput,
  sql: RunCheckpointWriterSql,
) {
  if (!isExpandedCheckpointShadowEnrollment(input.enrollment)) return null;
  if (input.record.status === "executing" || input.record.status === "approval_required") {
    throw new Error("A tool after-checkpoint requires a terminal execution receipt.");
  }
  const common = await loadCommonState(input, sql);
  const existing = await existingBoundary(
    sql,
    common.scope.tenantId,
    input.runId,
    input.record.id,
    "after",
  );
  if (existing) return existing;
  const parent = common.parent;
  if (
    !parent ||
    parent.boundary.kind !== "tool" ||
    parent.boundary.phase !== "before" ||
    parent.boundary.boundaryId !== input.record.id
  ) {
    throw new Error("Tool after-checkpoint lacks its exact before boundary.");
  }
  const binding = toolBinding(input, "after");
  const recordedAt = canonicalTimestamp(
    input.record.completedAt || new Date().toISOString(),
  );
  const effectCount = binding.effectState === "effect_recorded" ? 1 : 0;
  const checkpoint = buildRunCheckpointV1({
    runId: input.runId,
    executionScope: common.scope,
    boundary: {
      kind: "tool",
      phase: "after",
      boundaryId: input.record.id,
      attempt: 1,
    },
    sequence: parent.sequence + 1,
    parent: parentReference(parent),
    enginePin: input.enrollment.enginePin,
    stateReferences: toolStateReferences(common, input, binding),
    toolBinding: binding,
    resourceUsage: {
      modelCallCount: parent.resourceUsage.modelCallCount,
      modelInputTokenCount: parent.resourceUsage.modelInputTokenCount,
      modelOutputTokenCount: parent.resourceUsage.modelOutputTokenCount,
      cachedInputTokenCount: parent.resourceUsage.cachedInputTokenCount,
      toolCallCount: parent.resourceUsage.toolCallCount + 1,
      toolResultByteCount:
        parent.resourceUsage.toolResultByteCount + resultByteCount(input.record),
      externalEffectCount: parent.resourceUsage.externalEffectCount + effectCount,
      boundaryExternalEffectCount: effectCount,
      elapsedMs: elapsedMs(common.startedAt, recordedAt),
    },
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt,
  });
  await recordRunCheckpointV1({ checkpoint, executionScope: common.scope }, sql);
  await appendComparison(checkpoint, common.scope, sql);
  return checkpoint;
}

function toolBinding(
  input: ToolCheckpointInput,
  phase: "before" | "after",
): NonNullable<RunCheckpointV1["toolBinding"]> {
  const toolExecutionSha256 = toolExecutionStateSha256(
    input.record,
    input.toolExecutionScope,
  );
  const contractSha256 = canonicalJsonSha256({
    approvalFingerprint: toolApprovalFingerprint(input.tool),
  });
  const inputSha256 = toolInputSha256(input.record.input);
  if (input.operationClass === "read_only") {
    if (input.record.effectReceipt) {
      throw new Error("A read-only tool cannot carry an effect receipt.");
    }
    return {
      operationClass: "read_only",
      toolExecutionId: input.record.id,
      toolExecutionSha256,
      toolId: input.tool.id,
      toolContractSha256: contractSha256,
      inputSha256,
      idempotencyKeySha256: null,
      effectState: "not_applicable",
      effectIntent: null,
      effectReceipt: null,
    };
  }

  const intent = getToolExecutionEffectIntentV2(input.record);
  if (!intent) {
    throw new Error("A mutation tool checkpoint requires a persisted effect intent.");
  }
  if (
    intent.toolId !== input.tool.id ||
    intent.toolContractSha256 !== contractSha256 ||
    intent.inputSha256 !== inputSha256
  ) {
    throw new Error("Mutation tool checkpoint intent changed its tool binding.");
  }
  const receipt = phase === "after" && input.record.effectReceipt
    ? parseEffectReceipt(input.record.effectReceipt)
    : null;
  if (
    phase === "after" &&
    input.record.status === "executed" &&
    !receipt
  ) {
    throw new Error(
      "A successful mutation tool checkpoint requires its exact effect receipt.",
    );
  }
  if (receipt && receipt.effectReceiptId === intent.effectIntentId) {
    throw new Error("Mutation intent and receipt identities must be distinct.");
  }
  return {
    operationClass: "mutation",
    toolExecutionId: input.record.id,
    toolExecutionSha256,
    toolId: input.tool.id,
    toolContractSha256: intent.toolContractSha256,
    inputSha256: intent.inputSha256,
    idempotencyKeySha256: intent.idempotencyKeySha256,
    effectState: phase === "before"
      ? "intent_recorded"
      : receipt
        ? "effect_recorded"
        : "no_effect",
    effectIntent: {
      referenceId: intent.effectIntentId,
      referenceSha256: intent.effectIntentSha256,
    },
    effectReceipt: receipt
      ? {
          referenceId: receipt.effectReceiptId,
          referenceSha256: receipt.receiptSha256,
        }
      : null,
  };
}

function toolStateReferences(
  common: Awaited<ReturnType<typeof loadCommonState>>,
  input: ToolCheckpointInput,
  binding: NonNullable<RunCheckpointV1["toolBinding"]>,
): Array<RunCheckpointV1["stateReferences"][number]> {
  const references: Array<RunCheckpointV1["stateReferences"][number]> = [
    {
      kind: "run_record",
      referenceId: input.runId,
      referenceSha256: common.runRecordSha256,
      versionId: "agent_run_v1",
    },
    {
      kind: "harness_manifest",
      referenceId: common.envelope.harnessManifest.harnessManifestId,
      referenceSha256: canonicalJsonSha256(common.envelope.harnessManifest),
      versionId: "harness_manifest_v1",
    },
    {
      kind: "tool_execution",
      referenceId: input.record.id,
      referenceSha256: binding.toolExecutionSha256,
      versionId: "governed_tool_execution_v1",
    },
  ];
  if (binding.effectIntent) {
    references.push({
      kind: "effect_intent",
      ...binding.effectIntent,
      versionId: "effect_intent_v2",
    });
  }
  if (binding.effectReceipt) {
    references.push({
      kind: "effect_receipt",
      ...binding.effectReceipt,
      versionId: `effect_receipt_v${input.record.effectReceipt?.schemaVersion}`,
    });
  }
  return references;
}

async function loadCommonState(
  input: ToolCheckpointInput,
  sql: RunCheckpointWriterSql,
) {
  if (!sql.transactionScoped) {
    throw new Error("Tool checkpoint shadow requires a run transaction.");
  }
  const scope = parsePersistedExecutionScope(input.executionScope);
  const toolScope = parsePersistedExecutionScope(input.toolExecutionScope);
  const envelope = parseRunContractEnvelopeV1(input.runContractEnvelope);
  if (!scope || !toolScope || !envelope || !input.enrollment) {
    throw new Error("Tool checkpoint shadow lost its exact contracts.");
  }
  if (
    input.runId !== envelope.runId ||
    input.enrollment.runId !== input.runId ||
    input.enrollment.tenantId !== scope.tenantId ||
    input.enrollment.enginePin.runContractEnvelopeId !== envelope.envelopeId ||
    input.enrollment.enginePin.runContractEnvelopeSha256 !==
      canonicalJsonSha256(envelope) ||
    !toolScope.causationId ||
    !executionScopesEqual(
      toolScope,
      deriveExecutionScope(scope, {
        causationId: toolScope.causationId,
        purpose: "agent.tool.execute",
      }),
    ) ||
    input.record.tenantId !== scope.tenantId ||
    input.record.actorId !== scope.initiatingActorId ||
    input.record.toolId !== input.tool.id
  ) {
    throw new Error("Tool checkpoint shadow changed its run or execution binding.");
  }
  const runRows = await sql.query(
    `SELECT id, tenant_id, status, model, agent_id, started_at
     FROM omni_agent_runs
     WHERE tenant_id = $1 AND id = $2
     LIMIT 2
     FOR SHARE`,
    [scope.tenantId, input.runId],
  );
  if (
    runRows.length !== 1 ||
    !["running", "resuming", "waiting_approval"].includes(
      String(runRows[0].status),
    )
  ) {
    throw new Error("Tool checkpoint run is not active.");
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
    status: String(runRow.status),
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

function toolExecutionStateSha256(
  record: ToolExecutionRecord,
  toolExecutionScope: ExecutionScope,
) {
  const intent = getToolExecutionEffectIntentV2(record);
  const receipt = record.effectReceipt ? parseEffectReceipt(record.effectReceipt) : null;
  return canonicalJsonSha256({
    schemaVersion: 1,
    executionId: record.id,
    tenantId: record.tenantId || null,
    actorId: record.actorId || null,
    toolId: record.toolId,
    riskLevel: record.riskLevel,
    status: record.status,
    dryRun: record.dryRun,
    approvalRequired: record.approvalRequired,
    approvalDecision: record.approvalDecision || null,
    inputSha256: toolInputSha256(record.input),
    outputSha256: record.output === undefined
      ? null
      : canonicalJsonSha256(record.output),
    effectIntentSha256: intent?.effectIntentSha256 || null,
    effectReceiptSha256: receipt?.receiptSha256 || null,
    createdAt: canonicalTimestamp(record.createdAt),
    completedAt: record.completedAt
      ? canonicalTimestamp(record.completedAt)
      : null,
    toolExecutionScopeSha256: canonicalJsonSha256(toolExecutionScope),
  });
}

function parseEffectReceipt(value: NonNullable<ToolExecutionRecord["effectReceipt"]>) {
  return value.schemaVersion === 2
    ? parseEffectReceiptV2(value)
    : parseEffectReceiptV1(value);
}

function assertCanAppendToolBefore(parent: RunCheckpointV1 | null) {
  if (
    parent &&
    (parent.lifecycleState !== "active" ||
      parent.resumeDisposition !== "resumable" ||
      parent.boundary.phase === "before" ||
      parent.boundary.phase === "waiting")
  ) {
    throw new Error("Tool before-checkpoint cannot follow an unresolved boundary.");
  }
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

function inheritedResourceUsage(
  parent: RunCheckpointV1 | null,
  recordedAt: string,
  startedAt: string,
) {
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
       AND boundary_kind = 'tool' AND boundary_phase = $3
       AND boundary_id = $4
     LIMIT 2
     FOR SHARE`,
    [tenantId, runId, phase, boundaryId],
  );
  if (rows.length > 1) throw new Error("Tool checkpoint identity is ambiguous.");
  return rows[0] ? parseRunCheckpointV1(rows[0].checkpoint_json) : null;
}

async function appendComparison(
  checkpoint: RunCheckpointV1,
  executionScope: ExecutionScope,
  sql: RunCheckpointWriterSql,
) {
  await appendDomainEvent({
    id: `run-checkpoint-shadow-compared:${checkpoint.checkpointSha256}`,
    streamId: `run:${checkpoint.runId}`,
    type: "run.checkpoint.shadow_compared",
    executionScope,
    payload: {
      schemaVersion: 1,
      checkpointId: checkpoint.checkpointId,
      checkpointSha256: checkpoint.checkpointSha256,
      runId: checkpoint.runId,
      boundaryKind: "tool",
      boundaryPhase: checkpoint.boundary.phase,
      boundaryId: checkpoint.boundary.boundaryId,
      comparison: "matched",
      stateReferenceCount: checkpoint.stateReferences.length,
      externalEffectCount: checkpoint.resourceUsage.externalEffectCount,
      resumeAuthorityGranted: false,
    },
  }, { sql });
}

function resultByteCount(record: ToolExecutionRecord) {
  const bytes = record.output === undefined
    ? 0
    : Buffer.byteLength(JSON.stringify(record.output), "utf8");
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 1_000_000_000_000) {
    throw new Error("Tool result byte count is outside checkpoint bounds.");
  }
  return bytes;
}

function elapsedMs(startedAt: string, recordedAt: string) {
  return Math.max(
    0,
    Date.parse(canonicalTimestamp(recordedAt)) -
      Date.parse(canonicalTimestamp(startedAt)),
  );
}

function canonicalTimestamp(value: unknown) {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Tool checkpoint timestamp is invalid.");
  }
  return date.toISOString();
}
