import { describe, expect, it } from "vitest";

import {
  DYNAMIC_DELEGATION_CHILD_BUDGET,
  DYNAMIC_DELEGATION_READ_TOOL_IDS,
  assertDynamicDelegationApprovalPolicy,
  dynamicDelegationParentToolReservation,
  dynamicDelegationRootReservation,
} from "@/lib/delegation/runtime-policy";

describe("dynamic delegation runtime policy", () => {
  it("pre-reserves the exact bounded child slice and one fan-out slot", () => {
    expect(dynamicDelegationRootReservation()).toEqual({
      ...DYNAMIC_DELEGATION_CHILD_BUDGET,
      agents: 1,
      fanOut: 1,
    });
  });

  it("charges the parent for both the governed scheduling call and child", () => {
    expect(dynamicDelegationParentToolReservation()).toEqual({
      ...dynamicDelegationRootReservation(),
      toolCalls: DYNAMIC_DELEGATION_CHILD_BUDGET.toolCalls + 1,
    });
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
