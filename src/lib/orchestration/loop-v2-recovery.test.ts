import { describe, expect, it } from "vitest";

import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
  LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
  LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  claimInterruptedLoopV2Run,
  decideLoopV2InterruptionRecovery,
} from "@/lib/orchestration/loop-v2-recovery";
import type { LoopV2CheckpointWriterSql } from "@/lib/orchestration/loop-v2-store";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const at = "2026-09-06T03:00:00.000Z";

describe("Loop v2 interrupted-run recovery", () => {
  it.each(["understand", "plan", "act", "observe", "verify"] as const)(
    "replays the idempotent read boundary from %s",
    (state) => {
      expect(decideLoopV2InterruptionRecovery(readCheckpointAt(state))).toEqual({
        action: "resume_read_only",
        reasonCode: "idempotent_read_replay",
        replayedExternalEffectCount: 0,
      });
    },
  );

  it("fails closed for replans, model boundaries, and exhausted claims", () => {
    const verify = readCheckpointAt("verify");
    const replan = advanceLoopV2Checkpoint({
      current: verify,
      executionScope: readExecutionScope(),
      trigger: "verification_failed",
      outputReceiptSha256: sourceContractSha256("verification-failed"),
      transitionedAt: "2026-09-06T03:05:00.000Z",
    });
    expect(decideLoopV2InterruptionRecovery(replan)).toMatchObject({
      action: "fail_closed",
      reasonCode: "replan_requires_new_authority",
    });
    expect(decideLoopV2InterruptionRecovery(modelCheckpoint())).toMatchObject({
      action: "fail_closed",
      reasonCode: "non_replayable_model_boundary",
    });
    expect(decideLoopV2InterruptionRecovery(verify, 4)).toMatchObject({
      action: "fail_closed",
      reasonCode: "recovery_attempts_exhausted",
    });
  });

  it("rejects waiting and terminal checkpoints before claiming recovery", () => {
    const root = readCheckpointAt("understand");
    const waiting = advanceLoopV2Checkpoint({
      current: root,
      executionScope: readExecutionScope(),
      trigger: "ambiguity_detected",
      outputReceiptSha256: sourceContractSha256("ambiguous"),
      transitionedAt: "2026-09-06T03:01:00.000Z",
    });
    expect(() => decideLoopV2InterruptionRecovery(waiting)).toThrow(
      "active checkpoint",
    );
  });

  it("stores only a claim-token digest and emits content-free claim evidence", async () => {
    const checkpoint = readCheckpointAt("act");
    const storage = recoveryClaimStorage(checkpoint);
    const claimed = await claimInterruptedLoopV2Run({
      tenantId: "tenant-a",
      leaseOwner: "maintenance-worker-a",
      staleAfterMs: 60_000,
      leaseSeconds: 60,
      now: "2026-09-06T04:00:00.000Z",
    }, storage.sql);

    expect(claimed).toMatchObject({
      run: {
        id: "run-a",
        tenantId: "tenant-a",
        ownerActorId: "actor-a",
        mode: "orchestrate",
        agentId: "atlas",
      },
      checkpoint: { checkpointSha256: checkpoint.checkpointSha256 },
      fence: {
        tenantId: "tenant-a",
        runId: "run-a",
        claimedCheckpointSha256: checkpoint.checkpointSha256,
        leaseGeneration: 1,
      },
    });
    const metadata = storage.recoveryMetadata();
    expect(metadata).toMatchObject({
      schemaVersion: 1,
      checkpointSha256: checkpoint.checkpointSha256,
      leaseGeneration: 1,
      claimTokenSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      leaseOwnerSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(metadata).not.toHaveProperty("claimToken");
    expect(JSON.stringify(metadata)).not.toContain(claimed?.fence.claimToken);
    expect(storage.claimEvent()).toMatchObject({
      type: "run.loop_v2.recovery_claimed",
      payload: expect.objectContaining({
        runId: "run-a",
        checkpointState: "act",
        replayedExternalEffectCount: 0,
      }),
    });
    expect(JSON.stringify(storage.claimEvent())).not.toContain(
      claimed?.fence.claimToken,
    );
  });
});

function recoveryClaimStorage(checkpoint: LoopV2Checkpoint) {
  let recoveryMetadata: Record<string, unknown> = {};
  let claimEvent: { type?: unknown; payload?: unknown } = {};
  const sql = (async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => {
    const text = strings.join(" ");
    if (text.includes("INSERT INTO omni_events")) {
      claimEvent = { type: params[2], payload: params[5] };
      return [{ seq: 1 }];
    }
    throw new Error(`Unexpected tagged SQL: ${text}`);
  }) as unknown as LoopV2CheckpointWriterSql;
  Object.defineProperty(sql, "transactionScoped", { value: true });
  sql.transaction = async () => {
    throw new Error("Nested transactions are not expected.");
  };
  sql.unsafe = async () => [];
  sql.query = async (text: string, params: unknown[] = []) => {
    if (
      text.includes("FROM omni_agent_runs run") &&
      text.includes("FOR UPDATE OF run")
    ) {
      return [{
        id: "run-a",
        owner_actor_id: "actor-a",
        thread_id: "thread-a",
        mode: "orchestrate",
        prompt: "Show my recent runs",
        agent_id: "atlas",
        continuation: null,
      }];
    }
    if (
      text.includes("FROM omni_agent_loop_v2_checkpoints") &&
      text.includes("FOR SHARE")
    ) {
      return [{
        checkpoint_json: checkpoint,
        lifecycle_state: checkpoint.lifecycleState,
        transitioned_at: checkpoint.transitionedAt,
      }];
    }
    if (text.includes("type = 'run.scope_bound'")) {
      return [{ payload: { _executionScope: readExecutionScope() } }];
    }
    if (
      text.includes("UPDATE omni_agent_runs") &&
      text.includes("loopV2Recovery")
    ) {
      recoveryMetadata = params[2] as Record<string, unknown>;
      return [{ id: "run-a" }];
    }
    throw new Error(`Unexpected query SQL: ${text}`);
  };
  return {
    sql,
    recoveryMetadata: () => recoveryMetadata,
    claimEvent: () => claimEvent,
  };
}

function readCheckpointAt(
  target: "understand" | "plan" | "act" | "observe" | "verify",
) {
  let current = createInitialLoopV2Checkpoint({
    tenantId: "tenant-a",
    runId: "run-a",
    ownerActorId: "actor-a",
    executionScope: readExecutionScope(),
    enginePin: buildLoopV2EnginePin(readRollout()),
    transitionedAt: at,
  });
  const transitions = [
    ["plan", "plan_bound"],
    ["act", "action_started"],
    ["observe", "action_succeeded"],
    ["verify", "observation_recorded"],
  ] as const;
  for (const [state, trigger] of transitions) {
    if (target === current.toState) break;
    current = advanceLoopV2Checkpoint({
      current,
      executionScope: readExecutionScope(),
      trigger,
      outputReceiptSha256: sourceContractSha256(trigger),
      transitionedAt: new Date(
        Date.parse(at) + current.sequence * 60_000,
      ).toISOString(),
    });
    if (target === state) break;
  }
  return current;
}

function modelCheckpoint() {
  const scope = createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: "run-model-a",
    purpose: "agent.loop.v2.model_text_canary",
  });
  return createInitialLoopV2Checkpoint({
    tenantId: "tenant-a",
    runId: "run-model-a",
    ownerActorId: "actor-a",
    executionScope: scope,
    enginePin: buildLoopV2EnginePin(modelRollout()),
    transitionedAt: at,
  });
}

