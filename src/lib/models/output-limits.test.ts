import { describe, expect, it } from "vitest";
import { anthropicMaxOutputTokens, bedrockMaxTokens, geminiMaxOutputTokens, modelOutputConfiguration } from "./output-limits";
import { openAIMaxOutputTokens } from "./reasoning-effort";

describe("provider output reservation", () => {
  it.each([
    ["openai", "gpt-5", "medium", 4_000, 12_000],
    ["openai", "gpt-5", "high", 4_000, 20_000],
    ["openai", "gpt-5", "medium", 8_000, 16_000],
    ["openai", "gpt-5", "low", 4_000, 8_000],
    ["openai", "gpt-4o-mini", undefined, 4_000, 4_000],
    ["anthropic", "claude-opus-5-5", "high", 8_000, 21_333],
    ["anthropic", "claude-opus-4-6", "high", 4_000, 4_000],
    ["anthropic", "claude-unknown", undefined, 4_000, 4_000],
    ["google", "gemini-test", undefined, 4_000, 20_000],
    ["aws_bedrock", "us.anthropic.claude-opus-5-5", undefined, 8_000, 21_333],
    ["aws_bedrock", "unknown-profile", undefined, 4_000, 4_000],
  ] as const)("reserves the actual %s/%s output with supported effort %s", (provider, model, effort, answerTokens, expected) => {
    const result = modelOutputConfiguration({ provider, model, answerTokens, reasoningEffort: effort ?? "high" });
    expect(result).toEqual({ reasoningEffort: effort, providerOutputLimit: expected });
    const wireMaximum = provider === "openai" ? openAIMaxOutputTokens(answerTokens, result.reasoningEffort)
      : provider === "anthropic" ? anthropicMaxOutputTokens(model, answerTokens, result.reasoningEffort)
      : provider === "google" ? geminiMaxOutputTokens(answerTokens) : bedrockMaxTokens(model, answerTokens);
    expect(result.providerOutputLimit).toBe(wireMaximum);
  });
});
