import { AGENT_MODEL, WEB_SEARCH_MODEL } from "@/lib/config";
import type { AgentMode } from "@/lib/orchestration/types";

export type ModelTier = "fast" | "reasoning";

export type ModelRoute = {
  model: string;
  fallbackModel?: string;
  tier: ModelTier;
  reason: string;
};

export type ModelUsage = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
};

export function selectAgentModel(input: {
  message: string;
  mode?: AgentMode;
  specialistCount?: number;
}): ModelRoute {
  const fastModel = process.env.OPENAI_FAST_MODEL?.trim() || WEB_SEARCH_MODEL;
  const reasoningModel = process.env.OPENAI_REASONING_MODEL?.trim() || AGENT_MODEL;
  const text = input.message.trim();
  const complex = input.mode === "research" || input.mode === "execute"
    || (input.specialistCount || 0) > 1
    || text.length > 1_200
    || /\b(analy[sz]e|architect|debug|implement|research|compare|investigate|production|security|migration|multi[- ]step|verify)\b/i.test(text);

  return complex
    ? {
        model: reasoningModel,
        fallbackModel: fastModel === reasoningModel ? undefined : fastModel,
        tier: "reasoning",
        reason: "Complexity, risk, or specialist coordination benefits from deeper reasoning.",
      }
    : {
        model: fastModel,
        fallbackModel: reasoningModel === fastModel ? undefined : reasoningModel,
        tier: "fast",
        reason: "A focused request can use the lower-latency model tier.",
      };
}

export function estimateModelCostUsd(model: string, usage: ModelUsage) {
  const pricing = parsePricing();
  const rate = pricing[model];
  if (!rate) return undefined;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return roundUsd(
    (uncachedInput * rate.input + usage.cachedInputTokens * (rate.cachedInput ?? rate.input) + usage.outputTokens * rate.output) / 1_000_000,
  );
}

function parsePricing(): Record<string, { input: number; output: number; cachedInput?: number }> {
  try {
    const value = JSON.parse(process.env.OPENAI_MODEL_PRICING_JSON || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).flatMap(([model, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      const candidate = raw as Record<string, unknown>;
      const input = Number(candidate.input);
      const output = Number(candidate.output);
      const cachedInput = Number(candidate.cachedInput);
      if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return [];
      return [[model, { input, output, ...(Number.isFinite(cachedInput) && cachedInput >= 0 ? { cachedInput } : {}) }]];
    }));
  } catch {
    return {};
  }
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
