import {
  AGENT_MODEL,
  ANTHROPIC_FAST_MODEL,
  ANTHROPIC_REASONING_MODEL,
  GEMINI_FAST_MODEL,
  WEB_SEARCH_MODEL,
  hasAnthropicKey,
  hasGeminiKey,
  hasOpenAIKey,
} from "@/lib/config";
import type { AgentMode } from "@/lib/orchestration/types";

export type ModelTier = "fast" | "reasoning";

export type ModelRoute = {
  model: string;
  fallbackModel?: string;
  provider: "openai" | "google" | "anthropic";
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
  modelPolicy?: "auto" | "openai_fast" | "openai_reasoning" | "gemini_fast" | "anthropic_fast" | "anthropic_reasoning";
}): ModelRoute {
  const fastModel = process.env.OPENAI_FAST_MODEL?.trim() || WEB_SEARCH_MODEL;
  const reasoningModel = process.env.OPENAI_REASONING_MODEL?.trim() || AGENT_MODEL;
  const text = input.message.trim();
  const complex = input.mode === "research" || input.mode === "execute"
    || (input.specialistCount || 0) > 1
    || text.length > 1_200
    || /\b(analy[sz]e|architect|debug|implement|research|compare|investigate|production|security|migration|multi[- ]step|verify)\b/i.test(text);

  const googleSimpleTask = hasGeminiKey()
    && !complex
    && /\b(summarize|rewrite|rephrase|classify|categorize|extract|shorten|brainstorm|outline|title|tag|translate|format)\b/i.test(text);

  if (input.modelPolicy === "gemini_fast" && hasGeminiKey()) {
    return { model: GEMINI_FAST_MODEL, fallbackModel: fastModel, provider: "google", tier: "fast", reason: "This agent is configured to prefer Gemini's fast tier with OpenAI fallback." };
  }
  if (input.modelPolicy === "anthropic_fast" && hasAnthropicKey()) {
    return { model: ANTHROPIC_FAST_MODEL, fallbackModel: hasOpenAIKey() ? fastModel : undefined, provider: "anthropic", tier: "fast", reason: "This agent is configured to prefer Claude's fast text tier." };
  }
  if (input.modelPolicy === "anthropic_reasoning" && hasAnthropicKey()) {
    return { model: ANTHROPIC_REASONING_MODEL, fallbackModel: hasOpenAIKey() ? reasoningModel : undefined, provider: "anthropic", tier: "reasoning", reason: "This agent is configured to prefer Claude's reasoning tier." };
  }
  if (input.modelPolicy === "openai_reasoning" && hasOpenAIKey()) {
    return { model: reasoningModel, fallbackModel: fastModel === reasoningModel ? undefined : fastModel, provider: "openai", tier: "reasoning", reason: "This agent is configured to prefer the deeper OpenAI reasoning tier." };
  }
  if (input.modelPolicy === "openai_fast" && hasOpenAIKey()) {
    return { model: fastModel, fallbackModel: reasoningModel === fastModel ? undefined : reasoningModel, provider: "openai", tier: "fast", reason: "This agent is configured to prefer the low-latency OpenAI tier." };
  }

  if (googleSimpleTask) {
    return {
      model: GEMINI_FAST_MODEL,
      fallbackModel: fastModel,
      provider: "google",
      tier: "fast",
      reason: "A bounded language task can use the cost-efficient Gemini tier with OpenAI fallback.",
    };
  }

  if (!hasOpenAIKey() && hasAnthropicKey()) {
    return {
      model: complex ? ANTHROPIC_REASONING_MODEL : ANTHROPIC_FAST_MODEL,
      fallbackModel: hasGeminiKey() ? GEMINI_FAST_MODEL : undefined,
      provider: "anthropic",
      tier: complex ? "reasoning" : "fast",
      reason: "Claude is the strongest configured provider for this request.",
    };
  }

  if (!hasOpenAIKey() && hasGeminiKey()) {
    return {
      model: GEMINI_FAST_MODEL,
      provider: "google",
      tier: complex ? "reasoning" : "fast",
      reason: "Gemini is the configured provider available for this request.",
    };
  }

  return complex
    ? {
        model: reasoningModel,
        fallbackModel: fastModel === reasoningModel ? undefined : fastModel,
        provider: "openai",
        tier: "reasoning",
        reason: "Complexity, risk, or specialist coordination benefits from deeper reasoning.",
      }
    : {
        model: fastModel,
        fallbackModel: reasoningModel === fastModel ? undefined : reasoningModel,
        provider: "openai",
        tier: "fast",
        reason: "A focused request can use the lower-latency model tier.",
      };
}

export function estimateModelCostUsd(model: string, usage: ModelUsage) {
  const pricing = parsePricing();
  const rate = pricing[model];
  if (!rate) return undefined;
  return estimateTokenCostUsd(rate, usage);
}

export function estimateWebSearchCostUsd(
  model: string,
  usage: ModelUsage,
  searchQueryCount: number,
) {
  const rate = parsePricing()[model];
  if (!rate || rate.webSearch === undefined) return undefined;
  return roundUsd(
    estimateTokenCostUsd(rate, usage) +
    Math.max(0, Math.round(searchQueryCount)) * rate.webSearch,
  );
}

function estimateTokenCostUsd(
  rate: { input: number; output: number; cachedInput?: number },
  usage: ModelUsage,
) {
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
  return roundUsd(
    (uncachedInput * rate.input + usage.cachedInputTokens * (rate.cachedInput ?? rate.input) + usage.outputTokens * rate.output) / 1_000_000,
  );
}

function parsePricing(): Record<string, { input: number; output: number; cachedInput?: number; webSearch?: number }> {
  try {
    const value = JSON.parse(process.env.OPENAI_MODEL_PRICING_JSON || "{}") as Record<string, unknown>;
    return Object.fromEntries(Object.entries(value).flatMap(([model, raw]) => {
      if (!raw || typeof raw !== "object") return [];
      const candidate = raw as Record<string, unknown>;
      const input = Number(candidate.input);
      const output = Number(candidate.output);
      const cachedInput = Number(candidate.cachedInput);
      const webSearch = Number(candidate.webSearch);
      if (!Number.isFinite(input) || input < 0 || !Number.isFinite(output) || output < 0) return [];
      return [[model, {
        input,
        output,
        ...(Number.isFinite(cachedInput) && cachedInput >= 0 ? { cachedInput } : {}),
        ...(Number.isFinite(webSearch) && webSearch >= 0 ? { webSearch } : {}),
      }]];
    }));
  } catch {
    return {};
  }
}

function roundUsd(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
