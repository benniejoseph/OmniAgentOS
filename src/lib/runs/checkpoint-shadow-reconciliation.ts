import { z } from "zod";

import {
  RUN_CHECKPOINT_CAPABILITY_ID,
  RUN_CHECKPOINT_CONFIGURATION_SHA256,
  RUN_CHECKPOINT_CONTRACT_VERSION_ID,
  RUN_CHECKPOINT_ENGINE_VERSION_ID,
} from "@/lib/runs/approval-checkpoint-shadow";
import { runContractIdSchema } from "@/lib/runs/contracts";
import {
  buildRunCheckpointV1,
  parseRunCheckpointV1,
  validateRunCheckpointSuccessorV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import { parsePersistedExecutionScope } from "@/lib/security/execution-scope";
import { parseEffectReceiptV1 } from "@/lib/tools/effect-receipt";
import { parseEffectReceiptV2 } from "@/lib/tools/effect-receipt-v2";

type SqlRow = Record<string, unknown>;

export type RunCheckpointReconciliationSql = Readonly<{
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
}>;

export type ApprovalCheckpointShadowIssueCode =
  | "invalid_checkpoint"
  | "checkpoint_row_mismatch"
  | "checkpoint_chain_mismatch"
  | "checkpoint_pin_mismatch"
  | "state_reference_mismatch"
  | "recorded_event_mismatch"
  | "comparison_receipt_mismatch"
  | "approval_boundary_mismatch"
  | "approval_decision_successor_missing"
  | "tool_execution_mismatch"
  | "tool_effect_receipt_mismatch";

export type ApprovalCheckpointShadowRunReconciliation = Readonly<{
  runId: string;
  status: "matched" | "mismatch";
  checkpointCount: number;
  comparisonReceiptCount: number;
  decisionState: "waiting" | "approved" | "rejected" | "unknown";
  effectState:
    | "not_started"
    | "pending"
    | "receipt_recorded"
    | "terminal_without_receipt"
    | "rejected_without_effect"
    | "unknown";
  issues: readonly Readonly<{
    code: ApprovalCheckpointShadowIssueCode;
    checkpointId?: string;
  }>[];
}>;

export type ApprovalCheckpointShadowReconciliationReport = Readonly<{
  schemaVersion: 1;
  capabilityId: typeof RUN_CHECKPOINT_CAPABILITY_ID;
  tenantId: string;
  sampleLimit: number;
  sampledRunCount: number;
  matchedRunCount: number;
  mismatchedRunCount: number;
  checkpointCount: number;
  comparisonReceiptCount: number;
  waitingRunCount: number;
  approvedRunCount: number;
  rejectedRunCount: number;
  effectReceiptCount: number;
  status: "matched" | "mismatch" | "no_sample";
  resumeAuthorityGranted: false;
  runs: readonly ApprovalCheckpointShadowRunReconciliation[];
}>;

const sampleLimitSchema = z.number().int().min(1).max(500);

/**
 * Reconciles a bounded, tenant-scoped approval shadow sample without loading
 * continuation contents or granting checkpoint resume authority.
 */
export async function reconcileStoredApprovalCheckpointShadows(
  input: { tenantId: string; limit?: number },
  sql: RunCheckpointReconciliationSql,
): Promise<ApprovalCheckpointShadowReconciliationReport> {
  const tenantId = runContractIdSchema.parse(input.tenantId);
  const limit = sampleLimitSchema.parse(input.limit ?? 100);
  const runRows = await sql.query(
    `SELECT run_id, MAX(recorded_at) AS latest_recorded_at
     FROM omni_run_checkpoints
     WHERE tenant_id = $1
       AND rollout_capability_id = $2
       AND boundary_kind = 'approval'
     GROUP BY run_id
     ORDER BY latest_recorded_at DESC, run_id ASC
     LIMIT $3`,
    [tenantId, RUN_CHECKPOINT_CAPABILITY_ID, limit],
  );
  const runIds = runRows.map((row) => runContractIdSchema.parse(row.run_id));
  if (new Set(runIds).size !== runIds.length) {
    throw new Error("Checkpoint reconciliation returned duplicate run IDs.");
  }

  const runs: ApprovalCheckpointShadowRunReconciliation[] = [];
  for (const runId of runIds) {
    runs.push(await reconcileRun(tenantId, runId, sql));
  }

  const matchedRunCount = runs.filter((run) => run.status === "matched").length;
  const decisionCount = (state: ApprovalCheckpointShadowRunReconciliation["decisionState"]) =>
    runs.filter((run) => run.decisionState === state).length;
  const effectReceiptCount = runs.filter(
    (run) => run.effectState === "receipt_recorded",
  ).length;

  return Object.freeze({
    schemaVersion: 1 as const,
    capabilityId: RUN_CHECKPOINT_CAPABILITY_ID,
    tenantId,
    sampleLimit: limit,
    sampledRunCount: runs.length,
    matchedRunCount,
    mismatchedRunCount: runs.length - matchedRunCount,
    checkpointCount: runs.reduce((sum, run) => sum + run.checkpointCount, 0),
    comparisonReceiptCount: runs.reduce(
      (sum, run) => sum + run.comparisonReceiptCount,
      0,
    ),
    waitingRunCount: decisionCount("waiting"),
    approvedRunCount: decisionCount("approved"),
    rejectedRunCount: decisionCount("rejected"),
    effectReceiptCount,
    status: runs.length === 0
      ? "no_sample" as const
      : matchedRunCount === runs.length
        ? "matched" as const
        : "mismatch" as const,
    resumeAuthorityGranted: false as const,
    runs: Object.freeze(runs),
  });
}

async function reconcileRun(
  tenantId: string,
  runId: string,
  sql: RunCheckpointReconciliationSql,
): Promise<ApprovalCheckpointShadowRunReconciliation> {
  const [checkpointRows, referenceRows, eventRows] = await Promise.all([
    sql.query(
      `SELECT schema_version, checkpoint_id, checkpoint_sha256, tenant_id,
              actor_id, executing_principal_type, executing_principal_id,
              run_id, sequence, parent_checkpoint_id,
              parent_checkpoint_sha256, parent_sequence, boundary_kind,
              boundary_phase, boundary_id, boundary_attempt,
              execution_scope_sha256, purpose_sha256, rollout_capability_id,
              engine_version_id, contract_version_id, configuration_sha256,
              rollout_generation, rollout_lifecycle_revision,
              lifecycle_state, resume_disposition, checkpoint_json, recorded_at
       FROM omni_run_checkpoints
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY sequence ASC`,
      [tenantId, runId],
    ),
    sql.query(
      `SELECT checkpoint_id, ordinal, reference_kind, reference_id,
              reference_sha256, version_id
       FROM omni_run_checkpoint_state_references
       WHERE tenant_id = $1 AND run_id = $2
       ORDER BY checkpoint_id ASC, ordinal ASC`,
      [tenantId, runId],
    ),
    sql.query(
      `SELECT id, type, payload
       FROM omni_events
       WHERE tenant_id = $1
         AND stream_id = $2
         AND type IN ('run.checkpoint.recorded', 'run.checkpoint.shadow_compared')
       ORDER BY seq ASC`,
      [tenantId, `run:${runId}`],
    ),
  ]);
  const issues: Array<{
    code: ApprovalCheckpointShadowIssueCode;
    checkpointId?: string;
  }> = [];
  const checkpoints: RunCheckpointV1[] = [];
  for (const row of checkpointRows) {
    try {
      const checkpoint = parseRunCheckpointV1(row.checkpoint_json);
      checkpoints.push(checkpoint);
      if (!checkpointRowMatches(row, checkpoint, tenantId, runId)) {
        addIssue(issues, "checkpoint_row_mismatch", checkpoint.checkpointId);
      }
      if (!supportedShadowPin(checkpoint)) {
        addIssue(issues, "checkpoint_pin_mismatch", checkpoint.checkpointId);
      }
    } catch {
      addIssue(issues, "invalid_checkpoint", safeId(row.checkpoint_id));
    }
  }

  if (checkpoints.length !== checkpointRows.length) {
    return runReport(runId, checkpointRows.length, 0, "unknown", "unknown", issues);
  }
  for (let index = 0; index < checkpoints.length; index += 1) {
    const checkpoint = checkpoints[index] as RunCheckpointV1;
    if (checkpoint.sequence !== index) {
      addIssue(issues, "checkpoint_chain_mismatch", checkpoint.checkpointId);
    }
    if (index > 0) {
      try {
        validateRunCheckpointSuccessorV1(checkpoints[index - 1], checkpoint);
      } catch {
        addIssue(issues, "checkpoint_chain_mismatch", checkpoint.checkpointId);
      }
    }
    if (!stateReferencesMatch(checkpoint, referenceRows)) {
      addIssue(issues, "state_reference_mismatch", checkpoint.checkpointId);
    }
    if (!recordedEventMatches(checkpoint, eventRows)) {
      addIssue(issues, "recorded_event_mismatch", checkpoint.checkpointId);
    }
    if (!comparisonEventMatches(checkpoint, eventRows)) {
      addIssue(issues, "comparison_receipt_mismatch", checkpoint.checkpointId);
    }
  }

  const approvalCheckpoints = checkpoints.filter(
    (checkpoint) => checkpoint.boundary.kind === "approval",
  );
  const boundaryIds = [...new Set(
    approvalCheckpoints.map((checkpoint) => checkpoint.boundary.boundaryId),
  )];
  const toolRows = boundaryIds.length
    ? await sql.query(
        `SELECT id, status, approval_decision, effect_receipt
         FROM omni_tool_executions
         WHERE COALESCE(tenant_id, 'default') = $1
           AND id = ANY($2::text[])
         ORDER BY id ASC`,
        [tenantId, boundaryIds],
      )
    : [];
  const decision = reconcileApprovalBoundary(
    tenantId,
    approvalCheckpoints,
    toolRows,
    issues,
  );
  const comparisonReceiptCount = checkpoints.filter((checkpoint) =>
    comparisonEventMatches(checkpoint, eventRows)
  ).length;
  return runReport(
    runId,
    checkpoints.length,
    comparisonReceiptCount,
    decision.decisionState,
    decision.effectState,
    issues,
  );
}

function reconcileApprovalBoundary(
  tenantId: string,
  checkpoints: RunCheckpointV1[],
  toolRows: SqlRow[],
  issues: Array<{ code: ApprovalCheckpointShadowIssueCode; checkpointId?: string }>,
): Pick<ApprovalCheckpointShadowRunReconciliation, "decisionState" | "effectState"> {
  const waiting = checkpoints[0];
  const successor = checkpoints[1];
  if (
    checkpoints.length < 1 ||
    checkpoints.length > 2 ||
    !waiting ||
    waiting.boundary.phase !== "waiting" ||
    waiting.lifecycleState !== "waiting" ||
    waiting.resumeDisposition !== "awaiting_signal" ||
    waiting.resourceUsage.externalEffectCount !== 0 ||
    waiting.resourceUsage.boundaryExternalEffectCount !== 0 ||
    (
      successor &&
      (
        successor.boundary.phase !== "after" ||
        successor.boundary.boundaryId !== waiting.boundary.boundaryId ||
        successor.resourceUsage.externalEffectCount !== 0 ||
        successor.resourceUsage.boundaryExternalEffectCount !== 0
      )
    )
  ) {
    addIssue(issues, "approval_boundary_mismatch", waiting?.checkpointId);
    return { decisionState: "unknown", effectState: "unknown" };
  }
  const matches = toolRows.filter(
    (row) => String(row.id) === waiting.boundary.boundaryId,
  );
  if (matches.length !== 1) {
    addIssue(issues, "tool_execution_mismatch", waiting.checkpointId);
    return { decisionState: "unknown", effectState: "unknown" };
  }
  const tool = matches[0] as SqlRow;
  const toolStatus = String(tool.status || "");
  const approvalDecision = tool.approval_decision == null
    ? null
    : String(tool.approval_decision);
  const hasReceipt = tool.effect_receipt != null;
  if (hasReceipt && !effectReceiptMatches(tool.effect_receipt, tenantId, String(tool.id))) {
    addIssue(issues, "tool_effect_receipt_mismatch", successor?.checkpointId);
  }

  if (!successor) {
    if (toolStatus !== "approval_required" || approvalDecision !== null || hasReceipt) {
      addIssue(issues, "approval_decision_successor_missing", waiting.checkpointId);
    }
    return { decisionState: "waiting", effectState: "not_started" };
  }
  if (
    successor.lifecycleState === "terminal" &&
    successor.resumeDisposition === "not_resumable"
  ) {
    if (toolStatus !== "rejected" || approvalDecision !== "rejected" || hasReceipt) {
      addIssue(issues, "tool_execution_mismatch", successor.checkpointId);
    }
    return {
      decisionState: "rejected",
      effectState: hasReceipt ? "unknown" : "rejected_without_effect",
    };
  }
  if (
    successor.lifecycleState !== "active" ||
    successor.resumeDisposition !== "resumable" ||
    approvalDecision !== "approved" ||
    !["executing", "executed", "failed"].includes(toolStatus)
  ) {
    addIssue(issues, "tool_execution_mismatch", successor.checkpointId);
    return { decisionState: "unknown", effectState: "unknown" };
  }
  if (hasReceipt) {
    return { decisionState: "approved", effectState: "receipt_recorded" };
  }
  if (toolStatus === "executing") {
    return { decisionState: "approved", effectState: "pending" };
  }
  return {
    decisionState: "approved",
    effectState: "terminal_without_receipt",
  };
}

function checkpointRowMatches(
  row: SqlRow,
  checkpoint: RunCheckpointV1,
  tenantId: string,
  runId: string,
): boolean {
  const parent = checkpoint.parent;
  return (
    Number(row.schema_version) === checkpoint.schemaVersion &&
    row.checkpoint_id === checkpoint.checkpointId &&
    row.checkpoint_sha256 === checkpoint.checkpointSha256 &&
    row.tenant_id === tenantId &&
    row.actor_id === checkpoint.executionScope.initiatingActorId &&
    row.executing_principal_type === checkpoint.executionScope.executingPrincipalType &&
    row.executing_principal_id === checkpoint.executionScope.executingPrincipalId &&
    row.run_id === runId &&
    Number(row.sequence) === checkpoint.sequence &&
    (row.parent_checkpoint_id ?? null) === (parent?.checkpointId ?? null) &&
    (row.parent_checkpoint_sha256 ?? null) === (parent?.checkpointSha256 ?? null) &&
    nullableNumber(row.parent_sequence) === (parent?.sequence ?? null) &&
    row.boundary_kind === checkpoint.boundary.kind &&
    row.boundary_phase === checkpoint.boundary.phase &&
    row.boundary_id === checkpoint.boundary.boundaryId &&
    Number(row.boundary_attempt) === checkpoint.boundary.attempt &&
    row.execution_scope_sha256 === checkpoint.executionScope.executionScopeSha256 &&
    row.purpose_sha256 === checkpoint.executionScope.purposeSha256 &&
    row.rollout_capability_id === checkpoint.enginePin.rolloutCapabilityId &&
    row.engine_version_id === checkpoint.enginePin.engineVersionId &&
    row.contract_version_id === checkpoint.enginePin.contractVersionId &&
    row.configuration_sha256 === checkpoint.enginePin.configurationSha256 &&
    Number(row.rollout_generation) === checkpoint.enginePin.rolloutGeneration &&
    Number(row.rollout_lifecycle_revision) === checkpoint.enginePin.rolloutLifecycleRevision &&
    row.lifecycle_state === checkpoint.lifecycleState &&
    row.resume_disposition === checkpoint.resumeDisposition &&
    canonicalTimestamp(row.recorded_at) === checkpoint.recordedAt
  );
}

function supportedShadowPin(checkpoint: RunCheckpointV1): boolean {
  const pin = checkpoint.enginePin;
  return (
    pin.rolloutCapabilityId === RUN_CHECKPOINT_CAPABILITY_ID &&
    pin.engineVersionId === RUN_CHECKPOINT_ENGINE_VERSION_ID &&
    pin.contractVersionId === RUN_CHECKPOINT_CONTRACT_VERSION_ID &&
    pin.configurationSha256 === RUN_CHECKPOINT_CONFIGURATION_SHA256 &&
    pin.rolloutMode === "shadow" &&
    pin.rolloutLifecycleStatus === "active"
  );
}

function stateReferencesMatch(
  checkpoint: RunCheckpointV1,
  rows: SqlRow[],
): boolean {
  const matches = rows.filter(
    (row) => row.checkpoint_id === checkpoint.checkpointId,
  );
  return (
    matches.length === checkpoint.stateReferences.length &&
    matches.every((row, ordinal) => {
      const reference = checkpoint.stateReferences[ordinal];
      return (
        reference !== undefined &&
        Number(row.ordinal) === ordinal &&
        row.reference_kind === reference.kind &&
        row.reference_id === reference.referenceId &&
        row.reference_sha256 === reference.referenceSha256 &&
        (row.version_id ?? null) === (reference.versionId ?? null)
      );
    })
  );
}

function recordedEventMatches(checkpoint: RunCheckpointV1, rows: SqlRow[]): boolean {
  const matches = rows.filter(
    (row) => row.id === `run-checkpoint-recorded:${checkpoint.checkpointSha256}`,
  );
  if (matches.length !== 1 || matches[0]?.type !== "run.checkpoint.recorded") {
    return false;
  }
  const payload = plainRecord(matches[0].payload);
  return Boolean(
    payload &&
    payload.checkpointId === checkpoint.checkpointId &&
    payload.checkpointSha256 === checkpoint.checkpointSha256 &&
    payload.runId === checkpoint.runId &&
    Number(payload.sequence) === checkpoint.sequence &&
    (payload.parentCheckpointId ?? null) === (checkpoint.parent?.checkpointId ?? null) &&
    (payload.parentCheckpointSha256 ?? null) === (checkpoint.parent?.checkpointSha256 ?? null) &&
    payload.boundaryKind === checkpoint.boundary.kind &&
    payload.boundaryPhase === checkpoint.boundary.phase &&
    payload.boundaryId === checkpoint.boundary.boundaryId &&
    Number(payload.stateReferenceCount) === checkpoint.stateReferences.length &&
    payload.executionScopeSha256 === checkpoint.executionScope.executionScopeSha256 &&
    payload.rolloutCapabilityId === checkpoint.enginePin.rolloutCapabilityId &&
    Number(payload.rolloutGeneration) === checkpoint.enginePin.rolloutGeneration &&
    Number(payload.rolloutLifecycleRevision) === checkpoint.enginePin.rolloutLifecycleRevision
  );
}

function comparisonEventMatches(
  checkpoint: RunCheckpointV1,
  rows: SqlRow[],
): boolean {
  const matches = rows.filter(
    (row) => row.id === `run-checkpoint-shadow-compared:${checkpoint.checkpointSha256}`,
  );
  if (
    matches.length !== 1 ||
    matches[0]?.type !== "run.checkpoint.shadow_compared"
  ) {
    return false;
  }
  const payload = plainRecord(matches[0].payload);
  let scopeMatches = false;
  try {
    const eventScope = parsePersistedExecutionScope(payload?._executionScope);
    scopeMatches = Boolean(
      eventScope && checkpointScopeMatches(checkpoint, eventScope),
    );
  } catch {
    return false;
  }
  return Boolean(
    payload &&
    scopeMatches &&
    payload.schemaVersion === 1 &&
    payload.checkpointId === checkpoint.checkpointId &&
    payload.checkpointSha256 === checkpoint.checkpointSha256 &&
    payload.runId === checkpoint.runId &&
    payload.boundaryKind === "approval" &&
    payload.boundaryPhase === checkpoint.boundary.phase &&
    payload.boundaryId === checkpoint.boundary.boundaryId &&
    payload.comparison === "matched" &&
    Number(payload.stateReferenceCount) === checkpoint.stateReferences.length &&
    Number(payload.externalEffectCount) === checkpoint.resourceUsage.externalEffectCount &&
    payload.resumeAuthorityGranted === false
  );
}

function checkpointScopeMatches(
  checkpoint: RunCheckpointV1,
  executionScope: NonNullable<ReturnType<typeof parsePersistedExecutionScope>>,
): boolean {
  const usage = checkpoint.resourceUsage;
  const rebuilt = buildRunCheckpointV1({
    runId: checkpoint.runId,
    executionScope,
    boundary: checkpoint.boundary,
    sequence: checkpoint.sequence,
    parent: checkpoint.parent,
    enginePin: checkpoint.enginePin,
    stateReferences: checkpoint.stateReferences,
    toolBinding: checkpoint.toolBinding,
    resourceUsage: {
      modelCallCount: usage.modelCallCount,
      modelInputTokenCount: usage.modelInputTokenCount,
      modelOutputTokenCount: usage.modelOutputTokenCount,
      cachedInputTokenCount: usage.cachedInputTokenCount,
      toolCallCount: usage.toolCallCount,
      toolResultByteCount: usage.toolResultByteCount,
      externalEffectCount: usage.externalEffectCount,
      boundaryExternalEffectCount: usage.boundaryExternalEffectCount,
      elapsedMs: usage.elapsedMs,
    },
    lifecycleState: checkpoint.lifecycleState,
    resumeDisposition: checkpoint.resumeDisposition,
    recordedAt: checkpoint.recordedAt,
  });
  return (
    rebuilt.checkpointId === checkpoint.checkpointId &&
    rebuilt.checkpointSha256 === checkpoint.checkpointSha256
  );
}

function effectReceiptMatches(value: unknown, tenantId: string, executionId: string) {
  const receipt = plainRecord(value);
  if (!receipt) return false;
  try {
    if (receipt.schemaVersion === 1) {
      return Boolean(parseEffectReceiptV1(value, { tenantId, executionId }));
    }
    if (receipt.schemaVersion === 2) {
      return Boolean(parseEffectReceiptV2(value, { tenantId, executionId }));
    }
  } catch {
    return false;
  }
  return false;
}

function runReport(
  runId: string,
  checkpointCount: number,
  comparisonReceiptCount: number,
  decisionState: ApprovalCheckpointShadowRunReconciliation["decisionState"],
  effectState: ApprovalCheckpointShadowRunReconciliation["effectState"],
  issues: Array<{ code: ApprovalCheckpointShadowIssueCode; checkpointId?: string }>,
): ApprovalCheckpointShadowRunReconciliation {
  return Object.freeze({
    runId,
    status: issues.length === 0 ? "matched" as const : "mismatch" as const,
    checkpointCount,
    comparisonReceiptCount,
    decisionState,
    effectState,
    issues: Object.freeze(issues.map((issue) => Object.freeze({ ...issue }))),
  });
}

function addIssue(
  issues: Array<{ code: ApprovalCheckpointShadowIssueCode; checkpointId?: string }>,
  code: ApprovalCheckpointShadowIssueCode,
  checkpointId?: string,
) {
  if (!issues.some((issue) => issue.code === code && issue.checkpointId === checkpointId)) {
    issues.push(checkpointId ? { code, checkpointId } : { code });
  }
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function canonicalTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function safeId(value: unknown): string | undefined {
  const parsed = runContractIdSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
