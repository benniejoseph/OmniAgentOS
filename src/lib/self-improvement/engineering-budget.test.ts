import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunBudgetState, planModelTurnBudget, reserveRunBudget, settleModelTurnBudget, RunBudgetExceededError, remainingRunBudget, type RunBudgetStateV1 } from "@/lib/runs/budgets";
import { createInspectionCompletionGate, inspectionCompletionReceiptSchema, type InspectionReadReceipt } from "./inspection-completion";
import { selfImprovementRunBudgetLimits, type SelfImprovementBudgetProfile } from "./engineering-budget";
import { initialSelfImprovementRuntime, reserveImprovementPhase, selfImprovementRuntimeSchema } from "./runtime";

const now = Date.parse("2026-10-27T22:58:58.580Z");
// Measured token/cost scalars from the failed646 inspection. Estimates round
// each observed input upward: original serialized-input reservations and the
// tenant window were not retained. This is a deterministic planner replay
// estimate, not a claim to reproduce the original private model conversation.
const trajectory = [
  { estimatedInput: 6_000, tokens: 5_706, costMicrousd: 7_859 },
  { estimatedInput: 8_000, tokens: 7_594, costMicrousd: 3_585 },
  { estimatedInput: 9_000, tokens: 8_504, costMicrousd: 2_615 },
  { estimatedInput: 10_000, tokens: 9_239, costMicrousd: 2_544 },
  { estimatedInput: 12_000, tokens: 11_833, costMicrousd: 11_459 },
  { estimatedInput: 14_000, tokens: 13_398, costMicrousd: 4_567 },
  { estimatedInput: 17_000, tokens: 18_063, costMicrousd: 30_424 },
] as const;
// Atlas's unchanged 4k output plus ordinary5x8k result envelope: current
// input+4k and follow-up input+18k. Cost estimates are conservative synthetic
// values; actual captured cost is settled separately, never fabricated.
const estimate = (input: number) => ({ tokens: input + 4_000, followUpTokens: input + 18_000,
  costMicrousd: 100_000, followUpCostMicrousd: 120_000 });
const plan = { decision: "repair", plan: { summary: "Synthetic nominated dependency inspection.",
  sourcePaths: ["src/components/studio/state.ts", "src/lib/studio/contracts.ts"], newSourcePaths: [],
  focusedTestPaths: ["src/components/studio/capacity-regression.test.ts"], adjacentTestPaths: ["src/components/studio/state.test.ts"],
  acceptanceCriteria: ["Validate the bounded graph before any history change."] } };
const text = JSON.stringify(plan);
const sourceRead = (path: string, index: number): InspectionReadReceipt => ({ path, executionId: `synthetic-read-${index}`,
  inputSha256: "a".repeat(64), scopeSha256: "b".repeat(64) });
