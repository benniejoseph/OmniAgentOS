import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import { appendDomainEvent } from "@/lib/events/store";
import { runContractIdSchema } from "@/lib/runs/contracts";
import type { RunCheckpointWriterSql } from "@/lib/runs/checkpoint-store";
import {
  buildRunCheckpointV1,
  decideRunCheckpointCompatibilityV1,
  parseRunCheckpointV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import {
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { parseEffectReceiptV1 } from "@/lib/tools/effect-receipt";
import { parseEffectReceiptV2 } from "@/lib/tools/effect-receipt-v2";

const leaseSecondsSchema = z.number().int().min(10).max(3_600);
const generationSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const claimTokenSchema = z.string().uuid();
const CLAIM_DIGEST_DOMAIN = "asael.run-checkpoint-resume-claim.v1";

export type RunCheckpointResumeClaim = Readonly<{
  tenantId: string;
  runId: string;
  checkpointId: string;
  checkpointSha256: string;
  operationJobId: string;
  leaseGeneration: number;
  leaseExpiresAt: string;
  claimToken: string;
}>;

export type AcquireRunCheckpointResumeClaimResult = Readonly<{
  outcome: "acquired" | "busy" | "already_completed" | "paused";
  reason:
    | "claimed"
    | "active_claim"
    | "claim_completed"
    | "checkpoint_not_latest"
    | "checkpoint_not_resumable"
    | "rollout_not_resumable"
    | "run_not_waiting"
    | "tool_not_terminal";
  claim: RunCheckpointResumeClaim | null;
  fenceAcquired: boolean;
  resumeAuthorityGranted: false;
}>;

export type AuthorizeRunCheckpointResumeResult =
  | Readonly<{
      outcome: "authorized";
      reason: "checkpoint_fence_acquired";
      claim: RunCheckpointResumeClaim;
      fenceAcquired: true;
      resumeAuthorityGranted: true;
    }>
  | AcquireRunCheckpointResumeClaimResult;

/**
 * Atomically acquires the exact fence and moves its run to `resuming`. No
 * runtime calls this dormant binder until the canary gate is opened.
 */
export async function authorizeAgentRunCheckpointResume(
  input: Parameters<typeof acquireRunCheckpointResumeClaim>[0],
  sql: RunCheckpointWriterSql,
): Promise<AuthorizeRunCheckpointResumeResult> {
  requireTransaction(sql);
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope) {
    throw new Error("Checkpoint resume authorization lost its execution scope.");
  }
  const result = await acquireRunCheckpointResumeClaim(input, sql);
  if (result.outcome !== "acquired" || !result.claim) return result;
  const claim = result.claim;
  const resumedAt = new Date().toISOString();
  const claimMetadata = {
    schemaVersion: 1,
    checkpointId: claim.checkpointId,
    checkpointSha256: claim.checkpointSha256,
    operationJobId: claim.operationJobId,
    leaseGeneration: claim.leaseGeneration,
  };
  const rows = await sql.query(
    `UPDATE omni_agent_runs
     SET status = 'resuming',
         continuation = jsonb_set(
           jsonb_set(
             continuation,
             '{resumeClaimedAt}',
             to_jsonb($6::text),
             true
           ),
           '{checkpointResumeClaim}',
           $7::jsonb,
           true
         ),
         completed_at = NULL
     WHERE tenant_id = $1 AND id = $2
       AND continuation->'pendingToolCall'->>'executionId' = $3
       AND (
         status = 'waiting_approval'
         OR (
           status = 'resuming'
           AND continuation->'checkpointResumeClaim'->>'checkpointId' = $4
           AND continuation->'checkpointResumeClaim'->>'checkpointSha256' = $5
         )
       )
     RETURNING id`,
    [
      claim.tenantId,
      claim.runId,
      input.approvalExecutionId,
      claim.checkpointId,
      claim.checkpointSha256,
      resumedAt,
      claimMetadata,
    ],
  );
  if (rows.length !== 1) {
    throw new Error("Checkpoint resume fence could not bind the run transition.");
  }
  await appendDomainEvent({
    id: `run-checkpoint-resume-authorized:${claim.checkpointSha256}:${claim.leaseGeneration}`,
    streamId: `run:${claim.runId}`,
    type: "run.checkpoint.resume_authorized",
    executionScope,
    payload: {
      ...claimMetadata,
      runId: claim.runId,
      resumeAuthorityGranted: true,
    },
  }, { sql });
  return Object.freeze({
    outcome: "authorized" as const,
    reason: "checkpoint_fence_acquired" as const,
    claim,
    fenceAcquired: true as const,
    resumeAuthorityGranted: true as const,
  });
}

/**
 * Acquires or reclaims one exact checkpoint fence inside a caller-owned
 * transaction. This store is dormant: acquisition alone never resumes a run.
 */
export async function acquireRunCheckpointResumeClaim(
  input: {
    tenantId: string;
    runId: string;
    checkpointId: string;
    checkpointSha256: string;
    approvalExecutionId: string;
    operationJobId: string;
    leaseOwner: string;
    leaseSeconds?: number;
    executionScope: ExecutionScope;
  },
  sql: RunCheckpointWriterSql,
): Promise<AcquireRunCheckpointResumeClaimResult> {
  requireTransaction(sql);
  const tenantId = runContractIdSchema.parse(input.tenantId);
  const runId = runContractIdSchema.parse(input.runId);
  const checkpointId = runContractIdSchema.parse(input.checkpointId);
  const checkpointSha256 = z.string().regex(/^[a-f0-9]{64}$/).parse(
    input.checkpointSha256,
  );
  const approvalExecutionId = runContractIdSchema.parse(
    input.approvalExecutionId,
  );
  const operationJobId = runContractIdSchema.parse(input.operationJobId);
  const leaseOwner = z.string().min(1).max(512).parse(input.leaseOwner);
  const leaseSeconds = leaseSecondsSchema.parse(input.leaseSeconds ?? 60);
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope || executionScope.tenantId !== tenantId) {
    throw new Error("Checkpoint resume claim changed its tenant scope.");
  }

  const checkpointRows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2
     ORDER BY sequence DESC
     LIMIT 2
     FOR SHARE`,
    [tenantId, runId],
  );
  if (checkpointRows.length === 0) {
    return paused("checkpoint_not_latest");
  }
  const checkpoint = parseRunCheckpointV1(checkpointRows[0]?.checkpoint_json);
  if (
    checkpoint.checkpointId !== checkpointId ||
    checkpoint.checkpointSha256 !== checkpointSha256 ||
    checkpoint.boundary.boundaryId !== approvalExecutionId
  ) {
    return paused("checkpoint_not_latest");
  }
  assertCheckpointScope(checkpoint, executionScope);
  if (
    checkpoint.boundary.kind !== "approval" ||
    checkpoint.boundary.phase !== "after" ||
    checkpoint.lifecycleState !== "active" ||
    checkpoint.resumeDisposition !== "resumable"
  ) {
    return paused("checkpoint_not_resumable");
  }

  const compatibility = decideRunCheckpointCompatibilityV1({
    checkpoint,
    supportedPins: [checkpoint.enginePin],
  });
  if (compatibility.disposition !== "resume") {
    return paused(
      compatibility.reason === "rollout_not_resumable"
        ? "rollout_not_resumable"
        : "checkpoint_not_resumable",
    );
  }
  if (!(await liveRolloutMatches(checkpoint, sql))) {
    return paused("rollout_not_resumable");
  }

  const runRows = await sql.query(
    `SELECT id, status,
            continuation->'pendingToolCall'->>'executionId' AS approval_execution_id,
            continuation->'checkpointResumeClaim'->>'checkpointId' AS claimed_checkpoint_id,
            continuation->'checkpointResumeClaim'->>'checkpointSha256' AS claimed_checkpoint_sha256
     FROM omni_agent_runs
     WHERE tenant_id = $1 AND id = $2
     LIMIT 2
     FOR UPDATE`,
    [tenantId, runId],
  );
  if (
    runRows.length !== 1 ||
    runRows[0]?.approval_execution_id !== checkpoint.boundary.boundaryId ||
    !(
      runRows[0]?.status === "waiting_approval" ||
      (
        runRows[0]?.status === "resuming" &&
        runRows[0]?.claimed_checkpoint_id === checkpoint.checkpointId &&
        runRows[0]?.claimed_checkpoint_sha256 === checkpoint.checkpointSha256
      )
    )
  ) {
    return paused("run_not_waiting");
  }

  const toolRows = await sql.query(
    `SELECT id, status, approval_decision, effect_receipt
     FROM omni_tool_executions
     WHERE COALESCE(tenant_id, 'default') = $1 AND id = $2
     LIMIT 2
     FOR SHARE`,
    [tenantId, checkpoint.boundary.boundaryId],
  );
  if (!terminalApprovedToolMatches(toolRows, checkpoint, tenantId)) {
    return paused("tool_not_terminal");
  }

  const claimToken = randomUUID();
  const tokenSha256 = claimDigest("token", claimToken);
  const ownerSha256 = claimDigest("owner", leaseOwner);
  const insertedRows = await sql.query(
    `INSERT INTO omni_run_checkpoint_resume_claims (
       tenant_id, run_id, checkpoint_id, checkpoint_sha256,
       operation_job_id, lease_generation, claim_token_sha256,
       lease_owner_sha256, lease_expires_at, status
     ) VALUES (
       $1, $2, $3, $4, $5, 1, $6, $7,
       statement_timestamp() + ($8::int * INTERVAL '1 second'), 'claimed'
     )
     ON CONFLICT (tenant_id, run_id, checkpoint_id) DO NOTHING
     RETURNING operation_job_id, lease_generation, lease_expires_at, status`,
    [
      tenantId,
      runId,
      checkpointId,
      checkpointSha256,
      operationJobId,
      tokenSha256,
      ownerSha256,
      leaseSeconds,
    ],
  );
  if (insertedRows.length > 1) {
    throw new Error("Checkpoint resume claim insert was ambiguous.");
  }
  if (insertedRows.length === 1) {
    const claim = claimFromRow({
      ...insertedRows[0],
      tenant_id: tenantId,
      run_id: runId,
      checkpoint_id: checkpointId,
      checkpoint_sha256: checkpointSha256,
      claim_token: claimToken,
    });
    await appendClaimEvent("claimed", checkpoint, claim, executionScope, sql);
    return acquired(claim);
  }

  const currentRows = await sql.query(
    `SELECT tenant_id, run_id, checkpoint_id, checkpoint_sha256,
            operation_job_id, lease_generation, lease_expires_at, status,
            lease_expires_at <= statement_timestamp() AS lease_expired
     FROM omni_run_checkpoint_resume_claims
     WHERE tenant_id = $1 AND run_id = $2 AND checkpoint_id = $3
     LIMIT 2
     FOR UPDATE`,
    [tenantId, runId, checkpointId],
  );
  if (currentRows.length !== 1) {
    throw new Error("Checkpoint resume claim conflict could not be resolved.");
  }
  const current = currentRows[0] as Record<string, unknown>;
  if (current.status === "completed") {
    return closed("already_completed", "claim_completed");
  }
  if (current.status !== "claimed" || current.lease_expired !== true) {
    return closed("busy", "active_claim");
  }
  const generation = generationSchema.parse(
    Number(current.lease_generation) + 1,
  );
  const reclaimedRows = await sql.query(
    `UPDATE omni_run_checkpoint_resume_claims
     SET operation_job_id = $5,
         lease_generation = $6,
         claim_token_sha256 = $7,
         lease_owner_sha256 = $8,
         lease_expires_at = statement_timestamp() + ($9::int * INTERVAL '1 second'),
         updated_at = statement_timestamp()
     WHERE tenant_id = $1 AND run_id = $2 AND checkpoint_id = $3
       AND checkpoint_sha256 = $4
       AND status = 'claimed'
       AND lease_generation = $10
       AND lease_expires_at <= statement_timestamp()
     RETURNING operation_job_id, lease_generation, lease_expires_at, status`,
    [
      tenantId,
      runId,
      checkpointId,
      checkpointSha256,
      operationJobId,
      generation,
      tokenSha256,
      ownerSha256,
      leaseSeconds,
      Number(current.lease_generation),
    ],
  );
  if (reclaimedRows.length !== 1) {
    return closed("busy", "active_claim");
  }
  const claim = claimFromRow({
    ...reclaimedRows[0],
    tenant_id: tenantId,
    run_id: runId,
    checkpoint_id: checkpointId,
    checkpoint_sha256: checkpointSha256,
    claim_token: claimToken,
  });
  await appendClaimEvent("reclaimed", checkpoint, claim, executionScope, sql);
  return acquired(claim);
}

/** Extends only the exact live generation and token. */
export async function heartbeatRunCheckpointResumeClaim(
  input: Pick<RunCheckpointResumeClaim,
    "tenantId" | "runId" | "checkpointId" | "leaseGeneration" | "claimToken"
  > & { leaseSeconds?: number },
  sql: RunCheckpointWriterSql,
): Promise<boolean> {
  requireTransaction(sql);
  const leaseSeconds = leaseSecondsSchema.parse(input.leaseSeconds ?? 60);
  const rows = await sql.query(
    `UPDATE omni_run_checkpoint_resume_claims
     SET lease_expires_at = statement_timestamp() + ($6::int * INTERVAL '1 second'),
         updated_at = statement_timestamp()
     WHERE tenant_id = $1 AND run_id = $2 AND checkpoint_id = $3
       AND lease_generation = $4
       AND claim_token_sha256 = $5
       AND status = 'claimed'
       AND lease_expires_at > statement_timestamp()
     RETURNING checkpoint_id`,
    [
      runContractIdSchema.parse(input.tenantId),
      runContractIdSchema.parse(input.runId),
      runContractIdSchema.parse(input.checkpointId),
      generationSchema.parse(input.leaseGeneration),
      claimDigest("token", claimTokenSchema.parse(input.claimToken)),
      leaseSeconds,
    ],
  );
  return rows.length === 1;
}

/** Completes only the exact unexpired fence and emits its terminal receipt. */
export async function completeRunCheckpointResumeClaim(
  input: RunCheckpointResumeClaim & { executionScope: ExecutionScope },
  sql: RunCheckpointWriterSql,
): Promise<boolean> {
  requireTransaction(sql);
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope || executionScope.tenantId !== input.tenantId) {
    throw new Error("Checkpoint resume completion changed its tenant scope.");
  }
  const checkpointRows = await sql.query(
    `SELECT checkpoint_json
     FROM omni_run_checkpoints
     WHERE tenant_id = $1 AND run_id = $2 AND checkpoint_id = $3
     LIMIT 2
     FOR SHARE`,
    [input.tenantId, input.runId, input.checkpointId],
  );
  if (checkpointRows.length !== 1) return false;
  const checkpoint = parseRunCheckpointV1(checkpointRows[0]?.checkpoint_json);
  assertCheckpointScope(checkpoint, executionScope);
  if (checkpoint.checkpointSha256 !== input.checkpointSha256) return false;

  const rows = await sql.query(
    `UPDATE omni_run_checkpoint_resume_claims
     SET status = 'completed', completed_at = statement_timestamp(),
         updated_at = statement_timestamp()
     WHERE tenant_id = $1 AND run_id = $2 AND checkpoint_id = $3
       AND checkpoint_sha256 = $4
       AND operation_job_id = $5
       AND lease_generation = $6
       AND claim_token_sha256 = $7
       AND status = 'claimed'
       AND lease_expires_at > statement_timestamp()
     RETURNING operation_job_id, lease_generation, lease_expires_at, status`,
    [
      input.tenantId,
      input.runId,
      input.checkpointId,
      input.checkpointSha256,
      input.operationJobId,
      generationSchema.parse(input.leaseGeneration),
      claimDigest("token", claimTokenSchema.parse(input.claimToken)),
    ],
  );
  if (rows.length !== 1) return false;
  await appendClaimEvent("completed", checkpoint, input, executionScope, sql);
  return true;
}

async function liveRolloutMatches(
  checkpoint: RunCheckpointV1,
  sql: RunCheckpointWriterSql,
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT capability_id, rollout_generation, engine_version,
            contract_version_id, configuration_sha256, mode, status,
            lifecycle_revision
     FROM omni_tenant_capability_rollouts
     WHERE tenant_id = $1 AND capability_id = $2
       AND status <> 'superseded'
     LIMIT 2
     FOR SHARE`,
    [checkpoint.executionScope.tenantId, checkpoint.enginePin.rolloutCapabilityId],
  );
  if (rows.length !== 1) return false;
  const row = rows[0] as Record<string, unknown>;
  const pin = checkpoint.enginePin;
  return (
    row.capability_id === pin.rolloutCapabilityId &&
    Number(row.rollout_generation) === pin.rolloutGeneration &&
    row.engine_version === pin.engineVersionId &&
    row.contract_version_id === pin.contractVersionId &&
    row.configuration_sha256 === pin.configurationSha256 &&
    row.mode === pin.rolloutMode &&
    row.status === "active" &&
    Number(row.lifecycle_revision) === pin.rolloutLifecycleRevision
  );
}

