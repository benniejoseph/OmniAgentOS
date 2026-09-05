import { beforeEach, describe, expect, it, vi } from "vitest";

const eventMocks = vi.hoisted(() => ({ appendDomainEvent: vi.fn() }));

vi.mock("@/lib/events/store", () => ({
  appendDomainEvent: eventMocks.appendDomainEvent,
}));

import {
  acquireRunCheckpointResumeClaim,
  authorizeAgentRunCheckpointResume,
  completeRunCheckpointResumeClaim,
  heartbeatRunCheckpointResumeClaim,
} from "@/lib/runs/checkpoint-resume-claim";
import type { RunCheckpointWriterSql } from "@/lib/runs/checkpoint-store";
import {
  buildRunCheckpointV1,
  type RunCheckpointV1,
} from "@/lib/runs/checkpoints";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const RUN_ID = "run_checkpoint_claim_test";
const CHECKPOINT_ID_PLACEHOLDER = "checkpoint_claim_placeholder";
const EXECUTION_ID = "tool_execution_checkpoint_claim";
const JOB_ID = "operation_job_checkpoint_claim";
const LEASE_EXPIRES_AT = "2026-09-05T18:01:00.000Z";
const SCOPE = createExecutionScope({
  tenantId: "tenant_checkpoint_claim",
  initiatingActorId: "actor_checkpoint_claim",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_checkpoint_claim",
  correlationId: RUN_ID,
  causationId: "turn_checkpoint_claim",
  contextGrantIds: ["context_checkpoint_claim"],
  capabilityGrantIds: ["capability_checkpoint_claim"],
  purpose: "Claim a checkpoint resume fence.",
});

function checkpoint(mode: "shadow" | "canary" = "canary"): RunCheckpointV1 {
  return buildRunCheckpointV1({
    runId: RUN_ID,
    executionScope: SCOPE,
    boundary: {
      kind: "approval",
      phase: "after",
      boundaryId: EXECUTION_ID,
      attempt: 1,
    },
    sequence: 1,
    parent: {
      checkpointId: CHECKPOINT_ID_PLACEHOLDER,
      checkpointSha256: canonicalJsonSha256("parent"),
      sequence: 0,
    },
    enginePin: {
      rolloutCapabilityId: "agent_run_checkpoints",
      engineVersionId: "agent_approval_continuation_v1",
      contractVersionId: "run_checkpoint_v1",
      configurationSha256: canonicalJsonSha256("claim-configuration"),
      runContractEnvelopeId: "run_contract_checkpoint_claim",
      runContractEnvelopeSha256: canonicalJsonSha256("run-contract"),
      harnessManifestId: "harness_checkpoint_claim",
      harnessManifestSha256: canonicalJsonSha256("harness"),
      rolloutMode: mode,
      rolloutLifecycleStatus: "active",
      rolloutGeneration: 2,
      rolloutLifecycleRevision: 1,
    },
    stateReferences: [
      {
        kind: "approval_decision",
        referenceId: EXECUTION_ID,
        referenceSha256: canonicalJsonSha256("decision"),
        versionId: "governed_tool_approval_v1",
      },
      {
        kind: "run_record",
        referenceId: RUN_ID,
        referenceSha256: canonicalJsonSha256("run"),
        versionId: "agent_run_v1",
      },
      {
        kind: "tool_execution",
        referenceId: EXECUTION_ID,
        referenceSha256: canonicalJsonSha256("tool"),
        versionId: "governed_tool_execution_v1",
      },
    ],
    toolBinding: null,
    resourceUsage: {
      modelCallCount: 1,
      modelInputTokenCount: 10,
      modelOutputTokenCount: 5,
      cachedInputTokenCount: 0,
      toolCallCount: 1,
      toolResultByteCount: 0,
      externalEffectCount: 0,
      boundaryExternalEffectCount: 0,
      elapsedMs: 5_000,
    },
    lifecycleState: "active",
    resumeDisposition: "resumable",
    recordedAt: "2026-09-05T18:00:00.000Z",
  });
}