function completion() {
  const reads = [sourceRead(plan.plan.sourcePaths[0], 1), sourceRead(plan.plan.sourcePaths[0], 2), sourceRead(plan.plan.adjacentTestPaths[0], 3)];
  const gate = createInspectionCompletionGate({ runId: "11111111-1111-4111-8111-111111111111",
    sessionId: `app_build_${"a".repeat(48)}`, assertCurrent: async () => undefined, readReceipts: async () => reads });
  return { gate, reads };
}
function sixTurns(tokens: number) {
  let state = createRunBudgetState({ ...selfImprovementRunBudgetLimits({ profile: "inspect", costCeilingUsd: 1 }), tokens });
  for (const turn of trajectory.slice(0, 6)) {
    const planned = planModelTurnBudget(state, { estimate: estimate(turn.estimatedInput), toolsEnabled: true });
    expect(planned.finalTurn).toBe(false);
    state = settleModelTurnBudget(planned.state, planned.reserved, { ...turn, retries: 0 });
    state = reserveRunBudget(state, { toolCalls: 1 });
  }
  // The real once-only workflow adjacent read used one tool, no model turn.
  state = reserveRunBudget(state, { toolCalls: 1 });
  expect(state.used).toMatchObject({ modelTurns: 6, toolCalls: 7, tokens: 56_274, costMicrousd: 32_629 });
  return state;
}
function sevenTurns() {
  const planned = planModelTurnBudget(sixTurns(500_000), { estimate: estimate(trajectory[6].estimatedInput), toolsEnabled: true });
  expect(planned.finalTurn).toBe(false);
  return settleModelTurnBudget(planned.state, planned.reserved, { ...trajectory[6], retries: 0 });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe("bounded engineering cumulative budgets", () => {
  it.each(["ordinary", "inspect", "edit", "review"] as const)("only reduces the %s aggregate token allowance", profile => {
    const original = selfImprovementRunBudgetLimits({ profile, costCeilingUsd: 2 });
    for (const maxEngineeringTokensPerRun of [1, 80_000, 600_000, 1_000_000]) {
      expect(selfImprovementRunBudgetLimits({ profile, costCeilingUsd: 2, maxEngineeringTokensPerRun }))
        .toEqual({ ...original, tokens: Math.min(original.tokens, maxEngineeringTokensPerRun) });
    }
  });
  it.each([0, -1, 1.5, 1_000_001, NaN, Infinity])("rejects invalid internal token cap %s before model reservation", maxEngineeringTokensPerRun => {
    expect(() => selfImprovementRunBudgetLimits({ profile: "edit", costCeilingUsd: 2, maxEngineeringTokensPerRun })).toThrow(/token cap/);
  });
  it("enforces the admitted cap through the ordinary planner and keeps all six phase ceilings bounded", () => {
    const limits = selfImprovementRunBudgetLimits({ profile: "edit", costCeilingUsd: 2, maxEngineeringTokensPerRun: 600_000 });
    const state = createRunBudgetState(limits, { used: { tokens: 600_000 } });
    expect(() => planModelTurnBudget(state, { estimate: estimate(1_000), toolsEnabled: true })).toThrow(RunBudgetExceededError);
    // Atlas once, Forge three times and Sentinel twice cover a review correction.
    const profiles: SelfImprovementBudgetProfile[] = ["inspect", "edit", "edit", "review", "edit", "review"];
    const sum = profiles.reduce((total, profile) => total + selfImprovementRunBudgetLimits({ profile, costCeilingUsd: 2, maxEngineeringTokensPerRun: 600_000 }).tokens, 0);
    expect(sum).toBe(3_300_000);
  });
  it("retains every other phase ceiling and the ordinary100k allowance", () => {
    const ordinary = selfImprovementRunBudgetLimits({ profile: "ordinary", costCeilingUsd: 1 });
    expect(ordinary).toEqual({ modelTurns: 20, tokens: 100_000, costMicrousd: 1_000_000, wallTimeMs: 210_000,
      toolCalls: 48, browserActions: 0, agents: 1, fanOut: 0, retries: 1, replans: 0 });
    expect(selfImprovementRunBudgetLimits({ profile: "inspect", costCeilingUsd: 1 })).toEqual({ ...ordinary, tokens: 500_000 });
    expect(selfImprovementRunBudgetLimits({ profile: "review", costCeilingUsd: 1 })).toEqual({ ...ordinary, tokens: 500_000 });
    expect(selfImprovementRunBudgetLimits({ profile: "edit", costCeilingUsd: 2 })).toEqual({ ...ordinary, tokens: 1_000_000, costMicrousd: 2_000_000 });
  });
  it("replays the100k final-only boundary with source/test evidence but a missing declared dependency", async () => {
    const state = sixTurns(100_000), before = structuredClone(state);
    const planned = planModelTurnBudget(state, { estimate: estimate(17_000), toolsEnabled: true });
    expect(planned.finalTurn).toBe(true);
    expect(state).toEqual(before); // Planning is pure; caller decides admission.
    const { gate } = completion();
    const rejected = await gate.assessFinal({ text, incomplete: false, canCorrect: !planned.finalTurn });
    expect(rejected).toMatchObject({ receipt: { outcome: "rejected", reason: "completion_budget_unavailable", correctionUsed: false,
      missingSourcePaths: ["src/lib/studio/contracts.ts"], adjacentCandidates: plan.plan.adjacentTestPaths } });
    expect(rejected.feedback).toBeUndefined();
  });
  it("uses the same bounded run and planner for one dependency read and an accepted unchanged plan", async () => {
    let state = sevenTurns();
    expect(state.used).toMatchObject({ modelTurns: 7, tokens: 74_337, costMicrousd: 63_053, toolCalls: 7 });
    const { gate, reads } = completion();
    const first = await gate.assessFinal({ text, incomplete: false, canCorrect: true });
    expect(first).toMatchObject({ receipt: { outcome: "needs_reads", correctionUsed: true, missingSourcePaths: ["src/lib/studio/contracts.ts"] } });
    const correction = planModelTurnBudget(state, { estimate: estimate(18_000), toolsEnabled: true });
    expect(correction.finalTurn).toBe(false);
    state = settleModelTurnBudget(correction.state, correction.reserved, { tokens: 18_120, costMicrousd: 23_700, retries: 0 });
    state = reserveRunBudget(state, { toolCalls: 1 });
    reads.push(sourceRead("src/lib/studio/contracts.ts", 4));
    const final = planModelTurnBudget(state, { estimate: estimate(20_000), toolsEnabled: true });
    expect(final.finalTurn).toBe(false);
    state = settleModelTurnBudget(final.state, final.reserved, { tokens: 21_308, costMicrousd: 38_080, retries: 0 });
    const accepted = await gate.assessFinal({ text, incomplete: false, canCorrect: true });
    expect(inspectionCompletionReceiptSchema.parse(accepted.receipt)).toMatchObject({ outcome: "accepted", correctionUsed: true, result: plan });
    expect(state.used).toMatchObject({ modelTurns: 9, toolCalls: 8, tokens: 113_765, costMicrousd: 124_833, retries: 0 });
    expect(state.limits).toEqual(selfImprovementRunBudgetLimits({ profile: "inspect", costCeilingUsd: 1 }));
  });
  it.each(["tokens", "cost", "time", "tools", "turns", "tenant_tokens", "tenant_cost"] as const)("still refuses the unread dependency at the %s boundary", async boundary => {
    let state: RunBudgetStateV1 = sevenTurns();
    const ceiling = { tokens: { limit: 1_000_000, used: 0 }, costMicrousd: { limit: 2_000_000, used: 0 } };
    if (boundary === "tokens") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, tokens: 485_000 } });
    if (boundary === "cost") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, costMicrousd: 950_000 } });
    if (boundary === "time") vi.setSystemTime(now + state.limits.wallTimeMs + 1);
    if (boundary === "tools") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, toolCalls: 48 } });
    if (boundary === "turns") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, modelTurns: 19 } });
    if (boundary === "tenant_tokens") ceiling.tokens.used = 985_000;
    if (boundary === "tenant_cost") ceiling.costMicrousd.used = 1_950_000;
    const before = structuredClone(state);
    let canCorrect = false;
    try { canCorrect = !planModelTurnBudget(state, { estimate: estimate(18_000), toolsEnabled: true, ceiling }).finalTurn; } catch (error) { expect(error).toBeInstanceOf(RunBudgetExceededError); }
    expect(canCorrect).toBe(false);
    expect(state).toEqual(before);
    const { gate } = completion();
    expect(await gate.assessFinal({ text, incomplete: false, canCorrect })).toMatchObject({ receipt: {
      outcome: "rejected", reason: "completion_budget_unavailable", correctionUsed: false, missingSourcePaths: ["src/lib/studio/contracts.ts"],
    } });
    expect(gate.accepted()).toBeUndefined();
  });
});

