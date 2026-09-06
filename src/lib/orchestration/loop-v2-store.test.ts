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
  resumeLoopV2Clarification,
  waitForLoopV2Clarification,
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

  it("pins admitted runs across rollout changes while rejecting new roots", async () => {
    const admitted = fakeStorage();
    const root = initial();
    await recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: executionScope(),
    }, admitted.sql);
    admitted.setRolloutStatus("superseded");
    const plan = advanceLoopV2Checkpoint({
      current: root,
      executionScope: executionScope(),
      trigger: "plan_bound",
      outputReceiptSha256: sourceContractSha256("pinned-plan"),
      transitionedAt: "2026-09-06T03:01:00.000Z",
    });
    await expect(recordLoopV2Checkpoint({
      checkpoint: plan,
      executionScope: executionScope(),
    }, admitted.sql)).resolves.toMatchObject({
      inserted: true,
      checkpoint: { toState: "plan" },
    });

    const paused = fakeStorage({ rolloutStatus: "paused" });
    await expect(recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: executionScope(),
    }, paused.sql)).rejects.toThrow("root admission");
  });

  it("atomically waits and resumes one exact actor-bound clarification", async () => {
    const storage = fakeStorage();
    const root = initial();
    await recordLoopV2Checkpoint({
      checkpoint: root,
      executionScope: executionScope(),
    }, storage.sql);
    const clarification = advanceLoopV2Checkpoint({
      current: root,
      executionScope: executionScope(),
      trigger: "ambiguity_detected",
      outputReceiptSha256: sourceContractSha256("ambiguous-read"),
      transitionedAt: "2026-09-06T03:01:00.000Z",
    });

    await expect(waitForLoopV2Clarification({
      checkpoint: clarification,
      executionScope: executionScope(),
      clarificationPrompt: "List the five most recent runs?",
    }, storage.sql)).resolves.toMatchObject({
      runStatus: "waiting_clarification",
      checkpoint: { toState: "clarify" },
    });
    expect(storage.runStatus()).toBe("waiting_clarification");

    const receipt = sourceContractSha256("yes");
    const resumed = await resumeLoopV2Clarification({
      tenantId: "tenant-a",
      runId: "run-a",
      threadId: "thread-a",
      ownerActorId: "actor-a",
      agentId: "atlas",
      requestExecutionScope: createExecutionScope({
        tenantId: "tenant-a",
        initiatingActorId: "actor-a",
        executingPrincipalType: "agent",
        executingPrincipalId: "atlas",
        correlationId: "clarification-response-a",
        purpose: "agent.loop.v2.read_only_canary",
      }),
      clarificationReceiptSha256: receipt,
      transitionedAt: "2026-09-06T03:02:00.000Z",
    }, storage.sql);
    expect(resumed).toMatchObject({
      runId: "run-a",
      threadId: "thread-a",
      inserted: true,
      checkpoint: {
        fromState: "clarify",
        toState: "plan",
        trigger: "clarified",
        inputReceiptSha256: receipt,
      },
    });
    expect(resumed.executionScope).toEqual(executionScope());
    expect(storage.runStatus()).toBe("resuming");

    await expect(resumeLoopV2Clarification({
      tenantId: "tenant-a",
      runId: "run-a",
      threadId: "thread-a",
      ownerActorId: "actor-a",
      agentId: "atlas",
      requestExecutionScope: executionScope(),
      clarificationReceiptSha256: receipt,
    }, storage.sql)).resolves.toMatchObject({ inserted: false });
    const chain = await readLoopV2CheckpointChain(
      { tenantId: "tenant-a", runId: "run-a" },
      storage.sql,
    );
    expect(chain.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "clarify",
      "plan",
    ]);
  });
});

function fakeStorage(options: {
  runStatus?: string;
  rolloutStatus?: string;
} = {}) {
  const checkpoints: LoopV2Checkpoint[] = [];
  let eventCount = 0;
  let currentRunStatus = options.runStatus || "running";
  let currentRolloutStatus = options.rolloutStatus || "active";
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
      return [{
        id: "run-a",
        owner_actor_id: "actor-a",
        thread_id: "thread-a",
        agent_id: "atlas",
        status: currentRunStatus,
      }];
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
        status: currentRolloutStatus,
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
      if (text.includes("SET status = 'waiting_clarification'")) {
        if (currentRunStatus !== "running") return [];
        currentRunStatus = "waiting_clarification";
        return [{ id: "run-a" }];
      }
      if (text.includes("SET status = 'resuming'")) {
        if (currentRunStatus !== "waiting_clarification") return [];
        currentRunStatus = "resuming";
        return [{ id: "run-a" }];
      }
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
    setRolloutStatus: (status: string) => {
      currentRolloutStatus = status;
    },
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
