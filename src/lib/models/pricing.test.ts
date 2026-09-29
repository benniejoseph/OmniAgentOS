import { afterEach, describe, expect, it, vi } from "vitest";
import {
  estimateModelCostUsd,
  estimateProviderCost,
  estimateWebSearchCostUsd,
  modelPricingProvenance,
  resolveModelPrice,
} from "@/lib/models/pricing";

// 1,000 input tokens: 500 uncached, 300 read from the prompt cache and 200
// written to it. Then 100 output tokens.
const cachedUsage = {
  inputTokens: 1_000,
  cachedInputTokens: 300,
  cacheWriteInputTokens: 200,
  outputTokens: 100,
  totalTokens: 1_100,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("model pricing", () => {
  it("prices uncached input, cached input and output at their configured rates", () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      test: { input: 2, cachedInput: 0.5, output: 8 },
    }));
    vi.stubEnv("GEMINI_MODEL_PRICING_JSON", JSON.stringify({
      gemini: { input: 0.3, cachedInput: 0.03, output: 2.5 },
    }));

    expect(estimateModelCostUsd("openai", "test", {
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 500,
      totalTokens: 1_500,
    })).toBe(0.0054);
    expect(estimateModelCostUsd("google", "gemini", {
      inputTokens: 1_000,
      cachedInputTokens: 200,
      outputTokens: 500,
      totalTokens: 1_500,
    })).toBe(0.001496);
    // A cost is kept to whole millionths of a dollar: 3 × 0.3 is 0.9 of one.
    expect(estimateModelCostUsd("google", "gemini", {
      inputTokens: 3,
      cachedInputTokens: 0,
      outputTokens: 0,
      totalTokens: 3,
    })).toBe(0.000001);
    expect(estimateModelCostUsd("google", "unknown", {
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
    })).toBeUndefined();
  });

  it("prices cached input at the input rate when no cached rate is configured", () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      test: { input: 2, output: 8 },
    }));

    expect(estimateModelCostUsd("openai", "test", {
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 500,
      totalTokens: 1_500,
    })).toBe(0.006);
  });

  it("prices a Claude prompt-cache write at 1.25 times input unless a write rate is set", () => {
    const claudePrice = { input: 3, cachedInput: 0.3, output: 15 };
    vi.stubEnv("ANTHROPIC_MODEL_PRICING_JSON", JSON.stringify({
      "claude-sonnet-5": claudePrice,
      "claude-priced-write": { ...claudePrice, cacheWrite: 6 },
    }));
    vi.stubEnv("BEDROCK_MODEL_PRICING_JSON", JSON.stringify({
      "us.anthropic.claude-sonnet-5-v1:0": claudePrice,
      "amazon.nova-pro-v1:0": claudePrice,
    }));

    // 500 × 3 + 300 × 0.3 + 200 × 3.75 + 100 × 15 = 3,840 per million.
    expect(estimateModelCostUsd("anthropic", "claude-sonnet-5", cachedUsage)).toBe(0.00384);
    expect(estimateModelCostUsd("aws_bedrock", "us.anthropic.claude-sonnet-5-v1:0", cachedUsage))
      .toBe(0.00384);
    // 200 × 6 replaces 200 × 3.75.
    expect(estimateModelCostUsd("anthropic", "claude-priced-write", cachedUsage)).toBe(0.00429);
    // Nova bills a cache write as input: 200 × 3.
    expect(estimateModelCostUsd("aws_bedrock", "amazon.nova-pro-v1:0", cachedUsage)).toBe(0.00369);
  });

  it("prices a dated snapshot as the model it snapshots unless the snapshot is listed", () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      "gpt-5": { input: 1, output: 4 },
      "gpt-4o": { input: 1, output: 4 },
      "gpt-4o-2024-05-13": { input: 5, output: 15 },
    }));
    vi.stubEnv("ANTHROPIC_MODEL_PRICING_JSON", JSON.stringify({
      "claude-sonnet-4-5": { input: 3, output: 15 },
    }));

    expect(resolveModelPrice("openai", "gpt-5-2025-08-07")).toEqual({
      model: "gpt-5",
      price: { input: 1, output: 4 },
    });
    expect(resolveModelPrice("anthropic", "claude-sonnet-4-5-20250929")).toEqual({
      model: "claude-sonnet-4-5",
      price: { input: 3, output: 15 },
    });
    expect(resolveModelPrice("openai", "gpt-4o-2024-05-13")).toEqual({
      model: "gpt-4o-2024-05-13",
      price: { input: 5, output: 15 },
    });
    // Only a dated suffix names a snapshot.
    expect(resolveModelPrice("openai", "gpt-5-mini")).toBeUndefined();
    expect(resolveModelPrice("openai", "gpt-5-12345678")).toBeUndefined();
    expect(resolveModelPrice("anthropic", "gpt-5-2025-08-07")).toBeUndefined();
  });

  it("adds each web search query's fee to an OpenAI search call's tokens", () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      search: { input: 2, output: 8, webSearch: 0.01 },
      "no-search-fee": { input: 2, output: 8 },
    }));
    const usage = { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 500, totalTokens: 1_500 };

    expect(estimateWebSearchCostUsd("search", usage, 3)).toBe(0.036);
    expect(estimateWebSearchCostUsd("search", usage, -2)).toBe(0.006);
    expect(estimateWebSearchCostUsd("no-search-fee", usage, 1)).toBeUndefined();
  });

  it("ignores an invalid price without losing the valid ones", () => {
    vi.stubEnv("LOCAL_MODEL_PRICING_JSON", JSON.stringify({
      negative: { input: -1, output: 2 },
      missing: null,
      blank: { input: " ", output: 1 },
      textual: { input: "2", output: "8", cachedInput: null },
    }));
    const usage = { inputTokens: 1_000, cachedInputTokens: 400, outputTokens: 500, totalTokens: 1_500 };

    expect(estimateModelCostUsd("local", "negative", usage)).toBeUndefined();
    expect(estimateModelCostUsd("local", "missing", usage)).toBeUndefined();
    expect(estimateModelCostUsd("local", "blank", usage)).toBeUndefined();
    expect(resolveModelPrice("local", "textual")?.price).toEqual({ input: 2, output: 8 });

    vi.stubEnv("LOCAL_MODEL_PRICING_JSON", "{not json");
    expect(estimateModelCostUsd("local", "textual", usage)).toBeUndefined();
    vi.stubEnv("LOCAL_MODEL_PRICING_JSON", JSON.stringify([{ input: 1, output: 1 }]));
    expect(estimateModelCostUsd("local", "0", usage)).toBeUndefined();
  });

  it("reports whether a provider call's cost is known", () => {
    vi.stubEnv("ANTHROPIC_MODEL_PRICING_JSON", JSON.stringify({
      "claude-sonnet-5": { input: 3, cachedInput: 0.3, output: 15 },
    }));

    expect(estimateProviderCost("anthropic", "claude-sonnet-5", cachedUsage)).toEqual({
      costKnown: true,
      estimatedCostUsd: 0.00384,
    });
    expect(estimateProviderCost("anthropic", "claude-unpriced", cachedUsage)).toEqual({
      costKnown: false,
      estimatedCostUsd: undefined,
    });
  });

  it("identifies the configured price a cost came from", () => {
    const price = JSON.stringify({ "gpt-5": { input: 1, output: 4 } });
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", price);
    vi.stubEnv("GEMINI_MODEL_PRICING_JSON", price);
    const base = modelPricingProvenance("openai", "gpt-5");

    expect(base).toEqual({
      pricingSource: "environment",
      pricingVersion: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(modelPricingProvenance("openai", "gpt-5-2025-08-07")).toEqual(base);
    expect(modelPricingProvenance("google", "gpt-5")).not.toEqual(base);

    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({ "gpt-5": { input: 1.25, output: 4 } }));
    expect(modelPricingProvenance("openai", "gpt-5")).not.toEqual(base);
  });
});
