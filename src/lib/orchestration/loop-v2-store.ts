import { createHash } from "node:crypto";

import {
  appendScopedDomainEvent,
  type DomainEvent,
} from "@/lib/events/store";
import {
  loopV2RunContractBindingEventPayload,
  loopV2RunContractComponentsMatch,
  loopV2RunContractTerminalEventPayload,
  type LoopV2RunContractSnapshot,
} from "@/lib/orchestration/loop-v2-outcome";
import {
  advanceLoopV2Checkpoint,
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
import { redactSensitive } from "@/lib/security/context";

type SqlRow = Record<string, unknown>;

export type LoopV2CheckpointWriterSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<SqlRow[]>;
  query: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  unsafe: (text: string, params?: unknown[]) => Promise<SqlRow[]>;
  transaction: (queriesOrFn: unknown, opts?: unknown) => Promise<unknown>;
  readonly transactionScoped: boolean;
};

export type LoopV2RecoveryFence = Readonly<{
  tenantId: string;
  runId: string;
  claimedCheckpointSha256: string;
  leaseGeneration: number;
  claimToken: string;
  leaseExpiresAt: string;
}>;

export type RecordLoopV2CheckpointResult = Readonly<{
  checkpoint: LoopV2Checkpoint;
  event: DomainEvent;
  inserted: boolean;
  executionAuthorityGranted: false;
}>;

export type FinalizeLoopV2RunResult = RecordLoopV2CheckpointResult &
  Readonly<{
    runStatus: "completed" | "failed" | "canceled";
  }>;

export type WaitForLoopV2ClarificationResult = RecordLoopV2CheckpointResult &
  Readonly<{
    runStatus: "waiting_clarification";
  }>;

export type ResumeLoopV2ClarificationResult = Readonly<{
  checkpoint: LoopV2Checkpoint;
  executionScope: ExecutionScope;
  runId: string;
  threadId: string;
  originalPrompt: string;
  inserted: boolean;
}>;

