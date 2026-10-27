import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunBudgetState, planModelTurnBudget, reserveRunBudget, settleModelTurnBudget, type RunBudgetStateV1 } from "@/lib/runs/budgets";
import { createInspectionCompletionGate, inspectionCompletionReceiptSchema, type InspectionReadReceipt } from "./inspection-completion";
import { selfImprovementRunBudgetLimits } from "./inspection-budget";

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
  let state = createRunBudgetState({ ...selfImprovementRunBudgetLimits({ inspection: true, costCeilingUsd: 1 }), tokens });
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
  const planned = planModelTurnBudget(sixTurns(250_000), { estimate: estimate(trajectory[6].estimatedInput), toolsEnabled: true });
  expect(planned.finalTurn).toBe(false);
  return settleModelTurnBudget(planned.state, planned.reserved, { ...trajectory[6], retries: 0 });
}
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); });
afterEach(() => { vi.useRealTimers(); });

describe("bounded Atlas cumulative inspection budget", () => {
  it("retains every other phase ceiling and the ordinary100k allowance", () => {
    const ordinary = selfImprovementRunBudgetLimits({ inspection: false, costCeilingUsd: 1 });
    expect(ordinary).toEqual({ modelTurns: 20, tokens: 100_000, costMicrousd: 1_000_000, wallTimeMs: 210_000,
      toolCalls: 48, browserActions: 0, agents: 1, fanOut: 0, retries: 1, replans: 0 });
    expect(selfImprovementRunBudgetLimits({ inspection: true, costCeilingUsd: 1 })).toEqual({ ...ordinary, tokens: 250_000 });
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
    expect(state.limits).toEqual(selfImprovementRunBudgetLimits({ inspection: true, costCeilingUsd: 1 }));
  });
  it.each(["tokens", "cost", "time", "tools", "turns", "tenant_tokens", "tenant_cost"] as const)("still refuses the unread dependency at the %s boundary", async boundary => {
    let state: RunBudgetStateV1 = sevenTurns();
    const ceiling = { tokens: { limit: 1_000_000, used: 0 }, costMicrousd: { limit: 2_000_000, used: 0 } };
    if (boundary === "tokens") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, tokens: 235_000 } });
    if (boundary === "cost") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, costMicrousd: 950_000 } });
    if (boundary === "time") vi.setSystemTime(now + state.limits.wallTimeMs + 1);
    if (boundary === "tools") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, toolCalls: 48 } });
    if (boundary === "turns") state = createRunBudgetState(state.limits, { startedAt: state.startedAt, used: { ...state.used, modelTurns: 19 } });
    if (boundary === "tenant_tokens") ceiling.tokens.used = 985_000;
    if (boundary === "tenant_cost") ceiling.costMicrousd.used = 1_950_000;
    const before = structuredClone(state);
    let canCorrect = false;
    try { canCorrect = !planModelTurnBudget(state, { estimate: estimate(18_000), toolsEnabled: true, ceiling }).finalTurn; } catch { /* Ordinary exhausted-budget refusal. */ }
    expect(canCorrect).toBe(false);
    expect(state).toEqual(before);
    const { gate } = completion();
    expect(await gate.assessFinal({ text, incomplete: false, canCorrect })).toMatchObject({ receipt: {
      outcome: "rejected", reason: "completion_budget_unavailable", correctionUsed: false, missingSourcePaths: ["src/lib/studio/contracts.ts"],
    } });
    expect(gate.accepted()).toBeUndefined();
  });
});
