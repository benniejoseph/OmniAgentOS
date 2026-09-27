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

export function anthropicModelCapabilities(
  model: string,
): AnthropicModelCapabilities {
  const normalized = model.trim().toLowerCase();
  return {
    forcedToolChoice: FORCED_TOOL_CHOICE_MODELS.some((pattern) =>
      pattern.test(normalized)
    ),
  };
}