export async function recordLoopV2Checkpoint(
  input: {
    checkpoint: unknown;
    executionScope: ExecutionScope;
    recoveryFence?: LoopV2RecoveryFence;
    runContractBinding?: LoopV2RunContractSnapshot;
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
  const contractBinding = input.runContractBinding
    ? loopV2RunContractBindingEventPayload(input.runContractBinding)
    : undefined;
  if (
    contractBinding &&
    (
      checkpoint.sequence !== 1 ||
      contractBinding.runId !== checkpoint.runId ||
      !contractBinding.harnessManifestSha256
    )
  ) {
    throw new Error("Loop v2 run contracts must bind at the root checkpoint.");
  }

  const runRows = await sql.query(
    `SELECT owner_actor_id, status, continuation,
            COALESCE(
              (continuation #>> '{loopV2Recovery,leaseExpiresAt}')::timestamptz
                > statement_timestamp(),
              false
            ) AS recovery_lease_active
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
  assertLoopV2RecoveryFence({
    checkpoint,
    fence: input.recoveryFence,
    run,
  });

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
  if (!current) {
    await assertLoopV2RootAdmission(checkpoint, sql);
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

  if (contractBinding) {
    await appendScopedDomainEvent({
      id: `run-loop-v2-contract:${checkpoint.runId}`,
      streamId: `run:${checkpoint.runId}`,
      type: "run.contracts.bound",
      executionScope,
      payload: contractBinding,
    }, { sql });
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

async function assertLoopV2RootAdmission(
  checkpoint: LoopV2Checkpoint,
  sql: LoopV2CheckpointWriterSql,
) {
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
    [checkpoint.tenantId, checkpoint.enginePin.capabilityId],
  );
  const rollout = exactlyOne(rolloutRows, "Loop v2 rollout");
  if (
    Number(rollout.rollout_generation) !==
      checkpoint.enginePin.rolloutGeneration ||
    rollout.engine_version !== checkpoint.enginePin.engineVersionId ||
    rollout.contract_version_id !== checkpoint.enginePin.contractVersionId ||
    rollout.configuration_sha256 !==
      checkpoint.enginePin.configurationSha256 ||
    rollout.mode !== checkpoint.enginePin.rolloutMode ||
    rollout.status !== "active" ||
    Number(rollout.lifecycle_revision) !==
      checkpoint.enginePin.rolloutLifecycleRevision
  ) {
    throw new Error("Loop v2 rollout changed before root admission committed.");
  }
}

/** Commits the terminal checkpoint and matching run disposition atomically. */
export async function finalizeLoopV2Run(
  input: {
    checkpoint: unknown;
    executionScope: ExecutionScope;
    response?: string;
    error?: string;
    recoveryFence?: LoopV2RecoveryFence;
    terminalRunContract?: LoopV2RunContractSnapshot;
  },
  sql: LoopV2CheckpointWriterSql,
): Promise<FinalizeLoopV2RunResult> {
  if (!sql.transactionScoped) {
    throw new Error("Loop v2 finalization requires an existing transaction.");
  }
  const checkpoint = parseLoopV2Checkpoint(input.checkpoint);
  if (
    checkpoint.toState !== "finish" ||
    !checkpoint.terminalDisposition
  ) {
    throw new Error("Loop v2 finalization requires a terminal checkpoint.");
  }
  const runStatus = checkpoint.terminalDisposition === "succeeded"
    ? "completed"
    : checkpoint.terminalDisposition;
  const response = runStatus === "completed"
    ? boundedTerminalText(input.response, 100_000)
    : null;
  const error = runStatus === "completed"
    ? null
    : boundedTerminalText(
        input.error ||
          (runStatus === "canceled"
            ? "Canceled by the operator."
            : "Loop v2 execution failed."),
        2_000,
      );
  if (runStatus === "completed" && !response) {
    throw new Error("A successful Loop v2 run requires a response.");
  }
  const terminalContract = input.terminalRunContract
    ? loopV2RunContractTerminalEventPayload(input.terminalRunContract)
    : undefined;
  const contractDisposition =
    input.terminalRunContract?.envelope.terminalReceipt?.disposition;
  const dispositionMatches = checkpoint.terminalDisposition === "succeeded"
    ? contractDisposition === "succeeded" || contractDisposition === "unverified"
    : contractDisposition === checkpoint.terminalDisposition;
  if (
    terminalContract &&
    (
      terminalContract.runId !== checkpoint.runId ||
      !terminalContract.harnessManifestSha256 ||
      !dispositionMatches
    )
  ) {
    throw new Error("Loop v2 terminal contract does not match the checkpoint.");
  }

  const recorded = await recordLoopV2Checkpoint({
    checkpoint,
    executionScope: input.executionScope,
    recoveryFence: input.recoveryFence,
  }, sql);
  const rows = input.recoveryFence
    ? await sql.query(
      `UPDATE omni_agent_runs
       SET status = $4,
           response = $5,
           grounding = NULL,
           error = $6,
           continuation = NULL,
           completed_at = $7
       WHERE tenant_id = $1
         AND id = $2
         AND owner_actor_id = $3
         AND status = 'resuming'
         AND continuation #>> '{loopV2Recovery,checkpointSha256}' = $8
         AND (continuation #>> '{loopV2Recovery,leaseGeneration}')::bigint = $9
         AND continuation #>> '{loopV2Recovery,claimTokenSha256}' = $10
         AND (continuation #>> '{loopV2Recovery,leaseExpiresAt}')::timestamptz
           > statement_timestamp()
       RETURNING id`,
      [
        checkpoint.tenantId,
        checkpoint.runId,
        checkpoint.ownerActorId,
        runStatus,
        response,
        error,
        checkpoint.transitionedAt,
        input.recoveryFence.claimedCheckpointSha256,
        input.recoveryFence.leaseGeneration,
        loopV2RecoveryClaimTokenSha256(input.recoveryFence.claimToken),
      ],
    )
    : await sql.query(
      `UPDATE omni_agent_runs
     SET status = $4,
         response = $5,
         grounding = NULL,
         error = $6,
         continuation = NULL,
         completed_at = $7
     WHERE tenant_id = $1
       AND id = $2
       AND owner_actor_id = $3
       AND status IN ('running', 'resuming')
     RETURNING id`,
    [
      checkpoint.tenantId,
      checkpoint.runId,
      checkpoint.ownerActorId,
      runStatus,
      response,
      error,
      checkpoint.transitionedAt,
    ],
    );
  if (rows.length !== 1) {
    throw new Error("Loop v2 terminal run disposition did not commit.");
  }
  if (terminalContract && input.terminalRunContract) {
    const boundRows = await sql.query(
      `SELECT payload
       FROM omni_events
       WHERE tenant_id = $1
         AND stream_id = $2
         AND type = 'run.contracts.bound'
       ORDER BY seq ASC
       LIMIT 2
       FOR SHARE`,
      [checkpoint.tenantId, `run:${checkpoint.runId}`],
    );
    if (boundRows.length > 1) {
      throw new Error("Loop v2 run has conflicting pre-execution contracts.");
    }
    const boundPayload = boundRows[0]?.payload;
    if (
      boundPayload &&
      !loopV2RunContractComponentsMatch(boundPayload, terminalContract)
    ) {
      throw new Error(
        "Loop v2 terminal contract differs from its pre-execution binding.",
      );
    }
    if (boundPayload) {
      const receipt = input.terminalRunContract.envelope.terminalReceipt;
      const receiptRows = await sql.query(
        `UPDATE omni_agent_runs
         SET terminal_receipt = $4::jsonb
         WHERE tenant_id = $1
           AND id = $2
           AND owner_actor_id = $3
           AND status = $5
         RETURNING id`,
        [
          checkpoint.tenantId,
          checkpoint.runId,
          checkpoint.ownerActorId,
          receipt,
          runStatus,
        ],
      );
      if (receiptRows.length !== 1) {
        throw new Error("Loop v2 terminal receipt did not commit.");
      }
      await appendScopedDomainEvent({
        id: `run-loop-v2-terminal:${checkpoint.checkpointSha256}`,
        streamId: `run:${checkpoint.runId}`,
        type: "run.terminal_receipt.recorded",
        executionScope: input.executionScope,
        payload: terminalContract,
      }, { sql });
    }
  }
  if (input.recoveryFence) {
    await appendLoopV2RecoveryCompletionEvent({
      checkpoint,
      executionScope: input.executionScope,
      fence: input.recoveryFence,
      outcome: runStatus === "completed" ? "resumed" : "failed_closed",
    }, sql);
  }
  return Object.freeze({ ...recorded, runStatus });
}

/** Commits a clarification checkpoint and the matching nonterminal run state. */
export async function waitForLoopV2Clarification(
  input: {
    checkpoint: unknown;
    executionScope: ExecutionScope;
    clarificationPrompt: string;
    recoveryFence?: LoopV2RecoveryFence;
  },
  sql: LoopV2CheckpointWriterSql,
): Promise<WaitForLoopV2ClarificationResult> {
  if (!sql.transactionScoped) {
    throw new Error("Loop v2 clarification wait requires an existing transaction.");
  }
  const checkpoint = parseLoopV2Checkpoint(input.checkpoint);
  if (
    checkpoint.toState !== "clarify" ||
    checkpoint.lifecycleState !== "waiting" ||
    checkpoint.terminalDisposition !== null
  ) {
    throw new Error("Loop v2 clarification wait requires a waiting checkpoint.");
  }
  const clarificationPrompt = boundedTerminalText(
    input.clarificationPrompt,
    2_000,
  );
  if (!clarificationPrompt) {
    throw new Error("Loop v2 clarification wait requires a prompt.");
  }

  const recorded = await recordLoopV2Checkpoint({
    checkpoint,
    executionScope: input.executionScope,
    recoveryFence: input.recoveryFence,
  }, sql);
  const rows = input.recoveryFence
    ? await sql.query(
      `UPDATE omni_agent_runs
       SET status = 'waiting_clarification',
           response = $4,
           grounding = NULL,
           error = NULL,
           continuation = NULL,
           completed_at = NULL
       WHERE tenant_id = $1
         AND id = $2
         AND owner_actor_id = $3
         AND thread_id IS NOT NULL
         AND status = 'resuming'
         AND continuation #>> '{loopV2Recovery,checkpointSha256}' = $5
         AND (continuation #>> '{loopV2Recovery,leaseGeneration}')::bigint = $6
         AND continuation #>> '{loopV2Recovery,claimTokenSha256}' = $7
         AND (continuation #>> '{loopV2Recovery,leaseExpiresAt}')::timestamptz
           > statement_timestamp()
       RETURNING id`,
      [
        checkpoint.tenantId,
        checkpoint.runId,
        checkpoint.ownerActorId,
        clarificationPrompt,
        input.recoveryFence.claimedCheckpointSha256,
        input.recoveryFence.leaseGeneration,
        loopV2RecoveryClaimTokenSha256(input.recoveryFence.claimToken),
      ],
    )
    : await sql.query(
      `UPDATE omni_agent_runs
     SET status = 'waiting_clarification',
         response = $4,
         grounding = NULL,
         error = NULL,
         continuation = NULL,
         completed_at = NULL
     WHERE tenant_id = $1
       AND id = $2
       AND owner_actor_id = $3
       AND thread_id IS NOT NULL
       AND status = 'running'
     RETURNING id`,
    [
      checkpoint.tenantId,
      checkpoint.runId,
      checkpoint.ownerActorId,
      clarificationPrompt,
    ],
    );
  if (rows.length !== 1) {
    throw new Error("Loop v2 clarification run state did not commit.");
  }
  if (input.recoveryFence) {
    await appendLoopV2RecoveryCompletionEvent({
      checkpoint,
      executionScope: input.executionScope,
      fence: input.recoveryFence,
      outcome: "waiting_clarification",
    }, sql);
  }
  return Object.freeze({
    ...recorded,
    runStatus: "waiting_clarification" as const,
  });
}

/**
 * Claims one exact clarification wait and records `clarified -> plan` in the
 * same transaction. The original execution scope remains authoritative.
 */
export async function resumeLoopV2Clarification(
  input: {
    tenantId: string;
    runId: string;
    threadId: string;
    ownerActorId: string;
    agentId: string;
    requestExecutionScope: ExecutionScope;
    clarificationReceiptSha256: string;
    transitionedAt?: string;
  },
  sql: LoopV2CheckpointWriterSql,
): Promise<ResumeLoopV2ClarificationResult> {
  if (!sql.transactionScoped) {
    throw new Error("Loop v2 clarification resume requires an existing transaction.");
  }
  const requestScope = parsePersistedExecutionScope(input.requestExecutionScope);
  if (
    !requestScope ||
    requestScope.tenantId !== input.tenantId ||
    requestScope.initiatingActorId !== input.ownerActorId ||
    requestScope.executingPrincipalType !== "agent" ||
    requestScope.executingPrincipalId !== input.agentId ||
    requestScope.purpose !== "agent.loop.v2.read_only_canary" ||
    !/^[a-f0-9]{64}$/.test(input.clarificationReceiptSha256)
  ) {
    throw new Error("Loop v2 clarification resume request scope is invalid.");
  }

  const runRows = await sql.query(
    `SELECT id, owner_actor_id, thread_id, agent_id, status, prompt
     FROM omni_agent_runs
     WHERE tenant_id = $1 AND id = $2
     LIMIT 2
     FOR UPDATE`,
    [input.tenantId, input.runId],
  );
  const run = exactlyOne(runRows, "Loop v2 clarification run");
  if (
    run.owner_actor_id !== input.ownerActorId ||
    run.thread_id !== input.threadId ||
    run.agent_id !== input.agentId ||
    !["waiting_clarification", "resuming"].includes(String(run.status))
  ) {
    throw new Error("Loop v2 clarification run binding is invalid.");
  }
  const originalPrompt = boundedTerminalText(run.prompt, 30_000);
  if (!originalPrompt) {
    throw new Error("Loop v2 clarification original prompt is missing.");
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
    [input.tenantId, `run:${input.runId}`],
  );
  const scopePayload = plainRecord(
    exactlyOne(scopeRows, "Loop v2 clarification scope binding").payload,
  );
  const originalExecutionScope = parsePersistedExecutionScope(
    scopePayload._executionScope,
  );
  if (
    !originalExecutionScope ||
    originalExecutionScope.tenantId !== input.tenantId ||
    originalExecutionScope.initiatingActorId !== input.ownerActorId ||
    originalExecutionScope.executingPrincipalType !== "agent" ||
    originalExecutionScope.executingPrincipalId !== input.agentId ||
    originalExecutionScope.purpose !== "agent.loop.v2.read_only_canary"
  ) {
    throw new Error("Loop v2 clarification original scope is invalid.");
  }

  const chain = await readLoopV2CheckpointChain({
    tenantId: input.tenantId,
    runId: input.runId,
  }, sql);
  const current = chain.at(-1);
  if (!current) {
    throw new Error("Loop v2 clarification checkpoint is missing.");
  }
  if (String(run.status) === "resuming") {
    if (
      current.fromState !== "clarify" ||
      current.toState !== "plan" ||
      current.trigger !== "clarified" ||
      current.inputReceiptSha256 !== input.clarificationReceiptSha256
    ) {
      throw new Error("Loop v2 clarification resume is already claimed differently.");
    }
    return Object.freeze({
      checkpoint: current,
      executionScope: originalExecutionScope,
      runId: input.runId,
      threadId: input.threadId,
      originalPrompt,
      inserted: false,
    });
  }
  if (
    current.toState !== "clarify" ||
    current.lifecycleState !== "waiting" ||
    current.terminalDisposition !== null
  ) {
    throw new Error("Loop v2 run is not waiting for clarification.");
  }

  const claimedRows = await sql.query(
    `UPDATE omni_agent_runs
     SET status = 'resuming', response = NULL, error = NULL
     WHERE tenant_id = $1
       AND id = $2
       AND owner_actor_id = $3
       AND thread_id = $4
       AND status = 'waiting_clarification'
     RETURNING id`,
    [input.tenantId, input.runId, input.ownerActorId, input.threadId],
  );
  if (claimedRows.length !== 1) {
    throw new Error("Loop v2 clarification claim did not commit.");
  }
  const checkpoint = advanceLoopV2Checkpoint({
    current,
    executionScope: originalExecutionScope,
    trigger: "clarified",
    inputReceiptSha256: input.clarificationReceiptSha256,
    transitionedAt: input.transitionedAt,
  });
  const recorded = await recordLoopV2Checkpoint({
    checkpoint,
    executionScope: originalExecutionScope,
  }, sql);
  return Object.freeze({
    checkpoint: recorded.checkpoint,
    executionScope: originalExecutionScope,
    runId: input.runId,
    threadId: input.threadId,
    originalPrompt,
    inserted: recorded.inserted,
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

function boundedTerminalText(value: unknown, maxChars: number) {
  return String(redactSensitive(value || "")).trim().slice(0, maxChars);
}

export function loopV2RecoveryClaimTokenSha256(claimToken: string) {
  if (!/^[0-9a-f-]{36}$/i.test(claimToken)) {
    throw new Error("Loop v2 recovery claim token is invalid.");
  }
  return createHash("sha256")
    .update("asael.loop-v2-recovery-claim.v1\0")
    .update(claimToken)
    .digest("hex");
}

function assertLoopV2RecoveryFence({
  checkpoint,
  fence,
  run,
}: {
  checkpoint: LoopV2Checkpoint;
  fence?: LoopV2RecoveryFence;
  run: SqlRow;
}) {
  const continuation = plainOptionalRecord(run.continuation);
  const recovery = plainOptionalRecord(continuation?.loopV2Recovery);
  if (!fence) {
    if (recovery) {
      throw new Error("Loop v2 recovery work requires its exact lease fence.");
    }
    return;
  }
  const leaseGeneration = Number(recovery?.leaseGeneration);
  if (
    fence.tenantId !== checkpoint.tenantId ||
    fence.runId !== checkpoint.runId ||
    !/^[a-f0-9]{64}$/.test(fence.claimedCheckpointSha256) ||
    !Number.isSafeInteger(fence.leaseGeneration) ||
    fence.leaseGeneration < 1 ||
    run.status !== "resuming" ||
    run.recovery_lease_active !== true ||
    recovery?.schemaVersion !== 1 ||
    recovery.checkpointSha256 !== fence.claimedCheckpointSha256 ||
    leaseGeneration !== fence.leaseGeneration ||
    recovery.claimTokenSha256 !==
      loopV2RecoveryClaimTokenSha256(fence.claimToken) ||
    recovery.leaseExpiresAt !== fence.leaseExpiresAt
  ) {
    throw new Error("Loop v2 recovery lease fence is stale or invalid.");
  }
}

function plainOptionalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

async function appendLoopV2RecoveryCompletionEvent(
  input: {
    checkpoint: LoopV2Checkpoint;
    executionScope: ExecutionScope;
    fence: LoopV2RecoveryFence;
    outcome: "resumed" | "failed_closed" | "waiting_clarification";
  },
  sql: LoopV2CheckpointWriterSql,
) {
  await appendScopedDomainEvent({
    id: `run-loop-v2-recovery-completed:${input.checkpoint.checkpointSha256}:${input.fence.leaseGeneration}`,
    streamId: `run:${input.checkpoint.runId}`,
    type: "run.loop_v2.recovery_completed",
    executionScope: input.executionScope,
    payload: {
      schemaVersion: 1,
      runId: input.checkpoint.runId,
      claimedCheckpointSha256: input.fence.claimedCheckpointSha256,
      terminalCheckpointSha256: input.checkpoint.checkpointSha256,
      leaseGeneration: input.fence.leaseGeneration,
      outcome: input.outcome,
      replayedExternalEffectCount: 0,
    },
  }, { sql });
}
