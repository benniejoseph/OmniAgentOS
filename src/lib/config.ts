import { ASAEL_PUBLIC_ORIGIN } from "@/lib/identity";
import { deploymentModel } from "@/lib/models/default-models";

export const AGENT_MODEL = deploymentModel("agent");
export const WEB_SEARCH_MODEL = deploymentModel("webSearch");
export const WEB_SEARCH_TIMEOUT_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WEB_SEARCH_TIMEOUT_MS,
  60_000,
);
export const EMBEDDING_MODEL = deploymentModel("embedding");
export const TRANSCRIPTION_PROVIDER = normalizeTranscriptionProvider(
  process.env.OMNIAGENT_TRANSCRIPTION_PROVIDER,
);
export const TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "";
export const DIARIZATION_MODEL =
  process.env.OPENAI_DIARIZATION_MODEL?.trim() || "";
export const SPEECH_MODEL = deploymentModel("speech");
export const REALTIME_TRANSCRIPTION_MODEL =
  process.env.OPENAI_REALTIME_TRANSCRIPTION_MODEL?.trim() || "";
export const GOOGLE_TRANSCRIPTION_MODEL =
  process.env.GOOGLE_TRANSCRIPTION_MODEL?.trim() || "";
export const OCR_MODEL = deploymentModel("ocr");
export const GEMINI_FAST_MODEL = deploymentModel("geminiFast");
export const GEMINI_IMAGE_MODEL = deploymentModel("geminiImage");
export const GEMINI_VIDEO_MODEL = deploymentModel("geminiVideo");
export const COMPUTER_USE_MODEL = deploymentModel("computerUse");
export const ANTHROPIC_FAST_MODEL = deploymentModel("anthropicFast");
export const ANTHROPIC_REASONING_MODEL = deploymentModel("anthropicReasoning");
export const EMBEDDING_DIMENSIONS = normalizePositiveInteger(
  process.env.OPENAI_EMBEDDING_DIMENSIONS,
  1536,
);
export const PGVECTOR_HNSW_MAX_DIMENSIONS = 2000;
export const VECTOR_INDEX_DIMENSIONS = Math.min(EMBEDDING_DIMENSIONS, PGVECTOR_HNSW_MAX_DIMENSIONS);
export const OPERATION_QUEUE_LEASE_SECONDS = normalizePositiveInteger(
  process.env.OMNIAGENT_QUEUE_LEASE_SECONDS,
  120,
);
export const WORKFLOW_DRAIN_LIMIT = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_DRAIN_LIMIT,
  2,
);
export const ALERT_SCHEDULER_CRON_PATH = "/api/workflows/tick";
export const ALERT_SCHEDULER_CRON_SCHEDULE = "0 0 * * *";
export const ALERT_SCHEDULER_QUEUE_LIMIT = normalizePositiveInteger(
  process.env.OMNIAGENT_ALERT_QUEUE_LIMIT,
  10,
);
export const ALERT_SCHEDULER_DISPATCH_LIMIT = normalizePositiveInteger(
  process.env.OMNIAGENT_ALERT_DISPATCH_LIMIT,
  10,
);
export const WORKFLOW_PLANNER_TIMEOUT_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_PLANNER_TIMEOUT_MS,
  45000,
);
export const WORKFLOW_EXECUTOR_TIMEOUT_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_EXECUTOR_TIMEOUT_MS,
  30000,
);
export const WORKFLOW_VERIFIER_TIMEOUT_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_VERIFIER_TIMEOUT_MS,
  30000,
);
export const WORKFLOW_PLAN_MAX_TOOL_CALLS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_PLAN_MAX_TOOL_CALLS,
  24,
);
export const WORKFLOW_PLAN_MAX_COST_UNITS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_PLAN_MAX_COST_UNITS,
  64,
);
export const WORKFLOW_PLAN_MAX_WALL_CLOCK_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_PLAN_MAX_WALL_CLOCK_MS,
  60_000,
);
export const WORKFLOW_PLAN_NODES_PER_TICK = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_PLAN_NODES_PER_TICK,
  3,
);
export const WORKFLOW_RUN_BUDGET_LIMITS = Object.freeze({
  modelTurns: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_MODEL_TURNS,
    24,
  ),
  tokens: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_TOTAL_TOKENS,
    160_000,
  ),
  costMicrousd: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_COST_MICROUSD,
    5_000_000,
  ),
  wallTimeMs: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_WALL_CLOCK_MS,
    900_000,
  ),
  toolCalls: WORKFLOW_PLAN_MAX_TOOL_CALLS,
  browserActions: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_BROWSER_ACTIONS,
    12,
  ),
  agents: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_AGENTS,
    12,
  ),
  fanOut: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_FAN_OUT,
    3,
  ),
  retries: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_RETRIES,
    5,
  ),
  replans: normalizePositiveInteger(
    process.env.OMNIAGENT_WORKFLOW_MAX_REPLANS,
    1,
  ),
});

