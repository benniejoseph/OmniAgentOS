import { randomUUID } from "node:crypto";

import {
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  advanceLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  loopV2ExecutionScopeSha256,
  parseLoopV2Checkpoint,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  runLoopV2ReadOnlyCanary,
  type LoopV2ReadOnlyCanaryRequest,
} from "@/lib/orchestration/loop-v2-runtime";
import {
  finalizeLoopV2Run,
  loopV2RecoveryClaimTokenSha256,
  type LoopV2CheckpointWriterSql,
  type LoopV2RecoveryFence,
} from "@/lib/orchestration/loop-v2-store";
import { redactSensitive } from "@/lib/security/context";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const DEFAULT_STALE_AFTER_MS = 7 * 60 * 1_000;
const DEFAULT_RECOVERY_LEASE_SECONDS = 300;
const MAX_RECOVERY_ATTEMPTS = 3;

type SqlRow = Record<string, unknown>;

export type ClaimedLoopV2Recovery = Readonly<{
  run: Readonly<{
    id: string;
    tenantId: string;
    ownerActorId: string;
    threadId?: string;
    mode: "orchestrate";
    prompt: string;
    agentId: "atlas";
  }>;
  checkpoint: LoopV2Checkpoint;
  executionScope: ExecutionScope;
  fence: LoopV2RecoveryFence;
}>;

export type LoopV2RecoveryDecision = Readonly<{
  action: "resume_read_only" | "fail_closed";
  reasonCode:
    | "idempotent_read_replay"
    | "non_replayable_model_boundary"
    | "replan_requires_new_authority"
    | "recovery_attempts_exhausted";
  replayedExternalEffectCount: 0;
}>;

export function decideLoopV2InterruptionRecovery(
  checkpoint: LoopV2Checkpoint,
  leaseGeneration = 1,
): LoopV2RecoveryDecision {
  const parsed = parseLoopV2Checkpoint(checkpoint);
  if (parsed.lifecycleState !== "active") {
    throw new Error("Loop v2 recovery requires an active checkpoint.");
  }
  if (leaseGeneration > MAX_RECOVERY_ATTEMPTS) {
    return recoveryDecision("fail_closed", "recovery_attempts_exhausted");
  }
  if (parsed.enginePin.capabilityId !== LOOP_V2_CAPABILITY_ID) {
    return recoveryDecision("fail_closed", "non_replayable_model_boundary");
  }
  if (parsed.toState === "replan") {
    return recoveryDecision("fail_closed", "replan_requires_new_authority");
  }
  return recoveryDecision("resume_read_only", "idempotent_read_replay");
}

