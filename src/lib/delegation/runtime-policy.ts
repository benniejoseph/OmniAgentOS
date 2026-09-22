import {
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";

/**
 * A dynamic child receives a deliberately small, non-redelegating budget.
 * The parent reserves the complete slice before the governed delegation tool
 * is allowed to dispatch, so a crash cannot silently create free authority.
 */
export const DYNAMIC_DELEGATION_CHILD_BUDGET = Object.freeze(
  runBudgetCountersV1Schema.parse({
    modelTurns: 2,
    tokens: 12_000,
    costMicrousd: 400_000,
    wallTimeMs: 90_000,
    toolCalls: 8,
    browserActions: 0,
    agents: 1,
    fanOut: 0,
    retries: 0,
    replans: 0,
  }),
);

export const DYNAMIC_DELEGATION_READ_TOOL_IDS = Object.freeze([
  "memory.search",
  "knowledge.search",
  "web.search",
  "runs.list",
] as const);

export function dynamicDelegationRootReservation(
  child: RunBudgetCountersV1 = DYNAMIC_DELEGATION_CHILD_BUDGET,
) {
  const parsed = runBudgetCountersV1Schema.parse(child);
  return runBudgetCountersV1Schema.parse({
    ...parsed,
    agents: 1,
    fanOut: 1,
  });
}