describe("checkpoint resume claims", () => {
  beforeEach(() => {
    eventMocks.appendDomainEvent.mockReset();
    eventMocks.appendDomainEvent.mockResolvedValue({});
  });

  it("requires a caller-owned transaction", async () => {
    const value = checkpoint();
    const sql = fakeSql(value, { transactionScoped: false });

    await expect(acquireRunCheckpointResumeClaim(
      acquireInput(value),
      sql,
    )).rejects.toThrow(/existing transaction/i);
  });

  it("cannot claim a shadow checkpoint", async () => {
    const value = checkpoint("shadow");
    const sql = fakeSql(value);

    const result = await acquireRunCheckpointResumeClaim(
      acquireInput(value),
      sql,
    );

    expect(result).toEqual({
      outcome: "paused",
      reason: "rollout_not_resumable",
      claim: null,
      fenceAcquired: false,
      resumeAuthorityGranted: false,
    });
  });

  it("acquires a hashed, exact canary fence without granting resume authority", async () => {
    const value = checkpoint();
    const calls: Array<{ text: string; params: unknown[] }> = [];
    const sql = fakeSql(value, { calls });

    const result = await acquireRunCheckpointResumeClaim(
      acquireInput(value),
      sql,
    );

    expect(result).toMatchObject({
      outcome: "acquired",
      reason: "claimed",
      fenceAcquired: true,
      resumeAuthorityGranted: false,
      claim: {
        tenantId: SCOPE.tenantId,
        runId: RUN_ID,
        checkpointId: value.checkpointId,
        checkpointSha256: value.checkpointSha256,
        operationJobId: JOB_ID,
        leaseGeneration: 1,
        leaseExpiresAt: LEASE_EXPIRES_AT,
      },
    });
    expect(result.claim?.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    const insert = calls.find((call) =>
      call.text.includes("INSERT INTO omni_run_checkpoint_resume_claims")
    );
    expect(insert?.params.join(" ")).not.toContain(result.claim?.claimToken);
    expect(eventMocks.appendDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run.checkpoint.resume_claimed",
        payload: expect.objectContaining({
          leaseGeneration: 1,
          resumeAuthorityGranted: false,
        }),
      }),
      { sql },
    );
  });

  it("reports an unexpired claim as busy and reclaims an expired generation", async () => {
    const value = checkpoint();
    const busy = fakeSql(value, { existingClaimExpired: false });
    await expect(acquireRunCheckpointResumeClaim(
      acquireInput(value),
      busy,
    )).resolves.toMatchObject({ outcome: "busy", reason: "active_claim" });

    const expired = fakeSql(value, { existingClaimExpired: true });
    const reclaimed = await acquireRunCheckpointResumeClaim(
      acquireInput(value),
      expired,
    );
    expect(reclaimed).toMatchObject({
      outcome: "acquired",
      claim: { leaseGeneration: 2 },
      resumeAuthorityGranted: false,
    });
    expect(eventMocks.appendDomainEvent).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: "run.checkpoint.resume_reclaimed" }),
      { sql: expired },
    );
  });

  it("heartbeats and completes only an exact unexpired token generation", async () => {
    const value = checkpoint();
    const sql = fakeSql(value, { lifecycleUpdates: true });
    const claim = {
      tenantId: SCOPE.tenantId,
      runId: RUN_ID,
      checkpointId: value.checkpointId,
      checkpointSha256: value.checkpointSha256,
      operationJobId: JOB_ID,
      leaseGeneration: 3,
      leaseExpiresAt: LEASE_EXPIRES_AT,
      claimToken: "b9096a20-22b1-49de-a834-4ad83158e321",
    };

    await expect(heartbeatRunCheckpointResumeClaim(claim, sql)).resolves.toBe(true);
    await expect(completeRunCheckpointResumeClaim(
      { ...claim, executionScope: SCOPE },
      sql,
    )).resolves.toBe(true);
    expect(eventMocks.appendDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "run.checkpoint.resume_completed",
        payload: expect.objectContaining({ leaseGeneration: 3 }),
      }),
      { sql },
    );
  });

  it("authorizes the run transition only in the same claim transaction", async () => {
    const value = checkpoint();
    const sql = fakeSql(value, { authorizeTransition: true });

    const result = await authorizeAgentRunCheckpointResume(
      acquireInput(value),
      sql,
    );

    expect(result).toMatchObject({
      outcome: "authorized",
      reason: "checkpoint_fence_acquired",
      fenceAcquired: true,
      resumeAuthorityGranted: true,
    });
    expect(eventMocks.appendDomainEvent).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: "run.checkpoint.resume_authorized",
        payload: expect.objectContaining({
          checkpointId: value.checkpointId,
          resumeAuthorityGranted: true,
        }),
      }),
      { sql },
    );
  });
});

