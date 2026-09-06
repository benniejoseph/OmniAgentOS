import { describe, expect, it } from "vitest";

import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  type LoopV2Checkpoint,
} from "@/lib/orchestration/loop-v2";
import {
  finalizeLoopV2Run,
  readLoopV2CheckpointChain,
  recordLoopV2Checkpoint,
  type LoopV2CheckpointWriterSql,
} from "@/lib/orchestration/loop-v2-store";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const at = "2026-09-06T03:00:00.000Z";

describe("Loop v2 checkpoint store", () => {
  it("persists one contiguous chain and converges exact retries", async () => {
    const storage = fakeStorage();
    const root = initial();
    const first = await recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: executionScope(),
    }, storage.sql);
    expect(first).toMatchObject({
      inserted: true,
      executionAuthorityGranted: false,
      checkpoint: { toState: "understand" },
    });

    const plan = advanceLoopV2Checkpoint({
      current: root,
      executionScope: executionScope(),
      trigger: "plan_bound",
      outputReceiptSha256: sourceContractSha256("bounded-read-plan"),
      transitionedAt: "2026-09-06T03:01:00.000Z",
    });
    await expect(recordLoopV2Checkpoint({
      checkpoint: plan,
      executionScope: executionScope(),
    }, storage.sql)).resolves.toMatchObject({ inserted: true });
    await expect(recordLoopV2Checkpoint({
      checkpoint: plan,
      executionScope: executionScope(),
    }, storage.sql)).resolves.toMatchObject({ inserted: false });

    const chain = await readLoopV2CheckpointChain(
      { tenantId: "tenant-a", runId: "run-a" },
      storage.sql,
    );
    expect(chain.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "plan",
    ]);
    expect(storage.eventCount()).toBe(3);
  });

  it("fails closed when transaction, rollout, run, or scope bindings differ", async () => {
    const root = initial();
    const unscoped = fakeStorage();
    Object.defineProperty(unscoped.sql, "transactionScoped", { value: false });
    await expect(recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: executionScope(),
    }, unscoped.sql)).rejects.toThrow("existing transaction");

    const paused = fakeStorage({ rolloutStatus: "paused" });
    await expect(recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: executionScope(),
    }, paused.sql)).rejects.toThrow("rollout changed");

    const inactiveRun = fakeStorage({ runStatus: "completed" });
    await expect(recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: executionScope(),
    }, inactiveRun.sql)).rejects.toThrow("active actor-owned run");

    const wrongScope = createExecutionScope({
      tenantId: "tenant-a",
      initiatingActorId: "actor-b",
      executingPrincipalType: "agent",
      executingPrincipalId: "atlas",
      correlationId: "run-a",
      purpose: "agent.loop.v2.read_only_canary",
    });
    await expect(recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: wrongScope,
    }, fakeStorage().sql)).rejects.toThrow("scope does not match");
  });

  it("commits the terminal checkpoint and run disposition together", async () => {
    const storage = fakeStorage();
    let current = initial();
    await recordLoopV2Checkpoint({
      checkpoint: current,
      executionScope: executionScope(),
    }, storage.sql);
    for (const [trigger, minute] of [
      ["plan_bound", 1],
      ["action_started", 2],
      ["action_succeeded", 3],
      ["observation_recorded", 4],
    ] as const) {
      current = advanceLoopV2Checkpoint({
        current,
        executionScope: executionScope(),
        trigger,
        outputReceiptSha256: sourceContractSha256(trigger),
        transitionedAt: `2026-09-06T03:0${minute}:00.000Z`,
      });
      await recordLoopV2Checkpoint({
        checkpoint: current,
        executionScope: executionScope(),
      }, storage.sql);
    }
    const terminal = advanceLoopV2Checkpoint({
      current,
      executionScope: executionScope(),
      trigger: "verification_passed",
      outputReceiptSha256: sourceContractSha256("verified"),
      transitionedAt: "2026-09-06T03:05:00.000Z",
    });

    await expect(finalizeLoopV2Run({
      checkpoint: terminal,
      executionScope: executionScope(),
      response: "Five recent runs.",
    }, storage.sql)).resolves.toMatchObject({
      runStatus: "completed",
      checkpoint: { terminalDisposition: "succeeded" },
    });
    expect(storage.runStatus()).toBe("completed");
  });
});

