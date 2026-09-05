import { createHash } from "node:crypto";

import {
  appendDomainEvent,
  type DomainEvent,
} from "@/lib/events/store";
import {
  buildRunCheckpointV1,
  parseRunCheckpointV1,
  validateRunCheckpointSuccessorV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

type SqlRow = Record<string, unknown>;

export type RunCheckpointWriterSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
  readonly transactionScoped: boolean;
};

export type RecordRunCheckpointV1Input = Readonly<{
  checkpoint: unknown;
  executionScope: ExecutionScope;
}>;

export type RecordRunCheckpointV1Result = Readonly<{
  checkpoint: RunCheckpointV1;
  event: DomainEvent;
  inserted: boolean;
  resumeAuthorityGranted: false;
}>;

/**
 * Persists one immutable checkpoint and its exact state-reference index inside
 * an existing transaction. This module deliberately exposes no transaction
 * opener, route, worker claim, state loader, or resume operation.
 */
export async function recordRunCheckpointV1(
  input: RecordRunCheckpointV1Input,
  sql: RunCheckpointWriterSql,
): Promise<RecordRunCheckpointV1Result> {
  if (!sql.transactionScoped) {
    throw new Error(
      "Run checkpoint persistence requires an existing database transaction.",
    );
  }

  const executionScope = parsePersistedExecutionScope(input.executionScope);
  const checkpoint = parseRunCheckpointV1(input.checkpoint);
  if (!executionScope) {
    throw new Error("Run checkpoint persistence requires a valid execution scope.");
  }
  assertCheckpointScopeBinding(checkpoint, executionScope);

  if (checkpoint.parent) {
    const parentRows = await sql.query(
      `SELECT checkpoint_json
       FROM omni_run_checkpoints
       WHERE tenant_id = $1
         AND run_id = $2
         AND checkpoint_id = $3
       ORDER BY checkpoint_id ASC
       LIMIT 2
       FOR SHARE`,
      [
        checkpoint.executionScope.tenantId,
        checkpoint.runId,
        checkpoint.parent.checkpointId,
      ],
    );
    const parent = checkpointFromRow(
      exactlyOne(parentRows, "run checkpoint parent"),
    );
    validateRunCheckpointSuccessorV1(parent, checkpoint);
  }

  const insertedRows = await sql.query(
    `INSERT INTO omni_run_checkpoints (
       schema_version, checkpoint_id, checkpoint_sha256, tenant_id, actor_id,
       executing_principal_type, executing_principal_id, run_id, sequence,
       parent_checkpoint_id, parent_checkpoint_sha256, parent_sequence,
       boundary_kind, boundary_phase, boundary_id, boundary_attempt,
       execution_scope_sha256, purpose_sha256, rollout_capability_id,
       engine_version_id, contract_version_id, configuration_sha256,
       rollout_generation, rollout_lifecycle_revision, lifecycle_state,
       resume_disposition, checkpoint_json, recorded_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26,
       $27::jsonb, $28
     )
     ON CONFLICT (checkpoint_id) DO NOTHING
     RETURNING checkpoint_json`,
    checkpointInsertParams(checkpoint),
  );

  const inserted = insertedRows.length === 1;
  if (insertedRows.length > 1) {
    throw new Error("Run checkpoint insert returned an ambiguous result.");
  }

  if (inserted) {
    assertSameCheckpoint(
      checkpoint,
      checkpointFromRow(insertedRows[0] as SqlRow),
    );
    const referenceRows = await sql.query(
      `INSERT INTO omni_run_checkpoint_state_references (
         tenant_id, run_id, checkpoint_id, ordinal, reference_kind,
         reference_id, reference_sha256, version_id
       )
       SELECT $1, $2, $3, input.ordinal, input.reference_kind,
              input.reference_id, input.reference_sha256, input.version_id
       FROM jsonb_to_recordset($4::jsonb) AS input(
         ordinal INTEGER,
         reference_kind TEXT,
         reference_id TEXT,
         reference_sha256 TEXT,
         version_id TEXT
       )
       ORDER BY input.ordinal ASC
       RETURNING ordinal, reference_kind, reference_id,
                 reference_sha256, version_id`,
      [
        checkpoint.executionScope.tenantId,
        checkpoint.runId,
        checkpoint.checkpointId,
        checkpoint.stateReferences.map((reference, ordinal) => ({
          ordinal,
          reference_kind: reference.kind,
          reference_id: reference.referenceId,
          reference_sha256: reference.referenceSha256,
          version_id: reference.versionId,
        })),
      ],
    );
    assertStateReferences(checkpoint, referenceRows);
  } else {
    const existingRows = await sql.query(
      `SELECT checkpoint_json
       FROM omni_run_checkpoints
       WHERE tenant_id = $1
         AND run_id = $2
         AND checkpoint_id = $3
       ORDER BY checkpoint_id ASC
       LIMIT 2
       FOR SHARE`,
      [
        checkpoint.executionScope.tenantId,
        checkpoint.runId,
        checkpoint.checkpointId,
      ],
    );
    assertSameCheckpoint(
      checkpoint,
      checkpointFromRow(
        exactlyOne(existingRows, "existing run checkpoint"),
      ),
    );
    const referenceRows = await sql.query(
      `SELECT ordinal, reference_kind, reference_id,
              reference_sha256, version_id
       FROM omni_run_checkpoint_state_references
       WHERE tenant_id = $1
         AND run_id = $2
         AND checkpoint_id = $3
       ORDER BY ordinal ASC`,
      [
        checkpoint.executionScope.tenantId,
        checkpoint.runId,
        checkpoint.checkpointId,
      ],
    );
    assertStateReferences(checkpoint, referenceRows);
  }

  const event = await appendDomainEvent(
    {
      id: `run-checkpoint-recorded:${checkpoint.checkpointSha256}`,
      streamId: `run:${checkpoint.runId}`,
      type: "run.checkpoint.recorded",
      tenantId: checkpoint.executionScope.tenantId,
      actorId: checkpoint.executionScope.initiatingActorId,
      correlationId: checkpoint.executionScope.correlationId,
      causationId: checkpoint.executionScope.causationId || undefined,
      payload: checkpointEventPayload(checkpoint),
    },
    { sql },
  );

  return Object.freeze({
    checkpoint,
    event,
    inserted,
    resumeAuthorityGranted: false as const,
  });
}