function acquireInput(value: RunCheckpointV1) {
  return {
    tenantId: SCOPE.tenantId,
    runId: RUN_ID,
    checkpointId: value.checkpointId,
    checkpointSha256: value.checkpointSha256,
    approvalExecutionId: EXECUTION_ID,
    operationJobId: JOB_ID,
    leaseOwner: "worker:test-lease-owner",
    leaseSeconds: 60,
    executionScope: SCOPE,
  };
}

function fakeSql(
  value: RunCheckpointV1,
  options: {
    transactionScoped?: boolean;
    calls?: Array<{ text: string; params: unknown[] }>;
    existingClaimExpired?: boolean;
    lifecycleUpdates?: boolean;
    authorizeTransition?: boolean;
  } = {},
): RunCheckpointWriterSql {
  const query = async (text: string, params: unknown[] = []) => {
    options.calls?.push({ text, params });
    if (text.includes("FROM omni_run_checkpoints")) {
      return [{ checkpoint_json: value }];
    }
    if (text.includes("FROM omni_tenant_capability_rollouts")) {
      return [{
        capability_id: value.enginePin.rolloutCapabilityId,
        rollout_generation: value.enginePin.rolloutGeneration,
        engine_version: value.enginePin.engineVersionId,
        contract_version_id: value.enginePin.contractVersionId,
        configuration_sha256: value.enginePin.configurationSha256,
        mode: value.enginePin.rolloutMode,
        status: "active",
        lifecycle_revision: value.enginePin.rolloutLifecycleRevision,
      }];
    }
    if (text.includes("FROM omni_agent_runs")) {
      return [{
        id: RUN_ID,
        status: "waiting_approval",
        approval_execution_id: EXECUTION_ID,
      }];
    }
    if (text.includes("FROM omni_tool_executions")) {
      return [{
        id: EXECUTION_ID,
        status: "executed",
        approval_decision: "approved",
        effect_receipt: null,
      }];
    }
    if (options.authorizeTransition && text.includes("UPDATE omni_agent_runs")) {
      return [{ id: RUN_ID }];
    }
    if (text.includes("INSERT INTO omni_run_checkpoint_resume_claims")) {
      if (options.existingClaimExpired !== undefined) return [];
      return [{
        operation_job_id: JOB_ID,
        lease_generation: 1,
        lease_expires_at: LEASE_EXPIRES_AT,
        status: "claimed",
      }];
    }
    if (
      text.includes("FROM omni_run_checkpoint_resume_claims") &&
      text.includes("lease_expired")
    ) {
      return [{
        tenant_id: SCOPE.tenantId,
        run_id: RUN_ID,
        checkpoint_id: value.checkpointId,
        checkpoint_sha256: value.checkpointSha256,
        operation_job_id: "operation_job_prior_claim",
        lease_generation: 1,
        lease_expires_at: "2026-09-05T17:59:00.000Z",
        status: "claimed",
        lease_expired: options.existingClaimExpired,
      }];
    }
    if (
      text.includes("UPDATE omni_run_checkpoint_resume_claims") &&
      text.includes("lease_generation = $6")
    ) {
      return [{
        operation_job_id: JOB_ID,
        lease_generation: 2,
        lease_expires_at: LEASE_EXPIRES_AT,
        status: "claimed",
      }];
    }
    if (options.lifecycleUpdates && text.includes("UPDATE omni_run_checkpoint_resume_claims")) {
      return [{ checkpoint_id: value.checkpointId }];
    }
    throw new Error(`Unexpected query: ${text}`);
  };
  const sql = (async () => []) as unknown as RunCheckpointWriterSql;
  sql.query = query;
  sql.unsafe = query;
  sql.transaction = async () => {
    throw new Error("Nested transaction is forbidden.");
  };
  Object.defineProperty(sql, "transactionScoped", {
    value: options.transactionScoped ?? true,
  });
  return sql;
}