// Measured 9a5 Forge usage. Input reservations are rounded upward from the
// recorded inputs (12,254 / 13,120 / 15,614 / 16,361); the original serialized
// estimates and tenant window are unavailable. No private prompt is replayed.
const forgeTrajectory = [
  { estimatedInput: 13_000, tokens: 12_513, costMicrousd: 17_908 },
  { estimatedInput: 14_000, tokens: 13_177, costMicrousd: 3_002 },
  { estimatedInput: 16_000, tokens: 15_710, costMicrousd: 5_790 },
  { estimatedInput: 17_000, tokens: 16_837, costMicrousd: 21_035 },
] as const;
const engineeringEstimate = (profile: SelfImprovementBudgetProfile, input: number) => profile === "edit"
  ? { tokens: input + 8_000, followUpTokens: input + 26_000, costMicrousd: 120_000, followUpCostMicrousd: 180_000 }
  : estimate(input);

describe("measured usage replay estimates and synthetic lifecycle headroom", () => {
  it("reproduces Forge's100k final-only decision and admits the same measured prefix under the bound edit profile", () => {
    const prefix = (profile: SelfImprovementBudgetProfile) => {
      let state = reserveRunBudget(createRunBudgetState(selfImprovementRunBudgetLimits({ profile, costCeilingUsd: 2 })), { toolCalls: 4 });
      for (const turn of forgeTrajectory.slice(0, 3)) {
        const next = planModelTurnBudget(state, { estimate: engineeringEstimate("edit", turn.estimatedInput), toolsEnabled: true });
        expect(next.finalTurn).toBe(false);
        state = reserveRunBudget(settleModelTurnBudget(next.state, next.reserved, { ...turn, retries: 0 }), { toolCalls: 1 });
      }
      expect(state.used).toMatchObject({ modelTurns: 3, toolCalls: 7, tokens: 41_400, costMicrousd: 26_700 });
      return state;
    };
    const fourth = forgeTrajectory[3];
    expect(planModelTurnBudget(prefix("ordinary"), { estimate: engineeringEstimate("edit", fourth.estimatedInput), toolsEnabled: true }).finalTurn).toBe(true);
    const next = planModelTurnBudget(prefix("edit"), { estimate: engineeringEstimate("edit", fourth.estimatedInput), toolsEnabled: true });
    expect(next.finalTurn).toBe(false);
    const settled = settleModelTurnBudget(next.state, next.reserved, { ...fourth, retries: 0 });
    expect(settled.used).toMatchObject({ modelTurns: 4, toolCalls: 7, tokens: 58_237, costMicrousd: 47_735 });
    expect(planModelTurnBudget(settled, { estimate: engineeringEstimate("edit", 22_000), toolsEnabled: true }).finalTurn).toBe(false);
    // This proves budget admission, not a new write or successful Forge run.
  });

  it("retains the measured twelve-call Atlas usage while allowing follow-up beyond the previous250k boundary", () => {
    const measured = [
      [5_719, 5_998, 9_939], [8_537, 8_584, 7_397], [10_020, 10_152, 4_341],
      [10_833, 10_880, 2_635], [13_296, 13_343, 4_994], [15_475, 15_587, 5_632],
      [17_997, 18_045, 5_552], [18_837, 18_903, 4_046], [21_277, 21_326, 5_918],
      [23_671, 23_720, 6_175], [24_698, 25_553, 12_927], [26_159, 26_643, 9_027],
    ];
    let state = createRunBudgetState(selfImprovementRunBudgetLimits({ profile: "inspect", costCeilingUsd: 1 }));
    for (const [index, [input, tokens, costMicrousd]] of measured.entries()) {
      const replayEstimate = estimate(Math.ceil(input / 2_000) * 2_000);
      if (index === 11) {
        const previous = createRunBudgetState({ ...state.limits, tokens: 250_000 }, { startedAt: state.startedAt, used: state.used });
        expect(planModelTurnBudget(previous, { estimate: replayEstimate, toolsEnabled: true }).finalTurn).toBe(true);
      }
      const next = planModelTurnBudget(state, { estimate: replayEstimate, toolsEnabled: true });
      expect(next.finalTurn).toBe(false);
      state = settleModelTurnBudget(next.state, next.reserved, { tokens, costMicrousd, retries: 0 });
    }
    expect(state.used).toMatchObject({ modelTurns: 12, tokens: 198_734, costMicrousd: 78_583 });
  });

  it("budgets six synthetic lifecycle runs without conflating twenty model turns with sixteen tool rounds", () => {
    // Planner/reservation replay only: realistic growing context and explicitly
    // synthetic usage. Actual worker/executor evidence is retained separately.
    const phases = ["inspect", "reproduce", "implement", "review", "implement", "review"] as const;
    let runtime = initialSelfImprovementRuntime();
    const tenant = { tokens: { limit: 5_000_000, used: 0 }, costMicrousd: { limit: 25_000_000, used: 0 } };
    const results: Array<{ models: number; rounds: number; tools: number; ceiling: number }> = [];
    for (const [phaseIndex, phase] of phases.entries()) {
      const start = now + phaseIndex * 210_000;
      vi.setSystemTime(start);
      runtime = reserveImprovementPhase(runtime, 10, phase, new Date(start).toISOString());
      const ceiling = runtime.phaseAttempt!.costCeilingUsd;
      expect(() => reserveImprovementPhase(runtime, 10, phase, new Date(start).toISOString())).toThrow(/reconciliation/);
      const profile = phase === "inspect" ? "inspect" : phase === "review" ? "review" : "edit";
      const workflowCalls = phase === "inspect" ? 2 : phase === "reproduce" ? 4 : phase === "implement" ? 6 : 0;
      // The real runner charges ceil(calls/5) rounds for these known reads.
      let rounds = Math.ceil(workflowCalls / 5);
      let state = reserveRunBudget(createRunBudgetState(selfImprovementRunBudgetLimits({ profile, costCeilingUsd: ceiling })), { toolCalls: workflowCalls });
      for (let turn = 0; ; turn++) {
        const toolsEnabled = rounds < 16;
        const input = (profile === "edit" ? 16_000 : 6_000) + turn * (profile === "edit" ? 4_000 : 2_000);
        const next = planModelTurnBudget(state, { estimate: engineeringEstimate(profile, input), toolsEnabled, ceiling: tenant });
        expect(next.finalTurn).toBe(false);
        const spent = { tokens: input + (profile === "edit" ? 500 : 300), costMicrousd: profile === "edit" ? 35_000 : 20_000, retries: 0 };
        state = settleModelTurnBudget(next.state, next.reserved, spent);
        tenant.tokens.used += spent.tokens; tenant.costMicrousd.used += spent.costMicrousd;
        if (!toolsEnabled) break; // Final answer, not an extra tool-enabled round.
        state = reserveRunBudget(state, { toolCalls: 2 });
        rounds++;
        vi.setSystemTime(start + (turn + 1) * 6_000);
      }
      expect(state.used.tokens).toBeGreaterThan(100_000);
      expect(remainingRunBudget(state).modelTurns).toBeGreaterThan(0);
      expect(remainingRunBudget(state).wallTimeMs).toBeGreaterThan(0);
      expect(state.used.toolCalls).toBeLessThan(48);
      results.push({ models: state.used.modelTurns, rounds, tools: state.used.toolCalls, ceiling });
      runtime = selfImprovementRuntimeSchema.parse({ ...runtime, phaseAttempt: null, agentRuns: [...runtime.agentRuns, {
        phase, agentId: profile === "edit" ? "forge" : profile === "inspect" ? "atlas" : "sentinel",
        runId: `11111111-1111-4111-8111-${String(phaseIndex + 1).padStart(12, "0")}`, costCeilingUsd: ceiling, completed: true,
      }] });
    }
    expect(results.map(item => item.models)).toEqual([16, 16, 15, 17, 15, 17]);
    expect(results.map(item => item.rounds)).toEqual([16, 16, 16, 16, 16, 16]);
    expect(results.map(item => item.ceiling)).toEqual([1, 2, 2, 1, 2, 1]);
    expect(runtime.reservedModelUsd).toBe(9);
    expect(runtime.agentRuns).toHaveLength(6);
    expect(() => reserveImprovementPhase(runtime, 10, "review", new Date().toISOString())).toThrow(/exhausted/);
    expect(tenant.tokens.used).toBeLessThan(tenant.tokens.limit);
    expect(tenant.costMicrousd.used).toBeLessThan(9_000_000);
  });

  it.each(["edit", "review"] as const)("keeps all exhaustion dimensions closed for the %s profile", profile => {
    for (const boundary of ["tokens", "cost", "time", "tools", "turns", "tenant_tokens", "tenant_cost"] as const) {
      vi.setSystemTime(now);
      const limits = selfImprovementRunBudgetLimits({ profile, costCeilingUsd: profile === "edit" ? 2 : 1 });
      const initial = createRunBudgetState(limits);
      const used = { ...initial.used };
      const tenant = { tokens: { limit: 5_000_000, used: 0 }, costMicrousd: { limit: 25_000_000, used: 0 } };
      if (boundary === "tokens") used.tokens = limits.tokens - 15_000;
      if (boundary === "cost") used.costMicrousd = limits.costMicrousd - 50_000;
      if (boundary === "time") vi.setSystemTime(now + limits.wallTimeMs + 1);
      if (boundary === "tools") used.toolCalls = 48;
      if (boundary === "turns") used.modelTurns = 19;
      if (boundary === "tenant_tokens") tenant.tokens.used = tenant.tokens.limit - 15_000;
      if (boundary === "tenant_cost") tenant.costMicrousd.used = tenant.costMicrousd.limit - 50_000;
      const state = createRunBudgetState(limits, { startedAt: initial.startedAt, used }), before = structuredClone(state);
      let canUseTools = false;
      try { canUseTools = !planModelTurnBudget(state, { estimate: engineeringEstimate(profile, 18_000), toolsEnabled: true, ceiling: tenant }).finalTurn; }
      catch (error) { expect(error).toBeInstanceOf(RunBudgetExceededError); }
      expect(canUseTools, boundary).toBe(false);
      expect(state).toEqual(before);
    }
  });
});
