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

  it("applies the long-context rate to the whole request only above the input boundary", () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      tiered: {
        input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50, webSearch: 0.01,
        longContext: { threshold: 272_000, input: 20, cachedInput: 2, cacheWrite: 25, output: 75 },
      },
    }));
    const boundary = {
      inputTokens: 272_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 20_000,
      outputTokens: 50_000, totalTokens: 322_000,
    };
    // Output length does not select the tier; cached and cache-write input does.
    expect(estimateModelCostUsd("openai", "tiered", boundary)).toBe(4.37);
    const above = { ...boundary, inputTokens: 272_001, totalTokens: 322_001 };
    expect(estimateModelCostUsd("openai", "tiered", above)).toBe(7.49002);
    expect(estimateWebSearchCostUsd("tiered", above, 3)).toBe(7.52002);
  });

  it("binds the entire tier and boundary into dated-snapshot price provenance", () => {
    const price = {
      input: 10, output: 50,
      longContext: { threshold: 272_000, input: 20, output: 75 },
    };
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({ tiered: price }));
    expect(resolveModelPrice("openai", "tiered-2026-09-03")?.price).toEqual(price);
    const initial = modelPricingProvenance("openai", "tiered");
    expect(modelPricingProvenance("openai", "tiered-2026-09-03")).toEqual(initial);
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      tiered: { ...price, longContext: { ...price.longContext, output: 80 } },
    }));
    expect(modelPricingProvenance("openai", "tiered")).not.toEqual(initial);
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      tiered: { ...price, longContext: { ...price.longContext, threshold: 200_000 } },
    }));
    expect(modelPricingProvenance("openai", "tiered")).not.toEqual(initial);
  });

  it.each([
    null,
    { threshold: 272_000, input: 20 },
    { threshold: 272_000, input: -20, output: 75 },
    { threshold: 0, input: 20, output: 75 },
    { threshold: 272_000.5, input: 20, output: 75 },
    { threshold: "272000", input: 20, output: 75 },
    { threshold: 272_000, input: 20, output: 75, cachedInput: -1 },
    { threshold: 272_000, input: 20, output: 75, cacheWrite: "bad" },
    { threshold: 272_000, input: 20, output: 75, cacheWrite: null },
  ])("refuses malformed long-context rates rather than charging the short rate: %j", (longContext) => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      tiered: { input: 10, output: 50, longContext },
    }));
    expect(resolveModelPrice("openai", "tiered")).toBeUndefined();
    expect(estimateModelCostUsd("openai", "tiered", cachedUsage)).toBeUndefined();
  });

  it("does not replace an invalid exact snapshot price with its valid base price", () => {
    vi.stubEnv("OPENAI_MODEL_PRICING_JSON", JSON.stringify({
      tiered: { input: 10, output: 50 },
      "tiered-2026-09-03": {
        input: 10, output: 50, longContext: { threshold: 272_000, input: 20 },
      },
    }));
    expect(resolveModelPrice("openai", "tiered-2026-09-03")).toBeUndefined();
    expect(resolveModelPrice("openai", "tiered-2026-09-04")?.price).toEqual({ input: 10, output: 50 });
  });
});