function readExecutionScope() {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: "run-a",
    purpose: "agent.loop.v2.read_only_canary",
  });
}

function readRollout(): TenantCapabilityRollout {
  return rollout({
    capabilityId: LOOP_V2_CAPABILITY_ID,
    engineVersion: LOOP_V2_ENGINE_VERSION_ID,
    configurationSha256: LOOP_V2_CONFIGURATION_SHA256,
  });
}

function modelRollout(): TenantCapabilityRollout {
  return rollout({
    capabilityId: LOOP_V2_MODEL_TEXT_CAPABILITY_ID,
    engineVersion: LOOP_V2_MODEL_TEXT_ENGINE_VERSION_ID,
    configurationSha256: LOOP_V2_MODEL_TEXT_CONFIGURATION_SHA256,
  });
}

function rollout(input: {
  capabilityId: TenantCapabilityRollout["capabilityId"];
  engineVersion: string;
  configurationSha256: string;
}): TenantCapabilityRollout {
  return {
    schemaVersion: 1,
    tenantId: "tenant-a",
    capabilityId: input.capabilityId,
    rolloutGeneration: 1,
    engineVersion: input.engineVersion,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: input.configurationSha256,
    mode: "canary",
    status: "active",
    lifecycleRevision: 1,
    createdByActorId: "actor-a",
    activatedByActorId: "actor-a",
    activatedAt: at,
    createdAt: at,
    updatedAt: at,
  };
}