function terminalApprovedToolMatches(
  rows: Record<string, unknown>[],
  checkpoint: RunCheckpointV1,
  tenantId: string,
): boolean {
  if (rows.length !== 1) return false;
  const row = rows[0] as Record<string, unknown>;
  if (
    row.id !== checkpoint.boundary.boundaryId ||
    row.approval_decision !== "approved" ||
    !["executed", "failed", "blocked"].includes(String(row.status || ""))
  ) {
    return false;
  }
  const hasToolReference = checkpoint.stateReferences.some(
    (reference) =>
      reference.kind === "tool_execution" &&
      reference.referenceId === checkpoint.boundary.boundaryId,
  );
  const hasDecisionReference = checkpoint.stateReferences.some(
    (reference) =>
      reference.kind === "approval_decision" &&
      reference.referenceId === checkpoint.boundary.boundaryId,
  );
  if (!hasToolReference || !hasDecisionReference) return false;
  if (row.effect_receipt == null) return true;
  const receipt = plainRecord(row.effect_receipt);
  try {
    if (receipt?.schemaVersion === 1) {
      return Boolean(parseEffectReceiptV1(row.effect_receipt, {
        tenantId,
        executionId: String(row.id),
      }));
    }
    if (receipt?.schemaVersion === 2) {
      return Boolean(parseEffectReceiptV2(row.effect_receipt, {
        tenantId,
        executionId: String(row.id),
      }));
    }
  } catch {
    return false;
  }
  return false;
}

