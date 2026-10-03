import { RUN_BUDGET_DIMENSIONS, runBudgetCountersV1Schema, type RunBudgetCountersV1 } from "@/lib/runs/budgets";
import { cumulativeBudgetSchema, type CumulativeBudget } from "./runtime-contracts";
import { ResponsibilityError, storageInvalid } from "./state";

export const zeroResponsibilityBudget = (): RunBudgetCountersV1 => ({ modelTurns: 0, tokens: 0, costMicrousd: 0, wallTimeMs: 0, toolCalls: 0, browserActions: 0, agents: 0, fanOut: 0, retries: 0, replans: 0 });
export const PILOT_CHECK_RESERVATION = Object.freeze({ ...zeroResponsibilityBudget(), toolCalls: 1, agents: 1, wallTimeMs: 30_000 });

export function verifyCumulativeBudget(value: unknown): CumulativeBudget {
  const budget = cumulativeBudgetSchema.parse(value);
  if (budget.usedChecks + budget.reservedChecks > budget.maximumChecks || RUN_BUDGET_DIMENSIONS.some((dimension) => budget.used[dimension] + budget.reserved[dimension] > budget.limits[dimension])) throw storageInvalid();
  return budget;
}
export function reserveResponsibilityBudget(value: CumulativeBudget, input: RunBudgetCountersV1): CumulativeBudget {
  const budget = verifyCumulativeBudget(value); const reservation = runBudgetCountersV1Schema.parse(input);
  if (budget.usedChecks + budget.reservedChecks >= budget.maximumChecks || RUN_BUDGET_DIMENSIONS.some((dimension) => reservation[dimension] > budget.limits[dimension] - budget.used[dimension] - budget.reserved[dimension])) {
    throw new ResponsibilityError("The reviewed cumulative responsibility limit is exhausted.", 409, "responsibility_budget_exhausted");
  }
  return verifyCumulativeBudget({ ...budget, reserved: add(budget.reserved, reservation), reservedChecks: budget.reservedChecks + 1 });
}

/** Unknown started work keeps its complete reservation. Only an exact durable
 * terminal receipt or proof that dispatch never started releases capacity. */
export function settleResponsibilityBudget(value: CumulativeBudget, reservation: RunBudgetCountersV1, disposition:
  | { kind: "unstarted" }
  | { kind: "terminal"; charged: RunBudgetCountersV1 }
  | { kind: "uncertain_started" }): CumulativeBudget {
  const budget = verifyCumulativeBudget(value); runBudgetCountersV1Schema.parse(reservation);
  if (budget.reservedChecks < 1 || RUN_BUDGET_DIMENSIONS.some((dimension) => budget.reserved[dimension] < reservation[dimension])) throw storageInvalid();
  if (disposition.kind === "uncertain_started") return budget;
  const charged = disposition.kind === "terminal" ? runBudgetCountersV1Schema.parse(disposition.charged) : zeroResponsibilityBudget();
  if (RUN_BUDGET_DIMENSIONS.some((dimension) => charged[dimension] > reservation[dimension])) throw new ResponsibilityError("The terminal usage exceeds its reserved bound.", 409, "responsibility_usage_unconfirmed");
  return verifyCumulativeBudget({ ...budget, used: add(budget.used, charged), reserved: subtract(budget.reserved, reservation),
    usedChecks: budget.usedChecks + (disposition.kind === "terminal" ? 1 : 0), reservedChecks: budget.reservedChecks - 1 });
}
function add(a: RunBudgetCountersV1, b: RunBudgetCountersV1) { return Object.fromEntries(RUN_BUDGET_DIMENSIONS.map((dimension) => [dimension, a[dimension] + b[dimension]])) as RunBudgetCountersV1; }
function subtract(a: RunBudgetCountersV1, b: RunBudgetCountersV1) { return Object.fromEntries(RUN_BUDGET_DIMENSIONS.map((dimension) => [dimension, a[dimension] - b[dimension]])) as RunBudgetCountersV1; }
