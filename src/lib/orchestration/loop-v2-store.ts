import {
  appendScopedDomainEvent,
  type DomainEvent,
} from "@/lib/events/store";
import {
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  loopV2ExecutionScopeSha256,
  parseLoopV2Checkpoint,
  replayLoopV2Checkpoints,
  validateLoopV2CheckpointSuccessor,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  executionScopesEqual,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

type SqlRow = Record<string, unknown>;

export type LoopV2CheckpointWriterSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
  readonly transactionScoped: boolean;
};

export type RecordLoopV2CheckpointResult = Readonly<{
  checkpoint: LoopV2Checkpoint;
  event: DomainEvent;
  inserted: boolean;
  executionAuthorityGranted: false;
}>;

export async function recordLoopV2Checkpoint(
  input: {
    checkpoint: unknown;
    executionScope: ExecutionScope;
  },
  sql: LoopV2CheckpointWriterSql,
): Promise<RecordLoopV2CheckpointResult> {
  if (!sql.transactionScoped) {
    throw new Error("Loop v2 checkpoint persistence requires an existing transaction.");
  }
  const checkpoint = parseLoopV2Checkpoint(input.checkpoint);
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (
    !executionScope?.initiatingActorId ||
    checkpoint.tenantId !== executionScope.tenantId ||
    checkpoint.ownerActorId !== executionScope.initiatingActorId ||
    checkpoint.executionScopeSha256 !==
      loopV2ExecutionScopeSha256(executionScope)
  ) {
    throw new Error("Loop v2 checkpoint scope does not match its writer.");
  }

  const runRows = await sql.query(
    `SELECT owner_actor_id, status
     FROM omni_agent_runs
     WHERE tenant_id = $1 AND id = $2
     LIMIT 2
     FOR SHARE`,
    [checkpoint.tenantId, checkpoint.runId],
  );
  const run = exactlyOne(runRows, "Loop v2 agent run");
  if (
    run.owner_actor_id !== checkpoint.ownerActorId ||
    !["running", "resuming"].includes(String(run.status))
  ) {
    throw new Error("Loop v2 checkpoint requires its active actor-owned run.");
  }

  const scopeRows = await sql.query(
    `SELECT payload
     FROM omni_events
     WHERE tenant_id = $1
       AND stream_id = $2
       AND type = 'run.scope_bound'
     ORDER BY seq ASC
     LIMIT 2
     FOR SHARE`,
    [checkpoint.tenantId, `run:${checkpoint.runId}`],
  );
  const scopeEvent = exactlyOne(scopeRows, "Loop v2 run scope binding");
  const payload = plainRecord(scopeEvent.payload);
  const boundScope = parsePersistedExecutionScope(payload._executionScope);
  if (!boundScope || !executionScopesEqual(boundScope, executionScope)) {
    throw new Error("Loop v2 checkpoint scope differs from the run binding.");
  }

  const rolloutRows = await sql.query(
    `SELECT rollout_generation, engine_version, contract_version_id,
            configuration_sha256, mode, status, lifecycle_revision
     FROM omni_tenant_capability_rollouts
     WHERE tenant_id = $1
       AND capability_id = $2
       AND status <> 'superseded'
     ORDER BY rollout_generation DESC
     LIMIT 2
     FOR SHARE`,
    [checkpoint.tenantId, LOOP_V2_CAPABILITY_ID],
  );
  const rollout = exactlyOne(rolloutRows, "Loop v2 rollout");
  if (
    Number(rollout.rollout_generation) !==
      checkpoint.enginePin.rolloutGeneration ||
    rollout.engine_version !== LOOP_V2_ENGINE_VERSION_ID ||
    rollout.contract_version_id !== LOOP_V2_CONTRACT_VERSION_ID ||
    rollout.configuration_sha256 !== LOOP_V2_CONFIGURATION_SHA256 ||
    rollout.mode !== "canary" ||
    rollout.status !== "active" ||
    Number(rollout.lifecycle_revision) !==
      checkpoint.enginePin.rolloutLifecycleRevision
  ) {
    throw new Error("Loop v2 rollout changed before the transition committed.");
  }

  const currentRows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_agent_loop_v2_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 2
     FOR UPDATE`,
    [checkpoint.tenantId, checkpoint.runId],
  );
  if (currentRows.length > 1 && checkpoint.sequence === 1) {
    throw new Error("Loop v2 run already has a checkpoint chain.");
  }
  const current = currentRows[0]
    ? parseLoopV2Checkpoint(currentRows[0].checkpoint_json)
    : undefined;
  if (current?.checkpointId === checkpoint.checkpointId) {
    assertSameCheckpoint(checkpoint, current);
  } else if (current) validateLoopV2CheckpointSuccessor(current, checkpoint);
  else if (
    checkpoint.sequence !== 1 ||
    checkpoint.fromState !== null ||
    checkpoint.toState !== "understand" ||
    checkpoint.trigger !== "started"
  ) {
    throw new Error("Loop v2 checkpoint chain must start at understand.");
  }

  const insertedRows = await sql.query(
    `INSERT INTO omni_agent_loop_v2_checkpoints (
       checkpoint_id, checkpoint_sha256, tenant_id, run_id,
       owner_actor_id, sequence, parent_checkpoint_sha256, from_state,
       to_state, trigger, lifecycle_state, terminal_disposition,
       retry_count, replan_count, execution_scope_sha256,
       engine_version_id, contract_version_id, configuration_sha256,
       rollout_generation, rollout_lifecycle_revision,
       checkpoint_json, transitioned_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
       $12, $13, $14, $15, $16, $17, $18, $19, $20,
       $21::jsonb, $22
     )
     ON CONFLICT (checkpoint_id) DO NOTHING
     RETURNING checkpoint_json`,
    checkpointInsertParams(checkpoint),
  );
  const inserted = insertedRows.length === 1;
  if (!inserted) {
    const existingRows = await sql.query(
      `SELECT checkpoint_json
       FROM omni_agent_loop_v2_checkpoints
       WHERE tenant_id = $1 AND run_id = $2 AND checkpoint_id = $3
       LIMIT 2
       FOR SHARE`,
      [checkpoint.tenantId, checkpoint.runId, checkpoint.checkpointId],
    );
    assertSameCheckpoint(
      checkpoint,
      parseLoopV2Checkpoint(
        exactlyOne(existingRows, "existing Loop v2 checkpoint").checkpoint_json,
      ),
    );
  } else {
    assertSameCheckpoint(
      checkpoint,
      parseLoopV2Checkpoint(insertedRows[0].checkpoint_json),
    );
  }

  const event = await appendScopedDomainEvent({
    id: `run-loop-v2-transition:${checkpoint.checkpointSha256}`,
    streamId: `run:${checkpoint.runId}`,
    type: "run.loop_v2.transitioned",
    executionScope,
    payload: checkpointEventPayload(checkpoint),
  }, { sql });

  return Object.freeze({
    checkpoint,
    event,
    inserted,
    executionAuthorityGranted: false as const,
  });
}

export async function readLoopV2CheckpointChain(
  input: { tenantId: string; runId: string },
  sql: LoopV2CheckpointWriterSql,
): Promise<readonly LoopV2Checkpoint[]> {
  const rows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_agent_loop_v2_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence ASC
     LIMIT 10000`,
    [input.tenantId, input.runId],
  );
  const checkpoints = rows.map((row) =>
    parseLoopV2Checkpoint(row.checkpoint_json)
  );
  if (checkpoints.length) replayLoopV2Checkpoints(checkpoints);
  return Object.freeze(checkpoints);
}

