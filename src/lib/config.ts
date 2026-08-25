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

export function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function getAppBaseUrl() {
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (vercelHost ? `https://${vercelHost}` : "http://localhost:3000")
  );
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

function normalizeReasoningEffort(
  value: string | undefined,
  fallback: "minimal" | "low" | "medium" | "high",
): "minimal" | "low" | "medium" | "high" {
  const normalized = value?.trim().toLowerCase();
  return normalized === "minimal" || normalized === "low" || normalized === "medium" || normalized === "high"
    ? normalized
    : fallback;
}