export type OpenAIGatewayConfig = Readonly<{
  baseURL: string;
  token: string;
}>;

export const OPENAI_GATEWAY_PRODUCTION_BASE_URL =
  "https://omniagent-os-worker.fly.dev/v1";

const OPENAI_GATEWAY_CONFIGURATION_ERROR =
  "OpenAI gateway configuration is invalid.";
const OPENAI_GATEWAY_PRODUCTION_URL_PATTERN =
  /^https:\/\/omniagent-os-worker\.fly\.dev(?::443)?\/v1\/?$/i;

/** Select the sensitive recovery alias only for an explicitly marked deployment. */
export function getOpenAIGatewayToken(): string | undefined {
  const recoverySelector =
    process.env.OMNIAGENT_OPENAI_GATEWAY_USE_RECOVERY_TOKEN?.trim();
  if (recoverySelector && recoverySelector !== "true" && recoverySelector !== "false") {
    throw new Error(OPENAI_GATEWAY_CONFIGURATION_ERROR);
  }
  if (recoverySelector === "true") {
    const token = process.env.OMNIAGENT_OPENAI_GATEWAY_RECOVERY_TOKEN?.trim();
    if (!token || !/^[A-Za-z0-9._~-]{32,256}$/.test(token)) {
      // A selected recovery deployment must never fall back to the unknown token.
      throw new Error(OPENAI_GATEWAY_CONFIGURATION_ERROR);
    }
    return token;
  }
  return process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN?.trim();
}

export function getOpenAIGatewayConfig(): OpenAIGatewayConfig | undefined {
  const configuredUrl = process.env.OMNIAGENT_OPENAI_GATEWAY_URL?.trim();
  const token = getOpenAIGatewayToken();
  if (!configuredUrl && !token) {
    return undefined;
  }

  const fail = () => {
    if (isProductionDeployment()) {
      throw new Error(OPENAI_GATEWAY_CONFIGURATION_ERROR);
    }
    return undefined;
  };
  if (
    !configuredUrl ||
    !token ||
    !/^[A-Za-z0-9._~-]{32,256}$/.test(token)
  ) {
    return fail();
  }

  let url: URL;
  try {
    url = new URL(configuredUrl);
  } catch {
    return fail();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return fail();
  }

  if (
    isProductionDeployment() &&
    (!OPENAI_GATEWAY_PRODUCTION_URL_PATTERN.test(configuredUrl) ||
      url.origin !== new URL(OPENAI_GATEWAY_PRODUCTION_BASE_URL).origin ||
      (url.pathname !== "/v1" && url.pathname !== "/v1/"))
  ) {
    return fail();
  }

  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : `${path}/v1`;
  const baseURL = url.toString().replace(/\/$/, "");
  if (
    isProductionDeployment() &&
    baseURL !== OPENAI_GATEWAY_PRODUCTION_BASE_URL
  ) {
    return fail();
  }
  return {
    baseURL,
    token,
  };
}

export function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function hasGeminiKey() {
  return Boolean(process.env.GEMINI_API_KEY?.trim());
}

export function hasAnthropicKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function hasGoogleMediaKey() {
  return Boolean(process.env.GOOGLE_MEDIA_API_KEY?.trim());
}

function normalizeTranscriptionProvider(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "openai" || normalized === "google"
    ? normalized
    : undefined;
}

export function getAppBaseUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const normalizedConfiguredUrl = configuredUrl?.replace(/\/+$/, "");
  if (isCanonicalProductionRuntime()) {
    if (
      normalizedConfiguredUrl &&
      normalizedConfiguredUrl !== ASAEL_PUBLIC_ORIGIN
    ) {
      throw new Error(
        `NEXT_PUBLIC_APP_URL must be exactly ${ASAEL_PUBLIC_ORIGIN} in production.`,
      );
    }
    return ASAEL_PUBLIC_ORIGIN;
  }
  if (normalizedConfiguredUrl) {
    return normalizedConfiguredUrl;
  }
  const vercelHost = (
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
  )?.trim();
  return vercelHost ? `https://${vercelHost}` : "http://localhost:3000";
}

function isCanonicalProductionRuntime() {
  return process.env.VERCEL_ENV === "production" ||
    (process.env.NODE_ENV === "production" && !process.env.VERCEL);
}

export const AGENT_MAX_TOOL_STEPS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_TOOL_STEPS,
  6,
);
export const AGENT_MAX_MODEL_TURNS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_MODEL_TURNS,
  // Two delegated child/Sentinel lifecycles consume ten pre-reserved turns;
  // retain four parent turns for retrieval, two dispatches, and final receipt.
  14,
);
export const LOCAL_COMPUTER_MAX_TOOL_STEPS = normalizePositiveInteger(
  process.env.OMNIAGENT_LOCAL_COMPUTER_MAX_TOOL_STEPS,
  12,
);
export const AGENT_MAX_MESSAGE_CHARS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_MESSAGE_CHARS,
  32_000,
);
export const AGENT_MAX_MESSAGES = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_MESSAGES,
  40,
);
export const AGENT_RUNS_PER_MINUTE = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_RUNS_PER_MINUTE,
  10,
);
// A direct run executes inside its request, which the agent route lets last
// 300 seconds, and every turn re-sends the conversation. So the loop asks for
// low effort, the lowest level every current reasoning model accepts (gpt-5
// alone also accepts minimal), and a bounded answer. Command's Thinking menu
// asks for more on one run; reasoning gets room on top of the answer.
export const AGENT_REASONING_EFFORT: "minimal" | "low" | "medium" | "high" =
  normalizeReasoningEffort(process.env.OMNIAGENT_AGENT_REASONING_EFFORT, "low");
