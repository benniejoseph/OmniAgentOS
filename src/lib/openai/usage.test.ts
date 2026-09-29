import { describe, expect, it } from "vitest";
import { openAIResponseUsage } from "@/lib/openai/usage";

const noUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, totalTokens: 0 };

describe("OpenAI response usage", () => {
  it("reads input, cached input, output and reasoning tokens", () => {
    expect(openAIResponseUsage({
      input_tokens: 1_000,
      input_tokens_details: { cached_tokens: 400 },
      output_tokens: 300,
      output_tokens_details: { reasoning_tokens: 120 },
      total_tokens: 1_300,
    })).toEqual({
      inputTokens: 1_000,
      cachedInputTokens: 400,
      outputTokens: 300,
      totalTokens: 1_300,
      reasoningTokens: 120,
    });
  });

  it("reads a missing or malformed count as zero", () => {
    expect(openAIResponseUsage(undefined)).toEqual(noUsage);
    expect(openAIResponseUsage([{ input_tokens: 5 }])).toEqual(noUsage);
    expect(openAIResponseUsage({
      input_tokens: "12.4",
      input_tokens_details: [{ cached_tokens: 5 }],
      output_tokens: -3,
      output_tokens_details: { reasoning_tokens: 0 },
    })).toEqual({ ...noUsage, inputTokens: 12, totalTokens: 12 });
  });
});
