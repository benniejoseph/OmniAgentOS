import { afterEach, describe, expect, it } from "vitest";
import { estimateModelCostUsd, selectAgentModel } from "@/lib/openai/model-router";

describe("model router", () => {
  afterEach(() => {
    delete process.env.OPENAI_FAST_MODEL;
    delete process.env.OPENAI_REASONING_MODEL;
    delete process.env.OPENAI_MODEL_PRICING_JSON;
  });

  it("routes focused conversational work to the fast tier", () => {
    process.env.OPENAI_FAST_MODEL = "fast-model";
    process.env.OPENAI_REASONING_MODEL = "deep-model";
    expect(selectAgentModel({ message: "Summarize this note", mode: "learn" })).toMatchObject({ model: "fast-model", fallbackModel: "deep-model", tier: "fast" });
  });

  it("routes consequential work to the reasoning tier", () => {
    process.env.OPENAI_FAST_MODEL = "fast-model";
    process.env.OPENAI_REASONING_MODEL = "deep-model";
    expect(selectAgentModel({ message: "Implement and verify this production migration", mode: "execute" })).toMatchObject({ model: "deep-model", fallbackModel: "fast-model", tier: "reasoning" });
  });

  it("calculates configured token cost without hard-coded vendor pricing", () => {
    process.env.OPENAI_MODEL_PRICING_JSON = JSON.stringify({ test: { input: 2, cachedInput: 0.5, output: 8 } });
    expect(estimateModelCostUsd("test", { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 500, totalTokens: 1_500 })).toBe(0.0054);
  });
});
