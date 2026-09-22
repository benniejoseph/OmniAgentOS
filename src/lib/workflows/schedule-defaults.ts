/**
 * Schedule defaults live in a dependency-free module so route schemas and app
 * services can initialize without evaluating the workflow execution graph.
 */
export const DEFAULT_READ_ONLY_SCHEDULE_BUDGET = Object.freeze({
  modelTurns: 4,
  tokens: 32_000,
  costMicrousd: 750_000,
  wallTimeMs: 180_000,
  toolCalls: 16,
  browserActions: 0,
  agents: 0,
  fanOut: 0,
  retries: 1,
  replans: 0,
});