export async function claimInterruptedLoopV2Run(
  input: {
    tenantId: string;
    leaseOwner: string;
    staleAfterMs?: number;
    leaseSeconds?: number;
    now?: string;
  },
  sql: LoopV2CheckpointWriterSql,
): Promise<ClaimedLoopV2Recovery | null> {
  if (!sql.transactionScoped) {
    throw new Error("Loop v2 recovery claim requires an existing transaction.");
  }
  const tenantId = boundedId(input.tenantId, "tenant");
  const leaseOwner = boundedId(input.leaseOwner, "lease owner", 512);
  const staleAfterMs = boundedInteger(
    input.staleAfterMs ?? DEFAULT_STALE_AFTER_MS,
    1_000,
    24 * 60 * 60 * 1_000,
    "stale threshold",
  );
  const leaseSeconds = boundedInteger(
    input.leaseSeconds ?? DEFAULT_RECOVERY_LEASE_SECONDS,
    30,
    600,
    "lease duration",
  );
  const now = canonicalTimestamp(input.now);
  const staleBefore = new Date(Date.parse(now) - staleAfterMs).toISOString();
  const rows = await sql.query(
    `SELECT run.id, run.owner_actor_id, run.thread_id, run.mode,
            run.prompt, run.agent_id, run.continuation
     FROM omni_agent_loop_v2_checkpoints checkpoint
     JOIN omni_agent_runs run
       ON run.tenant_id = checkpoint.tenant_id
      AND run.id = checkpoint.run_id
     WHERE run.tenant_id = $1
       AND run.status IN ('running', 'resuming')
       AND checkpoint.lifecycle_state = 'active'
       AND checkpoint.transitioned_at <= $2::timestamptz
       AND NOT EXISTS (
         SELECT 1
         FROM omni_agent_loop_v2_checkpoints newer
         WHERE newer.tenant_id = checkpoint.tenant_id
           AND newer.run_id = checkpoint.run_id
           AND newer.sequence > checkpoint.sequence
       )
       AND (
         run.status = 'running'
         OR NOT (COALESCE(run.continuation, '{}'::jsonb) ? 'loopV2Recovery')
         OR (run.continuation #>> '{loopV2Recovery,leaseExpiresAt}')::timestamptz
              <= statement_timestamp()
       )
     ORDER BY checkpoint.transitioned_at ASC, run.id ASC
     LIMIT 1
     FOR UPDATE OF run SKIP LOCKED`,
    [tenantId, staleBefore],
  );
  if (!rows[0]) return null;
  if (rows.length !== 1) {
    throw new Error("Loop v2 recovery claim selected an ambiguous run.");
  }
  const row = rows[0];
  const checkpointRows = await sql.query(
    `SELECT checkpoint_json, lifecycle_state, transitioned_at
     FROM omni_agent_loop_v2_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 2
     FOR SHARE`,
    [tenantId, row.id],
  );
  const checkpointRow = exactlyOne(
    checkpointRows,
    "current Loop v2 recovery checkpoint",
  );
  if (
    checkpointRow.lifecycle_state !== "active" ||
    Date.parse(String(checkpointRow.transitioned_at)) > Date.parse(staleBefore)
  ) {
    return null;
  }
  const checkpoint = parseLoopV2Checkpoint(checkpointRow.checkpoint_json);
  if (
    checkpoint.tenantId !== tenantId ||
    checkpoint.runId !== row.id ||
    checkpoint.ownerActorId !== row.owner_actor_id ||
    row.mode !== "orchestrate" ||
    row.agent_id !== "atlas"
  ) {
    throw new Error("Loop v2 recovery run binding is invalid.");
  }
  const scopeRows = await sql.query(
    `SELECT payload
     FROM omni_events
     WHERE tenant_id = $1 AND stream_id = $2 AND type = 'run.scope_bound'
     ORDER BY seq ASC
     LIMIT 2
     FOR SHARE`,
    [tenantId, `run:${checkpoint.runId}`],
  );
  const scopePayload = plainRecord(exactlyOne(scopeRows, "Loop v2 recovery scope").payload);
  const executionScope = parsePersistedExecutionScope(scopePayload._executionScope);
  if (
    !executionScope ||
    checkpoint.executionScopeSha256 !==
      loopV2ExecutionScopeSha256(executionScope) ||
    executionScope.tenantId !== tenantId ||
    executionScope.initiatingActorId !== checkpoint.ownerActorId ||
    executionScope.executingPrincipalType !== "agent" ||
    executionScope.executingPrincipalId !== "atlas"
  ) {
    throw new Error("Loop v2 recovery execution scope is invalid.");
  }
  const existingRecovery = plainOptionalRecord(
    plainOptionalRecord(row.continuation)?.loopV2Recovery,
  );
  const previousGeneration = Number(existingRecovery?.leaseGeneration || 0);
  const leaseGeneration = Number.isSafeInteger(previousGeneration) &&
      previousGeneration >= 0
    ? previousGeneration + 1
    : 1;
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(
    Date.parse(now) + leaseSeconds * 1_000,
  ).toISOString();
  const recoveryMetadata = {
    schemaVersion: 1,
    checkpointSha256: checkpoint.checkpointSha256,
    leaseGeneration,
    claimTokenSha256: loopV2RecoveryClaimTokenSha256(claimToken),
    leaseOwnerSha256: sourceContractSha256({
      domain: "asael.loop-v2-recovery-owner.v1",
      leaseOwner,
    }),
    claimedAt: now,
    leaseExpiresAt,
  };
  const claimedRows = await sql.query(
    `UPDATE omni_agent_runs
     SET status = 'resuming',
         continuation = jsonb_set(
           COALESCE(continuation, '{}'::jsonb),
           '{loopV2Recovery}',
           $3::jsonb,
           true
         ),
         completed_at = NULL
     WHERE tenant_id = $1 AND id = $2
       AND status IN ('running', 'resuming')
     RETURNING id`,
    [tenantId, checkpoint.runId, recoveryMetadata],
  );
  if (claimedRows.length !== 1) {
    throw new Error("Loop v2 recovery claim did not bind its run.");
  }
  await appendScopedDomainEvent({
    id: `run-loop-v2-recovery-claimed:${checkpoint.checkpointSha256}:${leaseGeneration}`,
    streamId: `run:${checkpoint.runId}`,
    type: "run.loop_v2.recovery_claimed",
    executionScope,
    payload: {
      schemaVersion: 1,
      runId: checkpoint.runId,
      checkpointSha256: checkpoint.checkpointSha256,
      checkpointState: checkpoint.toState,
      leaseGeneration,
      leaseExpiresAt,
      replayedExternalEffectCount: 0,
    },
  }, { sql });
  return Object.freeze({
    run: Object.freeze({
      id: checkpoint.runId,
      tenantId,
      ownerActorId: checkpoint.ownerActorId,
      ...(typeof row.thread_id === "string" && row.thread_id
        ? { threadId: row.thread_id }
        : {}),
      mode: "orchestrate" as const,
      prompt: boundedText(row.prompt, 30_000),
      agentId: "atlas" as const,
    }),
    checkpoint,
    executionScope,
    fence: Object.freeze({
      tenantId,
      runId: checkpoint.runId,
      claimedCheckpointSha256: checkpoint.checkpointSha256,
      leaseGeneration,
      claimToken,
      leaseExpiresAt,
    }),
  });
}

