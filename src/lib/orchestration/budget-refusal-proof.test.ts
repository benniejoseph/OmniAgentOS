import { describe, expect, it } from "vitest";
import type { AgentEvent } from "./types";
import { budgetPreDispatchProofSchema, createBudgetRefusalProof } from "./budget-refusal-proof";

const runId = "11111111-1111-4111-8111-111111111111";
const usageReceiptId = "22222222-2222-4222-8222-222222222222";
function model(): Extract<AgentEvent, { type: "model" }> {
  const usage = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, totalTokens: 12 };
  return { type: "model", provider: "openai", model: "synthetic", tier: "reasoning", ...usage,
    latencyMs: 1, fallbackUsed: false, estimatedCostUsd: 0.001, costKnown: true,
    attemptCount: 1, failedAttemptCount: 0, usageReceiptRecorded: true, usageReceiptId,
    callReceipts: [{ provider: "openai", model: "synthetic", status: "completed", latencyMs: 1, usage, estimatedCostUsd: 0.001 }] };
}

describe("pre-dispatch budget usage proof", () => {
  it("permits zero dispatches and only balanced priced persisted turns", () => {
    const proof = createBudgetRefusalProof(runId);
    expect(proof.snapshot()).toEqual({ version: 1, runId, usageReceiptIds: [] });
    proof.reserved();
    expect(proof.snapshot()).toBeUndefined();
    proof.persisted(model());
    expect(proof.snapshot()).toEqual({ version: 1, runId, usageReceiptIds: [usageReceiptId] });
    proof.reserved();
    expect(proof.snapshot()).toBeUndefined();
  });

  it("accepts a fully priced failed attempt and fallback in one aggregate", () => {
    const proof = createBudgetRefusalProof(runId), event = model();
    const failed = { ...event.callReceipts![0], status: "failed" as const, estimatedCostUsd: 0.002 };
    event.callReceipts!.unshift(failed);
    Object.assign(event, { inputTokens: 20, outputTokens: 4, totalTokens: 24, estimatedCostUsd: 0.003,
      attemptCount: 2, failedAttemptCount: 1, fallbackUsed: true });
    proof.reserved(); proof.persisted(event);
    expect(proof.snapshot()?.usageReceiptIds).toEqual([usageReceiptId]);
  });

  it.each(["unknown_cost", "negative_cost", "missing_receipt", "missing_attempt", "unknown_attempt", "usage_mismatch", "cost_mismatch", "failed_count", "duplicate", "no_reservation"] as const)("refuses incomplete metering (%s)", mode => {
    const proof = createBudgetRefusalProof(runId), event = model();
    if (mode === "unknown_cost") event.costKnown = false;
    if (mode === "negative_cost") event.estimatedCostUsd = -1;
    if (mode === "missing_receipt") event.usageReceiptRecorded = false;
    if (mode === "missing_attempt") event.attemptCount = 2;
    if (mode === "unknown_attempt") event.callReceipts![0].estimatedCostUsd = undefined;
    if (mode === "usage_mismatch") event.callReceipts![0].usage.totalTokens = 11;
    if (mode === "cost_mismatch") event.estimatedCostUsd = 0.002;
    if (mode === "failed_count") event.failedAttemptCount = 1;
    if (mode !== "no_reservation") proof.reserved();
    proof.persisted(event);
    if (mode === "duplicate") { proof.reserved(); proof.persisted(model()); }
    expect(proof.snapshot()).toBeUndefined();
    // A later successful turn cannot erase earlier uncertain usage.
    proof.reserved(); proof.persisted({ ...model(), usageReceiptId: "33333333-3333-4333-8333-333333333333" });
    expect(proof.snapshot()).toBeUndefined();
  });

  it("bounds persisted identifiers and rejects added private fields", () => {
    expect(budgetPreDispatchProofSchema.safeParse({ version: 1, runId, usageReceiptIds: [usageReceiptId, usageReceiptId] }).success).toBe(false);
    expect(budgetPreDispatchProofSchema.safeParse({ version: 1, runId, usageReceiptIds: ["private text"] }).success).toBe(false);
    expect(budgetPreDispatchProofSchema.safeParse({ version: 1, runId, usageReceiptIds: [], privateReasoning: "not retained" }).success).toBe(false);
    expect(budgetPreDispatchProofSchema.safeParse({ version: 1, runId, usageReceiptIds: Array.from({ length: 21 }, (_, index) =>
      `${index.toString().padStart(8, "0")}-1111-4111-8111-111111111111`) }).success).toBe(false);
  });

  it.each([undefined, null, "missing", {}])("refuses malformed attempt usage without throwing (%s)", usage => {
    const proof = createBudgetRefusalProof(runId), event = model();
    event.callReceipts = [{ ...event.callReceipts![0], usage }] as unknown as typeof event.callReceipts;
    proof.reserved();
    expect(() => proof.persisted(event)).not.toThrow();
    expect(proof.snapshot()).toBeUndefined();
  });
});
