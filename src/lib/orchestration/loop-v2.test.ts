import { describe, expect, it } from "vitest";

import {
  advanceLoopV2Checkpoint,
  buildLoopV2EnginePin,
  createInitialLoopV2Checkpoint,
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
  replayLoopV2Checkpoints,
} from "@/lib/orchestration/loop-v2";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const at = "2026-09-06T02:00:00.000Z";
const evidence = (value: string) => sourceContractSha256(value);

describe("Loop v2 transition checkpoints", () => {
  it("replays the deterministic read-only success path", () => {
    const values = successChain();
    expect(values.map((checkpoint) => checkpoint.toState)).toEqual([
      "understand",
      "plan",
      "act",
      "observe",
      "verify",
      "finish",
    ]);
    expect(replayLoopV2Checkpoints(values)).toMatchObject({
      toState: "finish",
      lifecycleState: "terminal",
      terminalDisposition: "succeeded",
      retryCount: 0,
      replanCount: 0,
    });
  });

  it("makes clarification waiting and cancellation explicit", () => {
    const root = initial();
    const waiting = next(root, "ambiguity_detected", 1);
    expect(waiting).toMatchObject({
      fromState: "understand",
      toState: "clarify",
      lifecycleState: "waiting",
    });
    const canceled = next(waiting, "canceled", 2);
    expect(canceled).toMatchObject({
      toState: "finish",
      terminalDisposition: "canceled",
    });
    expect(() => next(canceled, "plan_bound", 3)).toThrow("cannot transition");
  });

  it("bounds retries and replans before an explicit failed finish", () => {
    let current = next(initial(), "plan_bound", 1);
    current = next(current, "action_started", 2);
    current = next(current, "retry_scheduled", 3);
    current = next(current, "retry_scheduled", 4);
    expect(current.retryCount).toBe(2);
    expect(() => next(current, "retry_scheduled", 5)).toThrow("retry budget");
    current = next(current, "action_failed", 5);
    expect(current).toMatchObject({ toState: "replan", replanCount: 1 });
    current = next(current, "replan_bound", 6);
    current = next(current, "action_started", 7);
    current = next(current, "budget_exhausted", 8);
    expect(current).toMatchObject({
      toState: "finish",
      terminalDisposition: "failed",
      retryCount: 2,
      replanCount: 1,
    });
  });

  it("rejects unsupported rollouts, invalid edges, scope changes, and chain tampering", () => {
    expect(() => buildLoopV2EnginePin({ ...rollout(), mode: "enabled" })).toThrow(
      "active supported canary",
    );
    const root = initial();
    expect(() => next(root, "action_started", 1)).toThrow("not allowed");
    expect(() => advanceLoopV2Checkpoint({
      current: root,
      executionScope: scope("actor-b"),
      trigger: "plan_bound",
      outputReceiptSha256: evidence("plan"),
      transitionedAt: "2026-09-06T02:01:00.000Z",
    })).toThrow("read-only scope");
    const chain = successChain();
    const tampered = chain.map((checkpoint) => ({ ...checkpoint }));
    tampered[3].parentCheckpointSha256 = evidence("tampered");
    expect(() => replayLoopV2Checkpoints(tampered)).toThrow();
  });
});

function successChain() {
  const checkpoints = [initial()];
  for (const [trigger, minute] of [
    ["plan_bound", 1],
    ["action_started", 2],
    ["action_succeeded", 3],
    ["observation_recorded", 4],
    ["verification_passed", 5],
  ] as const) {
    checkpoints.push(next(checkpoints.at(-1)!, trigger, minute));
  }
  return checkpoints;
}

function initial() {
  return createInitialLoopV2Checkpoint({
    tenantId: "tenant-a",
    runId: "run-a",
    ownerActorId: "actor-a",
    executionScope: scope(),
    enginePin: buildLoopV2EnginePin(rollout()),
    transitionedAt: at,
  });
}

function next(
  current: ReturnType<typeof initial>,
  trigger: Parameters<typeof advanceLoopV2Checkpoint>[0]["trigger"],
  minute: number,
) {
  return advanceLoopV2Checkpoint({
    current,
    executionScope: scope(),
    trigger,
    outputReceiptSha256: evidence(`${trigger}:${minute}`),
    transitionedAt: `2026-09-06T02:${String(minute).padStart(2, "0")}:00.000Z`,
  });
}

function scope(actorId = "actor-a") {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: actorId,
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
