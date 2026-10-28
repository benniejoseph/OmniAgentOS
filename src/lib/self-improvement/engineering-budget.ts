import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";

export type SelfImprovementBudgetProfile = "ordinary" | "inspect" | "edit" | "review";

/** Full-context engineering turns repeatedly consume earlier reads and outputs.
 * These finite cumulative ceilings cover the bounded read/write lifecycle;
 * they do not grant more turns, tool rounds, time, dollars or tenant allowance.
 * The adapter selects a profile only inside its existing scoped phase contract.
 */
export function selfImprovementRunBudgetLimits(input: { profile: SelfImprovementBudgetProfile; costCeilingUsd: number; maxEngineeringTokensPerRun?: number }): RunBudgetCountersV1 {
  const profileTokens = input.profile === "ordinary" ? 100_000 : input.profile === "edit" ? 1_000_000 : 500_000;
  const cap = input.maxEngineeringTokensPerRun;
  if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 1 || cap > 1_000_000)) throw new Error("The admitted engineering token cap is invalid.");
  const tokens = Math.min(profileTokens, cap ?? profileTokens);
  return {
    modelTurns: 20, tokens,
    costMicrousd: Math.floor(input.costCeilingUsd * 1_000_000),
    wallTimeMs: 210_000, toolCalls: 48, browserActions: 0, agents: 1,
    fanOut: 0, retries: 1, replans: 0,
  };
}