export const AGENT_MAX_OUTPUT_TOKENS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_OUTPUT_TOKENS,
  2_000,
);
// Research reserves room for a report without increasing ordinary chat limits
// or the caller's total token, cost, and wall-clock authority.
export const RESEARCH_MAX_OUTPUT_TOKENS = Math.min(16_000, normalizePositiveInteger(
  process.env.OMNIAGENT_RESEARCH_MAX_OUTPUT_TOKENS,
  6_000,
));
// Every turn is charged the tokens it used, and each turn sends the whole
// conversation again, so a run's total grows with each tool round.
export const AGENT_MAX_TOTAL_TOKENS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_TOTAL_TOKENS,
  400_000,
);
export const AGENT_MAX_COST_MICROUSD = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_COST_MICROUSD,
  2_500_000,
);
export const AGENT_MAX_WALL_CLOCK_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_WALL_CLOCK_MS,
  240_000,
);
export const AGENT_MAX_BROWSER_ACTIONS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_BROWSER_ACTIONS,
  12,
);
export const AGENT_MAX_AGENTS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_AGENTS,
  7,
);
export const AGENT_MAX_FAN_OUT = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_FAN_OUT,
  6,
);
export const AGENT_MAX_RETRIES = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_RETRIES,
  // Preserve one bounded retry for each of two delegated children and each
  // parent dispatch/final-receipt turn in the two-child orchestration path.
  5,
);
export const AGENT_MAX_REPLANS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_REPLANS,
  1,
);

// An agent turn also must fit the workspace's AI usage over the last 24
// hours, as the usage ledger records it.
export const TENANT_DAILY_MAX_TOKENS = normalizePositiveInteger(
  process.env.OMNIAGENT_TENANT_DAILY_MAX_TOKENS,
  5_000_000,
);
export const TENANT_DAILY_MAX_COST_MICROUSD = normalizePositiveInteger(
  process.env.OMNIAGENT_TENANT_DAILY_MAX_COST_MICROUSD,
  25_000_000,
);

// A new inbound A2A task starts only while its peer has task starts left in
// the hour and the task's whole budget fits the peer's AI usage over the last
// 24 hours as well as the workspace's.
export const A2A_PEER_TASKS_PER_HOUR = normalizePositiveInteger(
  process.env.OMNIAGENT_A2A_PEER_TASKS_PER_HOUR,
  20,
);
export const A2A_PEER_DAILY_MAX_TOKENS = normalizePositiveInteger(
  process.env.OMNIAGENT_A2A_PEER_DAILY_MAX_TOKENS,
  240_000,
);
export const A2A_PEER_DAILY_MAX_COST_MICROUSD = normalizePositiveInteger(
  process.env.OMNIAGENT_A2A_PEER_DAILY_MAX_COST_MICROUSD,
  5_000_000,
);

export const AGENT_RUN_BUDGET_LIMITS = Object.freeze({
  modelTurns: AGENT_MAX_MODEL_TURNS,
  tokens: AGENT_MAX_TOTAL_TOKENS,
  costMicrousd: AGENT_MAX_COST_MICROUSD,
  wallTimeMs: AGENT_MAX_WALL_CLOCK_MS,
  toolCalls: AGENT_MAX_TOOL_STEPS * 5,
  browserActions: AGENT_MAX_BROWSER_ACTIONS,
  agents: AGENT_MAX_AGENTS,
  fanOut: AGENT_MAX_FAN_OUT,
  retries: AGENT_MAX_RETRIES,
  replans: AGENT_MAX_REPLANS,
});

/**
 * Installed-Mac runs reserve one model turn for semantic planning and one for
 * the final answer in addition to their bounded action/model rounds. Every
 * other budget dimension remains identical to the ordinary agent authority.
 */
export const LOCAL_COMPUTER_RUN_BUDGET_LIMITS = Object.freeze({
  ...AGENT_RUN_BUDGET_LIMITS,
  modelTurns: LOCAL_COMPUTER_MAX_TOOL_STEPS + 2,
});

function normalizePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function isProductionDeployment() {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production"
  );
}

function normalizeReasoningEffort(
  value: string | undefined,
  fallback: "minimal" | "low" | "medium" | "high",
): "minimal" | "low" | "medium" | "high" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : fallback;
}
