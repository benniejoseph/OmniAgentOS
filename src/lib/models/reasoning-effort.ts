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

/** Browser-safe provider/model compatibility used by Settings and Command. */
export function commandReasoningOptionsForModel(
  provider: SettingsModelProvider,
  modelId: string,
): readonly CommandReasoningOption[] {
  if (provider !== "openai") return [];
  const normalized = modelId.trim().toLowerCase();
  if (!/^(?:gpt-[56](?:[-.]|$)|o\d(?:[-.]|$))/i.test(normalized)) return [];

  const levels: CommandReasoningLevel[] = ["low", "medium", "high"];
  // The current OpenAI Responses contract exposes xhigh/max, but those
  // values are intentionally advertised only for catalog-discovered GPT-6.
  // Older reasoning families keep the conservative low/medium/high surface.
  if (/^gpt-6(?:[-.]|$)/i.test(normalized)) {
    levels.push("extra_high", "ultra");
  }
  return levels.map((id) => ({
    id,
    label: reasoningLabels[id],
    nativeEffort: reasoningEfforts[id],
  }));
}