function assertCheckpointScopeBinding(
  checkpoint: RunCheckpointV1,
  executionScope: ExecutionScope,
): void {
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
  assertSameCheckpoint(checkpoint, rebuilt);
}

function checkpointInsertParams(checkpoint: RunCheckpointV1): unknown[] {
  return [
    checkpoint.schemaVersion,
    checkpoint.checkpointId,
    checkpoint.checkpointSha256,
    checkpoint.executionScope.tenantId,
    checkpoint.executionScope.initiatingActorId,
    checkpoint.executionScope.executingPrincipalType,
    checkpoint.executionScope.executingPrincipalId,
    checkpoint.runId,
    checkpoint.sequence,
    checkpoint.parent?.checkpointId || null,
    checkpoint.parent?.checkpointSha256 || null,
    checkpoint.parent?.sequence ?? null,
    checkpoint.boundary.kind,
    checkpoint.boundary.phase,
    checkpoint.boundary.boundaryId,
    checkpoint.boundary.attempt,
    checkpoint.executionScope.executionScopeSha256,
    checkpoint.executionScope.purposeSha256,
    checkpoint.enginePin.rolloutCapabilityId,
    checkpoint.enginePin.engineVersionId,
    checkpoint.enginePin.contractVersionId,
    checkpoint.enginePin.configurationSha256,
    checkpoint.enginePin.rolloutGeneration,
    checkpoint.enginePin.rolloutLifecycleRevision,
    checkpoint.lifecycleState,
    checkpoint.resumeDisposition,
    checkpoint,
    checkpoint.recordedAt,
  ];
}

