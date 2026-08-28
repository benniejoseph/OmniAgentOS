export const AGENT_MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-5";
// Separate faster model for web search summarization — gpt-5 is too slow for the 60s Vercel budget.
export const WEB_SEARCH_MODEL = process.env.OPENAI_WEB_SEARCH_MODEL || "gpt-4o-mini";
export const WEB_SEARCH_TIMEOUT_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WEB_SEARCH_TIMEOUT_MS,
  25_000,
);
export const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-large";
export const TRANSCRIPTION_MODEL =
  process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
export const OCR_MODEL = process.env.OPENAI_OCR_MODEL || "gpt-4o-mini";
export const GEMINI_FAST_MODEL = process.env.GEMINI_FAST_MODEL || "gemini-3.5-flash-lite";
export const GEMINI_IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image";
export const ANTHROPIC_FAST_MODEL = process.env.ANTHROPIC_FAST_MODEL || "claude-haiku-4-5";
export const ANTHROPIC_REASONING_MODEL = process.env.ANTHROPIC_REASONING_MODEL || "claude-sonnet-5";
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
  10000,
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

export function getOpenAIGatewayConfig(): OpenAIGatewayConfig | undefined {
  const configuredUrl = process.env.OMNIAGENT_OPENAI_GATEWAY_URL?.trim();
  const token = process.env.OMNIAGENT_OPENAI_GATEWAY_TOKEN?.trim();
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

export function getAppBaseUrl() {
  const configuredUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configuredUrl) {
    return configuredUrl.replace(/\/+$/, "");
  }
  const vercelHost = (
    process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL
  )?.trim();
  return vercelHost ? `https://${vercelHost}` : "http://localhost:3000";
}

export const AGENT_MAX_TOOL_STEPS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_TOOL_STEPS,
  6,
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
// gpt-5 streams output relatively slowly (~1 delta/sec here), so a long research
// answer can exceed even the 300s Vercel Pro budget. Use minimal reasoning and a
// bounded output so runs finish — and persist — within the function window.
export const AGENT_REASONING_EFFORT: "minimal" | "low" | "medium" | "high" =
  normalizeReasoningEffort(process.env.OMNIAGENT_AGENT_REASONING_EFFORT, "minimal");
export const AGENT_MAX_OUTPUT_TOKENS = normalizePositiveInteger(
  process.env.OMNIAGENT_AGENT_MAX_OUTPUT_TOKENS,
  2_000,
);

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