function assertCheckpointScope(
  checkpoint: RunCheckpointV1,
  executionScope: ExecutionScope,
) {
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
  if (
    rebuilt.checkpointId !== checkpoint.checkpointId ||
    rebuilt.checkpointSha256 !== checkpoint.checkpointSha256
  ) {
    throw new Error("Checkpoint resume claim changed its execution scope.");
  }
}

async function appendClaimEvent(
  phase: "claimed" | "reclaimed" | "completed",
  checkpoint: RunCheckpointV1,
  claim: RunCheckpointResumeClaim,
  executionScope: ExecutionScope,
  sql: RunCheckpointWriterSql,
) {
  await appendDomainEvent({
    id: `run-checkpoint-resume-${phase}:${checkpoint.checkpointSha256}:${claim.leaseGeneration}`,
    streamId: `run:${checkpoint.runId}`,
    type: `run.checkpoint.resume_${phase}`,
    executionScope,
    payload: {
      schemaVersion: 1,
      checkpointId: checkpoint.checkpointId,
      checkpointSha256: checkpoint.checkpointSha256,
      runId: checkpoint.runId,
      operationJobId: claim.operationJobId,
      leaseGeneration: claim.leaseGeneration,
      phase,
      resumeAuthorityGranted: false,
    },
  }, { sql });
}

