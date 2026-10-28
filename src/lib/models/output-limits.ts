import { claudeMaxTokens, claudeModelInBedrockId } from "./anthropic-capabilities";
import { openAIMaxOutputTokens, resolveModelReasoningEffort } from "./reasoning-effort";
import type { ModelReasoningEffort } from "./types";
import type { SettingsModelProvider } from "@/lib/settings/types";

// These are the provider request limits, shared with admission accounting.
// Answer tokens and provider output (which can include thinking) are distinct.
export function geminiMaxOutputTokens(answerTokens: number | undefined) {
  return Math.min(Math.max(answerTokens || 2_000, 64), 8_000) + 16_000;
}

export function bedrockMaxTokens(modelId: string, requested: number | undefined) {
  const parsed = Number(requested);
  const answerTokens = Number.isFinite(parsed)
    ? Math.min(Math.max(Math.round(parsed), 1), 16_000) : 2_000;
  const claude = claudeModelInBedrockId(modelId);
  return claude ? claudeMaxTokens(claude, answerTokens) : answerTokens;
}

export function anthropicMaxOutputTokens(model: string, requested: number | undefined, effort?: ModelReasoningEffort) {
  return claudeMaxTokens(model, Math.min(Math.max(requested || 2_000, 64), 16_000), effort);
}

/** Resolve only supported effort and the exact tool-turn output allowance. */
export function modelOutputConfiguration(input: {
  provider: Exclude<SettingsModelProvider, "typesafe">;
  model: string;
  answerTokens: number;
  reasoningEffort?: ModelReasoningEffort;
}) {
  const reasoningEffort = resolveModelReasoningEffort(input.provider, input.model, input.reasoningEffort);
  const providerOutputLimit = input.provider === "openai"
    ? openAIMaxOutputTokens(input.answerTokens, reasoningEffort)
    : input.provider === "anthropic"
      ? anthropicMaxOutputTokens(input.model, input.answerTokens, reasoningEffort)
      : input.provider === "google"
        ? geminiMaxOutputTokens(input.answerTokens)
        : bedrockMaxTokens(input.model, input.answerTokens);
  return { reasoningEffort, providerOutputLimit };
}