export async function recoverInterruptedLoopV2Runs({
  tenantId,
  limit = 1,
  staleAfterMs = DEFAULT_STALE_AFTER_MS,
  leaseOwner = `loop-v2-maintenance:${randomUUID()}`,
  abortSignal,
}: {
  tenantId: string;
  limit?: number;
  staleAfterMs?: number;
  leaseOwner?: string;
  abortSignal?: AbortSignal;
}) {
  if (!hasDatabaseUrl()) {
    return recoverySummary([]);
  }
  const boundedLimit = boundedInteger(limit, 1, 3, "recovery limit");
  const results: Array<{
    runId: string;
    action: LoopV2RecoveryDecision["action"];
    outcome: "resumed" | "waiting_clarification" | "failed_closed" | "deferred";
    reasonCode: LoopV2RecoveryDecision["reasonCode"];
  }> = [];
  for (let index = 0; index < boundedLimit; index += 1) {
    abortSignal?.throwIfAborted();
    const claimed = await runWithDatabaseSystemScope(
      `Claim stale Loop v2 run recovery for tenant ${tenantId}.`,
      () => getSql().transaction((sql: LoopV2CheckpointWriterSql) =>
        claimInterruptedLoopV2Run({
          tenantId,
          leaseOwner,
          staleAfterMs,
        }, sql)
      ) as Promise<ClaimedLoopV2Recovery | null>,
    );
    if (!claimed) break;
    const decision = decideLoopV2InterruptionRecovery(
      claimed.checkpoint,
      claimed.fence.leaseGeneration,
    );
    try {
      if (decision.action === "resume_read_only") {
        const outcome = await resumeClaimedReadOnlyRun(
          claimed,
          abortSignal,
        );
        results.push({
          runId: claimed.run.id,
          action: decision.action,
          outcome,
          reasonCode: decision.reasonCode,
        });
      } else {
        await failClosedClaimedRun(claimed, decision);
        results.push({
          runId: claimed.run.id,
          action: decision.action,
          outcome: "failed_closed",
          reasonCode: decision.reasonCode,
        });
      }
    } catch (error) {
      console.error(JSON.stringify({
        level: "error",
        event: "loop_v2.recovery_deferred",
        runId: claimed.run.id,
        checkpointSha256: claimed.checkpoint.checkpointSha256,
        leaseGeneration: claimed.fence.leaseGeneration,
        error: safeErrorMessage(error),
      }));
      results.push({
        runId: claimed.run.id,
        action: decision.action,
        outcome: "deferred",
        reasonCode: decision.reasonCode,
      });
    }
  }
  return recoverySummary(results);
}

