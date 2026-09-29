import type { ModelUsage } from "@/lib/models/types";

/** The token usage an OpenAI Responses API reply reports, read defensively. */
export function openAIResponseUsage(value: unknown): ModelUsage {
  const raw = recordValue(value);
  const inputTokens = tokenCount(raw?.input_tokens);
  const outputTokens = tokenCount(raw?.output_tokens);
  const reasoningTokens = tokenCount(recordValue(raw?.output_tokens_details)?.reasoning_tokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens: tokenCount(recordValue(raw?.input_tokens_details)?.cached_tokens),
    totalTokens: tokenCount(raw?.total_tokens) || inputTokens + outputTokens,
    ...(reasoningTokens ? { reasoningTokens } : {}),
  };
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function tokenCount(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}
