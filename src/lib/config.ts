export const AGENT_MODEL = process.env.OPENAI_AGENT_MODEL || "gpt-5";
export const EMBEDDING_MODEL =
  process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-large";
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
export const WORKFLOW_PLANNER_TIMEOUT_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_PLANNER_TIMEOUT_MS,
  8000,
);
export const WORKFLOW_EXECUTOR_TIMEOUT_MS = normalizePositiveInteger(
  process.env.OMNIAGENT_WORKFLOW_EXECUTOR_TIMEOUT_MS,
  10000,
);

export function hasOpenAIKey() {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

export function getAppBaseUrl() {
  return process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
}

function normalizePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
