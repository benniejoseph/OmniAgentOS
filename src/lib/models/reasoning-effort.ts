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
  if (provider !== "openai") return [];
  const normalized = modelId.trim().toLowerCase();

  if (/^gpt-6(?:[-.]|$)/i.test(normalized)) {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (/^gpt-5(?:[-.]|$)/i.test(normalized)) {
    return ["minimal", "low", "medium", "high"];
  }
  if (/^o\d(?:[-.]|$)/i.test(normalized)) {
    return ["low", "medium", "high"];
  }
  return [];
}

/**
 * Resolve an effort for the actual provider/model attempt. Unsupported values
 * fall back to that model's least intensive accepted effort; models without an
 * adjustable reasoning contract omit the provider parameter entirely.
 */
export function resolveModelReasoningEffort(
  provider: SettingsModelProvider,
  modelId: string,
  requested?: ModelReasoningEffort,
): ModelReasoningEffort | undefined {
  const supported = modelReasoningEfforts(provider, modelId);
  if (!supported.length) return undefined;
  if (requested && supported.includes(requested)) return requested;
  return supported[0];
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
