/**
 * The model each deployment role uses, and the environment variable that
 * names another. A workspace's model assignments in Settings take precedence
 * over these wherever a role can be assigned.
 */
export const DEFAULT_MODELS = {
  agent: { env: "OPENAI_AGENT_MODEL", model: "gpt-5" },
  // Web search summaries use a faster model than the agent.
  webSearch: { env: "OPENAI_WEB_SEARCH_MODEL", model: "gpt-4o-mini" },
  embedding: { env: "OPENAI_EMBEDDING_MODEL", model: "text-embedding-3-large" },
  speech: { env: "OPENAI_SPEECH_MODEL", model: "gpt-4o-mini-tts" },
  ocr: { env: "OPENAI_OCR_MODEL", model: "gpt-4o-mini" },
  computerUse: { env: "OPENAI_COMPUTER_USE_MODEL", model: "gpt-6-astra" },
  geminiFast: { env: "GEMINI_FAST_MODEL", model: "gemini-3.5-flash-lite" },
  geminiImage: { env: "GEMINI_IMAGE_MODEL", model: "gemini-3.1-flash-image" },
  geminiVideo: { env: "GEMINI_VIDEO_MODEL", model: "gemini-omni-1.1-flash" },
  anthropicFast: { env: "ANTHROPIC_FAST_MODEL", model: "claude-haiku-4-5" },
  anthropicReasoning: { env: "ANTHROPIC_REASONING_MODEL", model: "claude-sonnet-5" },
} as const satisfies Record<string, { env: string; model: string }>;

export type DeploymentModelRole = keyof typeof DEFAULT_MODELS;

/** The model the environment names for a role, or the role's default. */
export function deploymentModel(role: DeploymentModelRole) {
  const { env, model } = DEFAULT_MODELS[role];
  return process.env[env]?.trim() || model;
}