function fakeStorage(options: {
  runStatus?: string;
  rolloutStatus?: string;
} = {}) {
  const checkpoints: LoopV2Checkpoint[] = [];
  let eventCount = 0;
  let currentRunStatus = options.runStatus || "running";
  const sql = (async (
    strings: TemplateStringsArray,
    ..._params: unknown[]
  ) => {
    const text = strings.join(" ");
    if (text.includes("INSERT INTO omni_events")) {
      eventCount += 1;
      return [{ seq: eventCount }];
    }
    if (text.includes("SELECT * FROM omni_events")) return [];
    throw new Error(`Unexpected tagged SQL: ${text}`);
  }) as unknown as LoopV2CheckpointWriterSql;
  Object.defineProperty(sql, "transactionScoped", { value: true, configurable: true });
  sql.transaction = async () => {
    throw new Error("Nested transactions are not expected.");
  };
  sql.unsafe = async () => [];
  sql.query = async (text: string, params: unknown[] = []) => {
    if (text.includes("FROM omni_agent_runs")) {
      return [{ owner_actor_id: "actor-a", status: currentRunStatus }];
    }
    if (text.includes("type = 'run.scope_bound'")) {
      return [{ payload: { _executionScope: executionScope() } }];
    }
    if (text.includes("FROM omni_tenant_capability_rollouts")) {
      return [{
        rollout_generation: 1,
        engine_version: LOOP_V2_ENGINE_VERSION_ID,
        contract_version_id: LOOP_V2_CONTRACT_VERSION_ID,
        configuration_sha256: LOOP_V2_CONFIGURATION_SHA256,
        mode: "canary",
        status: options.rolloutStatus || "active",
        lifecycle_revision: 1,
      }];
    }
    if (
      text.includes("FROM omni_agent_loop_v2_checkpoints") &&
      text.includes("ORDER BY sequence DESC")
    ) {
      return [...checkpoints]
        .reverse()
        .slice(0, 2)
        .map((checkpoint) => ({ checkpoint_json: checkpoint }));
    }
    if (text.includes("INSERT INTO omni_agent_loop_v2_checkpoints")) {
      const checkpoint = params[20] as LoopV2Checkpoint;
      if (
        checkpoints.some((candidate) =>
          candidate.checkpointId === checkpoint.checkpointId ||
          candidate.sequence === checkpoint.sequence
        )
      ) return [];
      checkpoints.push(checkpoint);
      return [{ checkpoint_json: checkpoint }];
    }
    if (
      text.includes("FROM omni_agent_loop_v2_checkpoints") &&
      text.includes("checkpoint_id = $3")
    ) {
      return checkpoints
        .filter((checkpoint) => checkpoint.checkpointId === params[2])
        .map((checkpoint) => ({ checkpoint_json: checkpoint }));
    }
    if (
      text.includes("FROM omni_agent_loop_v2_checkpoints") &&
      text.includes("ORDER BY sequence ASC")
    ) {
      return [...checkpoints]
        .sort((left, right) => left.sequence - right.sequence)
        .map((checkpoint) => ({ checkpoint_json: checkpoint }));
    }
    if (text.includes("UPDATE omni_agent_runs")) {
      if (!["running", "resuming"].includes(currentRunStatus)) return [];
      currentRunStatus = String(params[3]);
      return [{ id: "run-a" }];
    }
    throw new Error(`Unexpected query SQL: ${text}`);
  };
  return {
    sql,
    eventCount: () => eventCount,
    runStatus: () => currentRunStatus,
  };
}

function initial() {
  return createInitialLoopV2Checkpoint({
    tenantId: "tenant-a",
    runId: "run-a",
    ownerActorId: "actor-a",
    executionScope: executionScope(),
    enginePin: buildLoopV2EnginePin(rollout()),
    transitionedAt: at,
  });
}

function executionScope() {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: "actor-a",
    executingPrincipalType: "agent",
    executingPrincipalId: "atlas",
    correlationId: "run-a",
    purpose: "agent.loop.v2.read_only_canary",
  });
}

function rollout(): TenantCapabilityRollout {
  return {
    schemaVersion: 1,
    tenantId: "tenant-a",
    capabilityId: LOOP_V2_CAPABILITY_ID,
    rolloutGeneration: 1,
    engineVersion: LOOP_V2_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: LOOP_V2_CONFIGURATION_SHA256,
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
