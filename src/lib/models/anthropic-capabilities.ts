import type { ModelReasoningEffort } from "@/lib/models/types";

/**
 * Messages API request features that only some Claude models accept.
 *
 * Model assignments are free text and the settings catalog lists every model
 * the key can reach, so the adapter decides these from the model id. An id
 * this table does not know gets the settings every Claude model accepts.
 */
export type AnthropicModelCapabilities = Readonly<{
  /** Accepts tool_choice "any" or "tool", which makes the model call a tool. */
  forcedToolChoice: boolean;
  /** Levels accepted in output_config.effort, least intensive first. */
  efforts: readonly ModelReasoningEffort[];
  /** Thinks when the request sets no thinking, and spends max_tokens on it. */
  thinksByDefault: boolean;
}>;

// Claude Opus 5.5, Claude Fable 5.1 and Claude Mythos 5.1 reject a forced tool
// choice with a 400 whatever the thinking settings, so only the families
// documented to accept it are listed. A dated snapshot id
// (claude-sonnet-5-20260115) belongs to its family; a new minor version
// (claude-sonnet-5-5) does not.
const FORCED_TOOL_CHOICE_MODELS = [
  /^claude-3-/,
  /^claude-(?:opus|sonnet|haiku)-4(?:-\d)?(?:-\d{8})?$/,
  /^claude-(?:opus|sonnet)-5(?:-\d{8})?$/,
];

const EVERY_EFFORT = ["low", "medium", "high", "xhigh", "max"] as const;
const NO_XHIGH = ["low", "medium", "high", "max"] as const;
const UP_TO_HIGH = ["low", "medium", "high"] as const;

// Anthropic's effort and adaptive thinking pages, by exact model id. A model
// missing here gets no effort parameter and the caller's answer budget.
const EFFORT_MODELS = new Map<
  string,
  Readonly<{ efforts: readonly ModelReasoningEffort[]; thinksByDefault: boolean }>
>([
  ["claude-fable-5-1", { efforts: EVERY_EFFORT, thinksByDefault: true }],
  ["claude-mythos-5-1", { efforts: EVERY_EFFORT, thinksByDefault: true }],
  ["claude-fable-5", { efforts: EVERY_EFFORT, thinksByDefault: true }],
  ["claude-mythos-5", { efforts: EVERY_EFFORT, thinksByDefault: true }],
  ["claude-opus-5-5", { efforts: EVERY_EFFORT, thinksByDefault: true }],
  ["claude-opus-5", { efforts: EVERY_EFFORT, thinksByDefault: true }],
  ["claude-sonnet-5", { efforts: EVERY_EFFORT, thinksByDefault: true }],
  ["claude-mythos-preview", { efforts: NO_XHIGH, thinksByDefault: true }],
  ["claude-opus-4-8", { efforts: EVERY_EFFORT, thinksByDefault: false }],
  ["claude-opus-4-7", { efforts: EVERY_EFFORT, thinksByDefault: false }],
  ["claude-opus-4-6", { efforts: NO_XHIGH, thinksByDefault: false }],
  ["claude-sonnet-4-6", { efforts: NO_XHIGH, thinksByDefault: false }],
  ["claude-opus-4-5-20251101", { efforts: UP_TO_HIGH, thinksByDefault: false }],
  ["claude-opus-4-5", { efforts: UP_TO_HIGH, thinksByDefault: false }],
]);

export function anthropicModelCapabilities(
  model: string,
): AnthropicModelCapabilities {
  const normalized = model.trim().toLowerCase();
  const effort = EFFORT_MODELS.get(normalized);
  return {
    forcedToolChoice: FORCED_TOOL_CHOICE_MODELS.some((pattern) =>
      pattern.test(normalized)
    ),
    efforts: effort?.efforts ?? [],
    thinksByDefault: effort?.thinksByDefault ?? false,
  };
}

// Anthropic's SDKs refuse a request above this max_tokens unless it streams,
// because a longer reply can outlast the HTTP timeout. These calls do not
// stream.
const NON_STREAMING_MAX_TOKENS = 21_333;

// Room for thinking on top of the answer, by the effort the model runs at.
// Anthropic gives no figure below xhigh. For xhigh and max it advises at
// least 64k, which needs streaming, so those get the non-streaming limit.
const THINKING_TOKENS: Record<ModelReasoningEffort, number> = {
  minimal: 4_000,
  low: 4_000,
  medium: 8_000,
  high: 16_000,
  xhigh: NON_STREAMING_MAX_TOKENS,
  max: NON_STREAMING_MAX_TOKENS,
};

/**
 * The max_tokens for a Claude request whose answer may use `answerTokens`.
 * A model that thinks by default spends max_tokens on thinking as well, so
 * it also gets room to think at `effort`. No effort means the model's own
 * default, which is high on every model except Opus 5.5.
 */
export function claudeMaxTokens(
  model: string,
  answerTokens: number,
  effort?: ModelReasoningEffort,
) {
  if (!anthropicModelCapabilities(model).thinksByDefault) return answerTokens;
  return Math.min(
    answerTokens + THINKING_TOKENS[effort ?? "high"],
    NON_STREAMING_MAX_TOKENS,
  );
}

/**
 * The Claude model id inside a Bedrock model id, inference profile id or
 * ARN (us.anthropic.claude-opus-5-5, anthropic.claude-opus-4-5-20251101-v1:0),
 * or undefined for another model or an application inference profile.
 */
export function claudeModelInBedrockId(modelId: string) {
  return /(?:^|[/.])anthropic\.(claude-[a-z0-9-]+?)(?:-v\d+(?::\d+)?)?$/
    .exec(modelId.trim().toLowerCase())?.[1];
}
