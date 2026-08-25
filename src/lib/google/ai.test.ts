import { afterEach, describe, expect, it, vi } from "vitest";
import { estimateGeminiCostUsd, generateGeminiText } from "@/lib/google/ai";

describe("Google AI provider", () => {
  afterEach(() => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_MODEL_PRICING_JSON;
    vi.unstubAllGlobals();
  });

  it("normalizes Interactions API text and usage", async () => {
    process.env.GEMINI_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: "interaction-1",
      model: "gemini-test",
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "Concise result" }] }],
      usage: { total_input_tokens: 10, total_output_tokens: 4, total_cached_tokens: 2, total_tokens: 14 },
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(generateGeminiText({ prompt: "Summarize this" })).resolves.toMatchObject({
      text: "Concise result",
      model: "gemini-test",
      responseId: "interaction-1",
      usage: { inputTokens: 10, outputTokens: 4, cachedInputTokens: 2, totalTokens: 14 },
    });
  });

  it("calculates only explicitly configured Gemini pricing", () => {
    process.env.GEMINI_MODEL_PRICING_JSON = JSON.stringify({ gemini: { input: 0.3, cachedInput: 0.03, output: 2.5 } });
    expect(estimateGeminiCostUsd("gemini", { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 500, totalTokens: 1_500 })).toBe(0.001496);
    expect(estimateGeminiCostUsd("unknown", { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1, totalTokens: 2 })).toBeUndefined();
  });
});
