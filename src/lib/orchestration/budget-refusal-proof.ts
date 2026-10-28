import { z } from "zod";
import type { AgentEvent } from "./types";

export const budgetPreDispatchProofSchema = z.object({
  version: z.literal(1),
  runId: z.string().uuid(),
  usageReceiptIds: z.array(z.string().uuid()).max(20),
}).strict().refine(value => new Set(value.usageReceiptIds).size === value.usageReceiptIds.length);

export type BudgetPreDispatchProof = z.infer<typeof budgetPreDispatchProofSchema>;
type ModelEvent = Extract<AgentEvent, { type: "model" }>;
const nonnegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value: unknown): value is number => nonnegative(value) && Number.isSafeInteger(value);

/** Every dispatched attempt must be represented by priced, persisted usage. */
function fullyAccounted(event: ModelEvent) {
  const calls = event.callReceipts;
  if (event.usageReceiptRecorded !== true || !z.string().uuid().safeParse(event.usageReceiptId).success ||
      event.costKnown !== true || !nonnegative(event.estimatedCostUsd) ||
      !count(event.attemptCount) || event.attemptCount < 1 || event.attemptCount > 2 ||
      !count(event.failedAttemptCount) || !Array.isArray(calls) || calls.length !== event.attemptCount ||
      calls.some(call => !call || typeof call !== "object" || !call.usage || typeof call.usage !== "object" ||
        !["completed", "failed"].includes(call.status) || !nonnegative(call.estimatedCostUsd) ||
        !count(call.usage.inputTokens) || !count(call.usage.outputTokens) || !count(call.usage.totalTokens))) return false;
  if (calls.filter(call => call.status === "failed").length !== event.failedAttemptCount) return false;
  for (const key of ["inputTokens", "outputTokens", "totalTokens"] as const) {
    if (!count(event[key]) || calls.reduce((sum, call) => sum + call.usage[key]!, 0) !== event[key]) return false;
  }
  const cost = calls.reduce((sum, call) => sum + Math.round(call.estimatedCostUsd! * 1_000_000), 0);
  return Number.isSafeInteger(cost) && Math.abs(cost - Math.round(event.estimatedCostUsd * 1_000_000)) <= calls.length;
}

/** Bound runs only. A reservation without a persisted model event poisons proof. */
export function createBudgetRefusalProof(runId: string) {
  let reservations = 0, models = 0, accounted = true;
  const usageReceiptIds: string[] = [];
  return {
    reserved() { reservations++; },
    persisted(event: ModelEvent) {
      models++;
      if (models > reservations || !fullyAccounted(event) || usageReceiptIds.includes(event.usageReceiptId!)) accounted = false;
      else usageReceiptIds.push(event.usageReceiptId!);
    },
    snapshot(): BudgetPreDispatchProof | undefined {
      if (!accounted || reservations !== models || models !== usageReceiptIds.length) return undefined;
      const parsed = budgetPreDispatchProofSchema.safeParse({ version: 1, runId, usageReceiptIds });
      return parsed.success ? parsed.data : undefined;
    },
  };
}
