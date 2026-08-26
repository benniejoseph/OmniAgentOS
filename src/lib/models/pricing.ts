import type { ModelUsage } from "@/lib/openai/model-router";
import type { ProviderId } from "@/lib/models/types";

export function estimateProviderCost(
  provider: ProviderId,
  model: string,
  usage: ModelUsage,
) {
  const pricing = providerPricing(provider)[model];
  if (!pricing) return { costKnown: false as const, estimatedCostUsd: undefined };
  const uncached = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  const cost = (
    uncached * pricing.input +
    usage.cachedInputTokens * (pricing.cachedInput ?? pricing.input) +
    usage.outputTokens * pricing.output
  ) / 1_000_000;
  return {
    costKnown: true as const,
    estimatedCostUsd: Math.round(cost * 1_000_000) / 1_000_000,
  };
}

function providerPricing(provider: ProviderId) {
  const raw = provider === "openai"
    ? process.env.OPENAI_MODEL_PRICING_JSON
    : provider === "google"
      ? process.env.GEMINI_MODEL_PRICING_JSON
      : provider === "anthropic"
        ? process.env.ANTHROPIC_MODEL_PRICING_JSON
        : process.env.LOCAL_MODEL_PRICING_JSON;
  try {
    const parsed = JSON.parse(raw || "{}") as Record<string, Record<string, unknown>>;
    return Object.fromEntries(Object.entries(parsed).flatMap(([model, value]) => {
      const input = Number(value.input);
      const output = Number(value.output);
      const cachedInput = Number(value.cachedInput);
      if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return [];
      return [[model, {
        input,
        output,
        ...(Number.isFinite(cachedInput) && cachedInput >= 0 ? { cachedInput } : {}),
      }]];
    }));
  } catch {
    return {};
  }
}
