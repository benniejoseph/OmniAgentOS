import { describe, expect, it } from "vitest";

import {
  DYNAMIC_DELEGATION_CHILD_BUDGET,
  DYNAMIC_DELEGATION_READ_TOOL_IDS,
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

  it("does not grant mutation, browser, or re-delegation authority", () => {
    expect(DYNAMIC_DELEGATION_CHILD_BUDGET).toMatchObject({
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
});