async function resumeClaimedReadOnlyRun(
  claimed: ClaimedLoopV2Recovery,
  abortSignal?: AbortSignal,
) {
  const request: LoopV2ReadOnlyCanaryRequest = {
    message: claimed.run.prompt,
    messages: [{ role: "user", content: claimed.run.prompt }],
    mode: claimed.run.mode,
    threadId: claimed.run.threadId,
    agentId: claimed.run.agentId,
    securityContext: {
      tenantId: claimed.run.tenantId,
      actorId: claimed.run.ownerActorId,
      role: "viewer",
      source: "service",
    },
    executionScope: claimed.executionScope,
    enrollment: { enginePin: claimed.checkpoint.enginePin },
    recovery: {
      runId: claimed.run.id,
      checkpoint: claimed.checkpoint,
      fence: claimed.fence,
    },
  };
  let outcome: "resumed" | "waiting_clarification" | "failed_closed" =
    "failed_closed";
  for await (const event of runLoopV2ReadOnlyCanary(request, abortSignal)) {
    if (event.type === "done") outcome = "resumed";
    if (event.type === "clarification") outcome = "waiting_clarification";
  }
  return outcome;
}

async function failClosedClaimedRun(
  claimed: ClaimedLoopV2Recovery,
  decision: LoopV2RecoveryDecision,
) {
  const terminal = advanceLoopV2Checkpoint({
    current: claimed.checkpoint,
    executionScope: claimed.executionScope,
    trigger: "budget_exhausted",
    outputReceiptSha256: sourceContractSha256({
      reasonCode: decision.reasonCode,
      interruptedCheckpointSha256: claimed.checkpoint.checkpointSha256,
      replayedExternalEffectCount: 0,
    }),
  });
  await runWithDatabaseActorScope(
    claimed.run.tenantId,
    [claimed.run.ownerActorId],
    () => getSql().transaction((sql: LoopV2CheckpointWriterSql) =>
      finalizeLoopV2Run({
        checkpoint: terminal,
        executionScope: claimed.executionScope,
        recoveryFence: claimed.fence,
        error:
          "Interrupted Loop v2 work crossed a non-replayable boundary; automatic replay was blocked.",
      }, sql)
    ),
  );
}

function recoveryDecision(
  action: LoopV2RecoveryDecision["action"],
  reasonCode: LoopV2RecoveryDecision["reasonCode"],
): LoopV2RecoveryDecision {
  return Object.freeze({ action, reasonCode, replayedExternalEffectCount: 0 });
}

function recoverySummary<T extends { outcome: string }>(results: T[]) {
  return {
    claimed: results.length,
    resumed: results.filter((result) => result.outcome === "resumed").length,
    waitingClarification: results.filter(
      (result) => result.outcome === "waiting_clarification",
    ).length,
    failedClosed: results.filter(
      (result) => result.outcome === "failed_closed",
    ).length,
    deferred: results.filter((result) => result.outcome === "deferred").length,
    results,
  };
}

function boundedInteger(
  value: number,
  min: number,
  max: number,
  label: string,
) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Loop v2 recovery ${label} is invalid.`);
  }
  return value;
}

function boundedId(value: unknown, label: string, max = 240) {
  const text = String(value || "").trim();
  if (!text || text.length > max) {
    throw new Error(`Loop v2 recovery ${label} is invalid.`);
  }
  return text;
}

function boundedText(value: unknown, max: number) {
  const text = String(redactSensitive(value || "")).trim().slice(0, max);
  if (!text) throw new Error("Loop v2 recovery prompt is missing.");
  return text;
}

function canonicalTimestamp(value?: string) {
  const timestamp = new Date(value || Date.now());
  if (!Number.isFinite(timestamp.getTime())) {
    throw new Error("Loop v2 recovery timestamp is invalid.");
  }
  return timestamp.toISOString();
}

function exactlyOne(rows: SqlRow[], label: string) {
  if (rows.length !== 1) throw new Error(`Expected exactly one ${label}.`);
  return rows[0];
}

function plainRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Loop v2 recovery record is invalid.");
  }
  return value as Record<string, unknown>;
}

function plainOptionalRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeErrorMessage(error: unknown) {
  return String(
    redactSensitive(
      error instanceof Error ? error.message : "Loop v2 recovery failed.",
    ),
  ).slice(0, 1_000);
}