function checkpointInsertParams(checkpoint: LoopV2Checkpoint): unknown[] {
  return [
    checkpoint.checkpointId,
    checkpoint.checkpointSha256,
    checkpoint.tenantId,
    checkpoint.runId,
    checkpoint.ownerActorId,
    checkpoint.sequence,
    checkpoint.parentCheckpointSha256,
    checkpoint.fromState,
    checkpoint.toState,
    checkpoint.trigger,
    checkpoint.lifecycleState,
    checkpoint.terminalDisposition,
    checkpoint.retryCount,
    checkpoint.replanCount,
    checkpoint.executionScopeSha256,
    checkpoint.enginePin.engineVersionId,
    checkpoint.enginePin.contractVersionId,
    checkpoint.enginePin.configurationSha256,
    checkpoint.enginePin.rolloutGeneration,
    checkpoint.enginePin.rolloutLifecycleRevision,
    checkpoint,
    checkpoint.transitionedAt,
  ];
}

function checkpointEventPayload(
  checkpoint: LoopV2Checkpoint,
): Record<string, unknown> {
  return {
    schemaVersion: checkpoint.schemaVersion,
    checkpointId: checkpoint.checkpointId,
    checkpointSha256: checkpoint.checkpointSha256,
    runId: checkpoint.runId,
    sequence: checkpoint.sequence,
    parentCheckpointSha256: checkpoint.parentCheckpointSha256,
    fromState: checkpoint.fromState,
    toState: checkpoint.toState,
    trigger: checkpoint.trigger,
    lifecycleState: checkpoint.lifecycleState,
    terminalDisposition: checkpoint.terminalDisposition,
    retryCount: checkpoint.retryCount,
    replanCount: checkpoint.replanCount,
    executionScopeSha256: checkpoint.executionScopeSha256,
    engineVersionId: checkpoint.enginePin.engineVersionId,
    contractVersionId: checkpoint.enginePin.contractVersionId,
    configurationSha256: checkpoint.enginePin.configurationSha256,
    rolloutMode: checkpoint.enginePin.rolloutMode,
    rolloutGeneration: checkpoint.enginePin.rolloutGeneration,
    rolloutLifecycleRevision: checkpoint.enginePin.rolloutLifecycleRevision,
  };
}

function assertSameCheckpoint(
  expected: LoopV2Checkpoint,
  actual: LoopV2Checkpoint,
) {
  if (
    expected.checkpointSha256 !== actual.checkpointSha256 ||
    JSON.stringify(expected) !== JSON.stringify(actual)
  ) {
    throw new Error("Persisted Loop v2 checkpoint binding changed.");
  }
}

function exactlyOne(rows: SqlRow[], label: string): SqlRow {
  if (rows.length !== 1) throw new Error(`Expected exactly one ${label}.`);
  return rows[0];
}

function plainRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Loop v2 scope event payload is invalid.");
  }
  return value as Record<string, unknown>;
}
