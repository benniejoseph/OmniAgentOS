import type { RunBudgetCountersV1 } from "@/lib/runs/budgets";

/** Full-context inspection turns consume cumulative input tokens repeatedly.
 * Keep this allowance inside the bound Atlas inspection, with the same paid,
 * time, tool and turn ceilings and the ordinary run/tenant budget planner.
 */
export function selfImprovementRunBudgetLimits(input: { inspection: boolean; costCeilingUsd: number }): RunBudgetCountersV1 {
  return {
    modelTurns: 20, tokens: input.inspection ? 250_000 : 100_000,
    costMicrousd: Math.floor(input.costCeilingUsd * 1_000_000),
    wallTimeMs: 210_000, toolCalls: 48, browserActions: 0, agents: 1,
    fanOut: 0, retries: 1, replans: 0,
  };
}
