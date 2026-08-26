import { afterEach, describe, expect, it } from "vitest";
import { estimateModelCostUsd, selectAgentModel } from "@/lib/openai/model-router";

describe("model router", () => {
  afterEach(() => {
    delete process.env.OPENAI_FAST_MODEL;
    delete process.env.OPENAI_REASONING_MODEL;
    delete process.env.OPENAI_MODEL_PRICING_JSON;
    delete process.env.OPENAI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("routes focused conversational work to the fast tier", () => {
    process.env.OPENAI_FAST_MODEL = "fast-model";
    process.env.OPENAI_REASONING_MODEL = "deep-model";
    expect(selectAgentModel({ message: "Summarize this note", mode: "learn" })).toMatchObject({ model: "fast-model", fallbackModel: "deep-model", provider: "openai", tier: "fast" });
  });

  it("routes bounded language transforms to Gemini with an OpenAI fallback", () => {
    process.env.GEMINI_API_KEY = "configured";
    process.env.OPENAI_FAST_MODEL = "fast-model";
    expect(selectAgentModel({ message: "Summarize this note", mode: "learn" })).toMatchObject({ provider: "google", fallbackModel: "fast-model", tier: "fast" });
  });

  it("routes consequential work to the reasoning tier", () => {
    process.env.OPENAI_FAST_MODEL = "fast-model";
    process.env.OPENAI_REASONING_MODEL = "deep-model";
    expect(selectAgentModel({ message: "Implement and verify this production migration", mode: "execute" })).toMatchObject({ model: "deep-model", fallbackModel: "fast-model", tier: "reasoning" });
  });

  it("honors an owner-configured model policy with a safe fallback", () => {
    process.env.OPENAI_API_KEY = "configured";
    process.env.OPENAI_FAST_MODEL = "fast-model";
    process.env.OPENAI_REASONING_MODEL = "deep-model";
    expect(selectAgentModel({ message: "Do a quick check", mode: "learn", modelPolicy: "openai_reasoning" })).toMatchObject({
      model: "deep-model",
      fallbackModel: "fast-model",
      provider: "openai",
      tier: "reasoning",
    });
  });

  it("falls back to OpenAI when a Gemini policy is selected without Gemini credentials", () => {
    process.env.OPENAI_FAST_MODEL = "fast-model";
    expect(selectAgentModel({ message: "Summarize this", mode: "learn", modelPolicy: "gemini_fast" })).toMatchObject({
      model: "fast-model",
      provider: "openai",
      tier: "fast",
    });
  });

  it("honors a Claude policy when Anthropic is configured", () => {
    process.env.ANTHROPIC_API_KEY = "configured";
    expect(selectAgentModel({ message: "Review this architecture", mode: "research", modelPolicy: "anthropic_reasoning" })).toMatchObject({
      provider: "anthropic",
      tier: "reasoning",
    });
  });

  it("calculates configured token cost without hard-coded vendor pricing", () => {
    process.env.OPENAI_MODEL_PRICING_JSON = JSON.stringify({ test: { input: 2, cachedInput: 0.5, output: 8 } });
    expect(estimateModelCostUsd("test", { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 500, totalTokens: 1_500 })).toBe(0.0054);
  });
});