function claimFromRow(row: Record<string, unknown>): RunCheckpointResumeClaim {
  return Object.freeze({
    tenantId: runContractIdSchema.parse(row.tenant_id),
    runId: runContractIdSchema.parse(row.run_id),
    checkpointId: runContractIdSchema.parse(row.checkpoint_id),
    checkpointSha256: z.string().regex(/^[a-f0-9]{64}$/).parse(
      row.checkpoint_sha256,
    ),
    operationJobId: runContractIdSchema.parse(row.operation_job_id),
    leaseGeneration: generationSchema.parse(Number(row.lease_generation)),
    leaseExpiresAt: canonicalTimestamp(row.lease_expires_at),
    claimToken: claimTokenSchema.parse(row.claim_token),
  });
}

function acquired(claim: RunCheckpointResumeClaim): AcquireRunCheckpointResumeClaimResult {
  return Object.freeze({
    outcome: "acquired" as const,
    reason: "claimed" as const,
    claim,
    fenceAcquired: true,
    resumeAuthorityGranted: false as const,
  });
}

function paused(
  reason: Extract<AcquireRunCheckpointResumeClaimResult["reason"],
    | "checkpoint_not_latest"
    | "checkpoint_not_resumable"
    | "rollout_not_resumable"
    | "run_not_waiting"
    | "tool_not_terminal"
  >,
): AcquireRunCheckpointResumeClaimResult {
  return closed("paused", reason);
}

function closed(
  outcome: "busy" | "already_completed" | "paused",
  reason: AcquireRunCheckpointResumeClaimResult["reason"],
): AcquireRunCheckpointResumeClaimResult {
  return Object.freeze({
    outcome,
    reason,
    claim: null,
    fenceAcquired: false,
    resumeAuthorityGranted: false as const,
  });
}

function claimDigest(kind: "token" | "owner", value: string): string {
  return createHash("sha256")
    .update(`${CLAIM_DIGEST_DOMAIN}:${kind}:`)
    .update(value)
    .digest("hex");
}

export function runCheckpointResumeClaimTokenSha256(claimToken: string): string {
  return claimDigest("token", claimTokenSchema.parse(claimToken));
}

function canonicalTimestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Checkpoint resume claim timestamp is invalid.");
  }
  return date.toISOString();
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function requireTransaction(sql: RunCheckpointWriterSql) {
  if (!sql.transactionScoped) {
    throw new Error("Checkpoint resume claims require an existing transaction.");
  }
}
