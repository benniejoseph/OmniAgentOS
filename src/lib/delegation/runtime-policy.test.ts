import { describe, expect, it } from "vitest";

import {
  DYNAMIC_DELEGATION_CHILD_BUDGET,
  DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
  DYNAMIC_DELEGATION_READ_TOOL_IDS,
  DYNAMIC_DELEGATION_VERIFIER_BUDGET,
  assertDynamicDelegationApprovalPolicy,
  dynamicDelegationLifecycleBudget,
  dynamicDelegationMaxToolSteps,
  dynamicDelegationParentToolReservation,
  dynamicDelegationRootReservation,
  partitionDynamicDelegationLifecycleBudget,
  reserveDynamicDelegationVerifierSlice,
} from "@/lib/delegation/runtime-policy";
import {
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  createRunBudgetState,
  remainingRunBudget,
  reserveRunBudget,
} from "@/lib/runs/budgets";

describe("dynamic delegation runtime policy", () => {
  it("pre-reserves the exact child and Sentinel lifecycle plus one fan-out slot", () => {
    expect(dynamicDelegationRootReservation()).toEqual({
      ...DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
      fanOut: 1,
    });
    expect(dynamicDelegationLifecycleBudget()).toEqual(
      DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
    );
    expect(DYNAMIC_DELEGATION_LIFECYCLE_BUDGET.wallTimeMs).toBe(90_000);
  });

  it("charges the parent for both the governed scheduling call and child", () => {
    expect(dynamicDelegationParentToolReservation()).toEqual({
      ...dynamicDelegationRootReservation(),
      toolCalls: DYNAMIC_DELEGATION_LIFECYCLE_BUDGET.toolCalls + 1,
    });
  });

  it("keeps wall time as a shared lifecycle window with headroom after two children", () => {
    const startedAt = "2026-09-23T00:00:00.000Z";
    const reservation = dynamicDelegationParentToolReservation();
    const once = reserveRunBudget(
      createRunBudgetState(DEFAULT_AGENT_RUN_BUDGET_LIMITS, { startedAt }),
      reservation,
      Date.parse(startedAt),
    );
    const twice = reserveRunBudget(
      once,
      reservation,
      Date.parse(startedAt),
    );

    expect(twice.used.wallTimeMs).toBe(180_000);
    expect(remainingRunBudget(twice, Date.parse(startedAt)).wallTimeMs)
      .toBe(60_000);
    expect(twice.used.tokens).toBe(36_000);
    expect(remainingRunBudget(twice, Date.parse(startedAt)).tokens)
      .toBe(28_000);
  });

  it("partitions and reserves the fixed Sentinel slice without granting it to the child", () => {
    const partition = partitionDynamicDelegationLifecycleBudget(
      DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
    );
    expect(partition).toEqual({
      child: DYNAMIC_DELEGATION_CHILD_BUDGET,
      verifier: DYNAMIC_DELEGATION_VERIFIER_BUDGET,
    });
    expect(partition.verifier).toMatchObject({
      modelTurns: 1,
      toolCalls: 0,
      browserActions: 0,
      agents: 1,
      fanOut: 0,
      retries: 0,
      replans: 0,
    });
    const reservation = reserveDynamicDelegationVerifierSlice({
      lifecycle: DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
      startedAt: "2026-09-23T00:00:00.000Z",
    });
    expect(reservation.reserved.used).toEqual(
      DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
    );
    expect(() => partitionDynamicDelegationLifecycleBudget({
      ...DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
      modelTurns: DYNAMIC_DELEGATION_LIFECYCLE_BUDGET.modelTurns + 1,
    })).toThrow(/does not match/i);
  });

  it("reserves the last child model turn for final synthesis", () => {
    expect(dynamicDelegationMaxToolSteps()).toBe(2);
    expect(dynamicDelegationMaxToolSteps({
      ...DYNAMIC_DELEGATION_CHILD_BUDGET,
      modelTurns: 2,
    })).toBe(1);
  });

  it("does not grant mutation, browser, or re-delegation authority", () => {
    expect(DYNAMIC_DELEGATION_CHILD_BUDGET).toMatchObject({
      modelTurns: 3,
      browserActions: 0,
      fanOut: 0,
      retries: 0,
      replans: 0,
    });
    expect(DYNAMIC_DELEGATION_READ_TOOL_IDS).toEqual([
      "memory.search",
      "knowledge.search",
      "web.search",
      "runs.list",
    ]);
    expect(DYNAMIC_DELEGATION_READ_TOOL_IDS.every((toolId) =>
      !/(?:create|update|delete|send|execute|delegate)/.test(toolId)
    )).toBe(true);
  });

  it("fails closed before a live delegation can be parked for approval", () => {
    expect(() => assertDynamicDelegationApprovalPolicy({
      toolId: "app.agents.delegate",
      forceApproval: true,
    })).toThrow(/cannot be parked for later approval/i);
    expect(() => assertDynamicDelegationApprovalPolicy({
      toolId: "app.agents.delegate",
      forceApproval: false,
    })).not.toThrow();
    expect(() => assertDynamicDelegationApprovalPolicy({
      toolId: "app.memory.write",
      forceApproval: true,
    })).not.toThrow();
  });
});
