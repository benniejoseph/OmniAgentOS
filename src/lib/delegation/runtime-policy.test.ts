import { describe, expect, it } from "vitest";

import {
  DYNAMIC_DELEGATION_CHILD_BUDGET,
  DYNAMIC_DELEGATION_LIFECYCLE_BUDGET,
  DYNAMIC_DELEGATION_READ_TOOL_IDS,
  DYNAMIC_DELEGATION_VERIFIER_BUDGET,
  assertDynamicDelegationApprovalPolicy,
  dynamicDelegationCapabilityQueryPrefix,
  dynamicDelegationLifecycleBudget,
  dynamicDelegationMaxToolSteps,
  dynamicDelegationParentToolReservation,
  dynamicDelegationRootReservation,
  extractExplicitDynamicDelegationReadToolIds,
  hasExplicitDynamicDelegationIntent,
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

  it("allows one bounded tool-call repair round and reserves final synthesis", () => {
    expect(DYNAMIC_DELEGATION_CHILD_BUDGET.modelTurns).toBe(4);
    expect(DYNAMIC_DELEGATION_LIFECYCLE_BUDGET.modelTurns).toBe(5);
    expect(dynamicDelegationMaxToolSteps()).toBe(3);
    expect(dynamicDelegationMaxToolSteps({
      ...DYNAMIC_DELEGATION_CHILD_BUDGET,
      modelTurns: 2,
    })).toBe(1);
  });

  it("does not grant mutation, browser, or re-delegation authority", () => {
    expect(DYNAMIC_DELEGATION_CHILD_BUDGET).toMatchObject({
      modelTurns: 4,
      browserActions: 0,
      fanOut: 0,
      retries: 1,
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

  it("extracts only explicitly named safe child read tools", () => {
    const request = [
      "Delegate Scout with Search Knowledge and List Runs, then Mnemosyne",
      "with memory.search. Do not use Web Search or app.memory.write.",
    ].join(" ");

    expect(hasExplicitDynamicDelegationIntent(request)).toBe(true);
    expect(extractExplicitDynamicDelegationReadToolIds(request)).toEqual([
      "knowledge.search",
      "runs.list",
      "memory.search",
    ]);
    expect(dynamicDelegationCapabilityQueryPrefix(request)).toBe(
      "app.agents.delegate knowledge.search runs.list memory.search",
    );

    const negativeList = [
      "Delegate Scout without Search Knowledge or List Runs.",
      "Grant Mnemosyne Search Memory instead.",
    ].join(" ");
    expect(extractExplicitDynamicDelegationReadToolIds(negativeList)).toEqual([
      "memory.search",
    ]);
    expect(dynamicDelegationCapabilityQueryPrefix(negativeList)).toBe(
      "app.agents.delegate memory.search",
    );
  });

  it("does not infer delegation or unsafe grants from ordinary coordination", () => {
    expect(hasExplicitDynamicDelegationIntent(
      "Coordinate the calendar and summarize app.memory.write.",
    )).toBe(false);
    expect(extractExplicitDynamicDelegationReadToolIds(
      "Use app.memory.write and google.gmail.send.",
    )).toEqual([]);
    expect(dynamicDelegationCapabilityQueryPrefix(
      "Search Knowledge for the answer without creating a child Agent.",
    )).toBe("");
    expect(hasExplicitDynamicDelegationIntent(
      "Use Search Memory for this bounded task. No further delegation.",
    )).toBe(false);
    expect(dynamicDelegationCapabilityQueryPrefix(
      "Explain child agents; do not create one.",
    )).toBe("");
    expect(dynamicDelegationCapabilityQueryPrefix(
      "Research delegation patterns without spawning an agent.",
    )).toBe("");
    expect(dynamicDelegationCapabilityQueryPrefix(
      "Do not delegate this task to Scout.",
    )).toBe("");
    expect(dynamicDelegationCapabilityQueryPrefix(
      "We should not delegate this task to Scout.",
    )).toBe("");
  });

  it("recognizes imperative requests for named built-in Agents", () => {
    const request = [
      "Please ask Scout to inspect the delegation runtime,",
      "then ask Mnemosyne to classify the memory patterns.",
    ].join(" ");

    expect(hasExplicitDynamicDelegationIntent(request)).toBe(true);
    expect(dynamicDelegationCapabilityQueryPrefix(request)).toBe(
      "app.agents.delegate",
    );
    expect(hasExplicitDynamicDelegationIntent(
      "Review the runtime first; then ask Mnemosyne to classify the results.",
    )).toBe(true);
    expect(hasExplicitDynamicDelegationIntent(
      "Have Forge review the implementation.",
    )).toBe(true);
    expect(hasExplicitDynamicDelegationIntent(
      "Could you please ask Scout to inspect the repository?",
    )).toBe(true);
  });

  it("keeps negated and descriptive named-Agent language inert", () => {
    expect(hasExplicitDynamicDelegationIntent(
      "Do not ask Scout to inspect the runtime.",
    )).toBe(false);
    expect(hasExplicitDynamicDelegationIntent(
      "Please do not ask Mnemosyne to classify the memory patterns.",
    )).toBe(false);
    expect(hasExplicitDynamicDelegationIntent(
      "Explain how to ask Scout to inspect a repository.",
    )).toBe(false);
    expect(hasExplicitDynamicDelegationIntent(
      "The previous run asked Scout to inspect the repository.",
    )).toBe(false);
    expect(hasExplicitDynamicDelegationIntent(
      '"Ask Scout to inspect the repository" is documentation text.',
    )).toBe(false);
    expect(hasExplicitDynamicDelegationIntent(
      "How could you ask Scout to inspect a repository?",
    )).toBe(false);
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
