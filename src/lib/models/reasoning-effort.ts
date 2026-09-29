import { anthropicModelCapabilities } from "@/lib/models/anthropic-capabilities";
import type { ModelReasoningEffort } from "@/lib/models/types";
import type { SettingsModelProvider } from "@/lib/settings/types";

export const COMMAND_REASONING_LEVELS = [
  "low",
  "medium",
  "high",
  "extra_high",
  "ultra",
] as const;

export type CommandReasoningLevel = (typeof COMMAND_REASONING_LEVELS)[number];

export type CommandReasoningOption = Readonly<{
  id: CommandReasoningLevel;
  label: "Low" | "Medium" | "High" | "Extra high" | "Ultra";
  nativeEffort: ModelReasoningEffort;
}>;

const reasoningLabels: Record<
  CommandReasoningLevel,
  CommandReasoningOption["label"]
> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  extra_high: "Extra high",
  ultra: "Ultra",
};

const reasoningEfforts: Record<CommandReasoningLevel, ModelReasoningEffort> = {
  low: "low",
  medium: "medium",
  high: "high",
  extra_high: "xhigh",
  ultra: "max",
};

const EFFORT_ORDER: readonly ModelReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/**
 * Provider-native reasoning efforts accepted by the selected model.
 *
 * Keep this as the single compatibility boundary for both the Command UI and
 * server-side provider calls. A saved route may change models without a new
 * client release, so callers must never infer support from a broad model
 * family check alone.
 */
export function modelReasoningEfforts(
  provider: SettingsModelProvider,
  modelId: string,
): readonly ModelReasoningEffort[] {
  if (provider === "anthropic") {
    return anthropicModelCapabilities(modelId).efforts;
  }
  if (provider !== "openai") return [];
  return openAIReasoningEfforts(modelId.trim().toLowerCase());
}

// OpenAI's model pages list each model's levels. gpt-5 alone accepts
// minimal; from gpt-5.1 the lowest is none, which turns reasoning off and is
// not offered here. xhigh arrives with gpt-5.2 and max with gpt-5.6.
function openAIReasoningEfforts(model: string): readonly ModelReasoningEffort[] {
  if (/^gpt-6(?:[-.]|$)/.test(model)) {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  const gpt5 = /^gpt-5(?:\.(\d+))?(?:[-.]|$)/.exec(model);
  if (gpt5) {
    const minor = Number(gpt5[1] ?? 0);
    if (minor >= 6) return ["low", "medium", "high", "xhigh", "max"];
    if (minor >= 2) return ["low", "medium", "high", "xhigh"];
    if (minor === 1) return ["low", "medium", "high"];
    return ["minimal", "low", "medium", "high"];
  }
  if (/^o\d(?:[-.]|$)/.test(model)) {
    return ["low", "medium", "high"];
  }
  return [];
}

/**
 * Resolve an effort for the actual provider/model attempt. A level the model
 * does not accept becomes the nearest one below it that it does, or its
 * lowest when none is below; no request means its lowest. Models without an
 * adjustable reasoning contract omit the provider parameter entirely.
 */
export function resolveModelReasoningEffort(
  provider: SettingsModelProvider,
  modelId: string,
  requested?: ModelReasoningEffort,
): ModelReasoningEffort | undefined {
  const supported = modelReasoningEfforts(provider, modelId);
  if (!supported.length) return undefined;
  if (!requested) return supported[0];
  const rank = EFFORT_ORDER.indexOf(requested);
  return supported.findLast((effort) => EFFORT_ORDER.indexOf(effort) <= rank) ??
    supported[0];
}

// Reasoning tokens count against max_output_tokens, and a response that
// reaches it ends incomplete, possibly before any visible output. OpenAI
// gives no figure by effort; it advises reserving about 25,000 tokens for
// reasoning and output to start with. Minimal reasons very little.
const OPENAI_REASONING_TOKENS: Record<ModelReasoningEffort, number> = {
  minimal: 0,
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  xhigh: 25_000,
  max: 25_000,
};

/**
 * The max_output_tokens for an OpenAI request whose answer may use
 * `answerTokens`, sent at `effort` as resolved for its model. A reasoning
 * model also gets room to reason at that effort.
 */
export function openAIMaxOutputTokens(
  answerTokens: number,
  effort: ModelReasoningEffort | undefined,
) {
  return effort ? answerTokens + OPENAI_REASONING_TOKENS[effort] : answerTokens;
}

/** Browser-safe provider/model compatibility used by Settings and Command. */
export function commandReasoningOptionsForModel(
  provider: SettingsModelProvider,
  modelId: string,
): readonly CommandReasoningOption[] {
  const supported = modelReasoningEfforts(provider, modelId);
  return COMMAND_REASONING_LEVELS.flatMap((id) => {
    const nativeEffort = reasoningEfforts[id];
    return supported.includes(nativeEffort)
      ? [{ id, label: reasoningLabels[id], nativeEffort }]
      : [];
  });
}
