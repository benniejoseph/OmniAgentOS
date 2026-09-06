import { z } from "zod";

export const RUN_BUDGET_SCHEMA_VERSION = 1 as const;
export const RUN_BUDGET_DIMENSIONS = [
  "modelTurns",
  "tokens",
  "costMicrousd",
  "wallTimeMs",
  "toolCalls",
  "browserActions",
  "agents",
  "fanOut",
  "retries",
  "replans",
] as const;

export type RunBudgetDimension = (typeof RUN_BUDGET_DIMENSIONS)[number];

const budgetCounterSchema = z.number().int().min(0).max(1_000_000_000_000);

export const runBudgetCountersV1Schema = z.object(
  Object.fromEntries(
    RUN_BUDGET_DIMENSIONS.map((dimension) => [dimension, budgetCounterSchema]),
  ) as Record<RunBudgetDimension, typeof budgetCounterSchema>,
).strict();

export const runBudgetStateV1Schema = z.object({
  schemaVersion: z.literal(RUN_BUDGET_SCHEMA_VERSION),
  limits: runBudgetCountersV1Schema,
  used: runBudgetCountersV1Schema,
  startedAt: z.string().datetime({ offset: true }),
}).strict();

export type RunBudgetCountersV1 = z.infer<typeof runBudgetCountersV1Schema>;
export type RunBudgetStateV1 = z.infer<typeof runBudgetStateV1Schema>;

export class RunBudgetExceededError extends Error {
  readonly code = "run_budget_exhausted";
  readonly requiresAuthorization = true;

  constructor(
    readonly dimension: RunBudgetDimension,
    readonly limit: number,
    readonly attempted: number,
  ) {
    super(
      `Run ${budgetDimensionLabel(dimension)} budget is exhausted `
        + `(${attempted} requested, limit ${limit}).`,
    );
    this.name = "RunBudgetExceededError";
  }
}

export function zeroRunBudgetCounters(): RunBudgetCountersV1 {
  return {
    modelTurns: 0,
    tokens: 0,
    costMicrousd: 0,
    wallTimeMs: 0,
    toolCalls: 0,
    browserActions: 0,
    agents: 0,
    fanOut: 0,
    retries: 0,
    replans: 0,
  };
}

export function createRunBudgetState(
  limits: RunBudgetCountersV1,
  options: {
    used?: Partial<RunBudgetCountersV1>;
    startedAt?: string;
  } = {},
): RunBudgetStateV1 {
  return runBudgetStateV1Schema.parse({
    schemaVersion: RUN_BUDGET_SCHEMA_VERSION,
    limits,
    used: { ...zeroRunBudgetCounters(), ...(options.used || {}) },
    startedAt: options.startedAt || new Date().toISOString(),
  });
}

export function narrowRunBudgetLimits(
  authority: RunBudgetCountersV1,
  requested?: Partial<RunBudgetCountersV1>,
): RunBudgetCountersV1 {
  const parent = runBudgetCountersV1Schema.parse(authority);
  if (!requested) return parent;
  const narrowed = { ...parent };
  for (const dimension of RUN_BUDGET_DIMENSIONS) {
    const value = requested[dimension];
    if (value === undefined) continue;
    const parsed = budgetCounterSchema.parse(value);
    if (parsed > parent[dimension]) {
      throw new Error(
        `Delegated ${budgetDimensionLabel(dimension)} budget cannot exceed its parent limit.`,
      );
    }
    narrowed[dimension] = parsed;
  }
  return runBudgetCountersV1Schema.parse(narrowed);
}

export function reserveRunBudget(
  state: RunBudgetStateV1,
  reservation: Partial<RunBudgetCountersV1>,
  now = Date.now(),
): RunBudgetStateV1 {
  const current = refreshRunBudgetWallTime(state, now);
  const used = { ...current.used };
  for (const dimension of RUN_BUDGET_DIMENSIONS) {
    const amount = reservation[dimension] ?? 0;
    budgetCounterSchema.parse(amount);
    const attempted = used[dimension] + amount;
    if (attempted > current.limits[dimension]) {
      throw new RunBudgetExceededError(
        dimension,
        current.limits[dimension],
        attempted,
      );
    }
    used[dimension] = attempted;
  }
  return runBudgetStateV1Schema.parse({ ...current, used });
}

export function refreshRunBudgetWallTime(
  state: RunBudgetStateV1,
  now = Date.now(),
): RunBudgetStateV1 {
  const parsed = runBudgetStateV1Schema.parse(state);
  const startedAt = new Date(parsed.startedAt).getTime();
  const elapsed = Math.max(
    parsed.used.wallTimeMs,
    Number.isFinite(startedAt) ? Math.max(0, now - startedAt) : 0,
  );
  if (elapsed > parsed.limits.wallTimeMs) {
    throw new RunBudgetExceededError(
      "wallTimeMs",
      parsed.limits.wallTimeMs,
      elapsed,
    );
  }
  return runBudgetStateV1Schema.parse({
    ...parsed,
    used: { ...parsed.used, wallTimeMs: elapsed },
  });
}

export function remainingRunBudget(
  state: RunBudgetStateV1,
  now = Date.now(),
): RunBudgetCountersV1 {
  const current = refreshRunBudgetWallTime(state, now);
  return Object.fromEntries(
    RUN_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      Math.max(0, current.limits[dimension] - current.used[dimension]),
    ]),
  ) as RunBudgetCountersV1;
}

export function isBrowserActionTool(input: {
  id?: string;
  name?: string;
  category?: string;
}) {
  const identity = `${input.id || ""} ${input.name || ""}`.toLowerCase();
  return input.category === "browser"
    || /(?:^|[.:/_-])browser(?:[.:/_-]|$)/.test(identity)
    || /\bbrowser_(?:navigate|snapshot|find|click|close|type|fill_form|hover|navigate_back|resize|select_option|press_key|tabs|drag|handle_dialog|file_upload)\b/.test(identity);
}

export function budgetDimensionLabel(dimension: RunBudgetDimension) {
  return ({
    modelTurns: "model-turn",
    tokens: "token",
    costMicrousd: "cost",
    wallTimeMs: "wall-time",
    toolCalls: "tool-call",
    browserActions: "browser-action",
    agents: "agent",
    fanOut: "fan-out",
    retries: "retry",
    replans: "replan",
  } satisfies Record<RunBudgetDimension, string>)[dimension];
}