function checkpointEventPayload(
  checkpoint: RunCheckpointV1,
): Record<string, unknown> {
  const scope = checkpoint.executionScope;
  return {
    schemaVersion: checkpoint.schemaVersion,
    checkpointId: checkpoint.checkpointId,
    checkpointSha256: checkpoint.checkpointSha256,
    runId: checkpoint.runId,
    sequence: checkpoint.sequence,
    parentCheckpointId: checkpoint.parent?.checkpointId || null,
    parentCheckpointSha256: checkpoint.parent?.checkpointSha256 || null,
    boundaryKind: checkpoint.boundary.kind,
    boundaryPhase: checkpoint.boundary.phase,
    boundaryId: checkpoint.boundary.boundaryId,
    boundaryAttempt: checkpoint.boundary.attempt,
    lifecycleState: checkpoint.lifecycleState,
    resumeDisposition: checkpoint.resumeDisposition,
    stateReferenceCount: checkpoint.stateReferences.length,
    executionScopeVersion: scope.executionScopeVersion,
    executionScopeSha256: scope.executionScopeSha256,
    executingPrincipalType: scope.executingPrincipalType,
    executingPrincipalId: scope.executingPrincipalId,
    workspaceId: scope.workspaceId,
    projectId: scope.projectId,
    missionId: scope.missionId,
    delegationId: scope.delegationId,
    contextGrantIds: [...scope.contextGrantIds],
    capabilityGrantIds: [...scope.capabilityGrantIds],
    purposeSha256: scope.purposeSha256,
    rolloutCapabilityId: checkpoint.enginePin.rolloutCapabilityId,
    engineVersionId: checkpoint.enginePin.engineVersionId,
    contractVersionId: checkpoint.enginePin.contractVersionId,
    configurationSha256: checkpoint.enginePin.configurationSha256,
    rolloutMode: checkpoint.enginePin.rolloutMode,
    rolloutLifecycleStatus: checkpoint.enginePin.rolloutLifecycleStatus,
    rolloutGeneration: checkpoint.enginePin.rolloutGeneration,
    rolloutLifecycleRevision: checkpoint.enginePin.rolloutLifecycleRevision,
  };
}

function checkpointFromRow(row: SqlRow): RunCheckpointV1 {
  return parseRunCheckpointV1(row.checkpoint_json);
}

function assertSameCheckpoint(
  expected: RunCheckpointV1,
  actual: RunCheckpointV1,
): void {
  if (
    expected.checkpointId !== actual.checkpointId ||
    expected.checkpointSha256 !== actual.checkpointSha256 ||
    JSON.stringify(expected) !== JSON.stringify(actual)
  ) {
    throw new Error("Persisted run checkpoint binding changed.");
  }
}

function assertStateReferences(
  checkpoint: RunCheckpointV1,
  rows: SqlRow[],
): void {
  if (rows.length !== checkpoint.stateReferences.length) {
    throw new Error("Persisted run checkpoint state references are incomplete.");
  }
  rows.forEach((row, ordinal) => {
    const expected = checkpoint.stateReferences[ordinal];
    if (
      Number(row.ordinal) !== ordinal ||
      row.reference_kind !== expected?.kind ||
      row.reference_id !== expected?.referenceId ||
      row.reference_sha256 !== expected?.referenceSha256 ||
      (row.version_id ?? null) !== (expected?.versionId ?? null)
    ) {
      throw new Error("Persisted run checkpoint state-reference binding changed.");
    }
  });
}

function exactlyOne(rows: SqlRow[], label: string): SqlRow {
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one ${label} row.`);
  }
  return rows[0] as SqlRow;
}

function digestIds(ids: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

// Retained as an explicit metadata-only helper for future event projection
// tests; it never receives or hashes state contents.
export function runCheckpointGrantSetDigestV1(
  ids: readonly string[],
): string {
  return digestIds([...ids].sort());
}
