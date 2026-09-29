import { z } from "zod";
import { AGENT_RUN_BUDGET_LIMITS } from "@/lib/config";

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

const BUDGET_COUNTER_MAX = 1_000_000_000_000;
const budgetCounterSchema = z.number().int().min(0).max(BUDGET_COUNTER_MAX);

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

/**
 * Reads durable v1 state while accepting the decimal token strings emitted by
 * an older continuation sanitization path. No other counter or string form is
 * coerced, so malformed or broadened budget authority still fails closed.
 */
export function parsePersistedRunBudgetStateV1(
  value: unknown,
): RunBudgetStateV1 | undefined {
  const exact = runBudgetStateV1Schema.safeParse(value);
  if (exact.success) return exact.data;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const candidate = value as Record<string, unknown>;
  const limits = normalizeLegacyTokenCounter(candidate.limits);
  const used = normalizeLegacyTokenCounter(candidate.used);
  if (!limits || !used) return undefined;
  const compatible = runBudgetStateV1Schema.safeParse({
    ...candidate,
    limits,
    used,
  });
  return compatible.success ? compatible.data : undefined;
}

function normalizeLegacyTokenCounter(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const counter = value as Record<string, unknown>;
  const tokens = counter.tokens;
  if (typeof tokens !== "string") return counter;
  if (!/^(?:0|[1-9][0-9]{0,12})$/.test(tokens)) return undefined;
  const parsed = Number(tokens);
  if (!Number.isSafeInteger(parsed)) return undefined;
  return { ...counter, tokens: parsed };
}

/** Safe compatibility limits for internal callers that predate request budgets. */
export const DEFAULT_AGENT_RUN_BUDGET_LIMITS: RunBudgetCountersV1 = Object.freeze({
  ...AGENT_RUN_BUDGET_LIMITS,
});

/**
 * Fail-closed ceiling for parked legacy continuations that did not persist an
 * exact budget state. New runs use the configured server authority above, but
 * an old continuation must never gain authority merely because that ceiling
 * increased after it was paused.
 */
export const LEGACY_AGENT_RUN_BUDGET_LIMITS: RunBudgetCountersV1 = Object.freeze({
  modelTurns: Math.min(7, AGENT_RUN_BUDGET_LIMITS.modelTurns),
  tokens: Math.min(64_000, AGENT_RUN_BUDGET_LIMITS.tokens),
  costMicrousd: Math.min(2_500_000, AGENT_RUN_BUDGET_LIMITS.costMicrousd),
  wallTimeMs: Math.min(240_000, AGENT_RUN_BUDGET_LIMITS.wallTimeMs),
  toolCalls: Math.min(30, AGENT_RUN_BUDGET_LIMITS.toolCalls),
  browserActions: Math.min(12, AGENT_RUN_BUDGET_LIMITS.browserActions),
  agents: Math.min(5, AGENT_RUN_BUDGET_LIMITS.agents),
  fanOut: Math.min(4, AGENT_RUN_BUDGET_LIMITS.fanOut),
  retries: Math.min(2, AGENT_RUN_BUDGET_LIMITS.retries),
  replans: Math.min(1, AGENT_RUN_BUDGET_LIMITS.replans),
});

export function restoreLegacyAgentRunBudgetState(input: {
  startedAt: string;
  toolSteps: number;
  toolCallsPerStep: number;
}) {
  const limits = LEGACY_AGENT_RUN_BUDGET_LIMITS;
  const modelTurns = Math.min(
    limits.modelTurns,
    Math.max(1, input.toolSteps + 1),
  );
  return createRunBudgetState(limits, {
    startedAt: input.startedAt,
    used: {
      modelTurns,
      tokens: Math.min(
        limits.tokens,
        modelTurns * Math.floor(limits.tokens / limits.modelTurns),
      ),
      costMicrousd: Math.min(
        limits.costMicrousd,
        modelTurns * Math.floor(
          limits.costMicrousd / limits.modelTurns,
        ),
      ),
      toolCalls: Math.min(
        limits.toolCalls,
        input.toolSteps * input.toolCallsPerStep,
      ),
      browserActions: limits.browserActions,
      agents: limits.agents,
      fanOut: limits.fanOut,
      retries: limits.retries,
      replans: limits.replans,
    },
  });
}

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

/** A turn would take the workspace's AI usage past its 24-hour limit. */
export class TenantDailyBudgetExceededError extends RunBudgetExceededError {
  constructor(
    dimension: "tokens" | "costMicrousd",
    limit: number,
    attempted: number,
  ) {
    super(dimension, limit, attempted);
    this.message =
      `The workspace's ${budgetDimensionLabel(dimension)} budget for the `
      + `last 24 hours is exhausted (${attempted} requested, limit ${limit}).`;
    this.name = "TenantDailyBudgetExceededError";
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

/**
 * Allocate one model turn from the budget that remains after fixed run costs
 * such as context compilation. Recomputing the share for every turn prevents
 * those fixed costs from making the final otherwise-authorized turn exceed the
 * run-wide token or cost limit.
 */
export function budgetPerRemainingModelTurn(
  state: RunBudgetStateV1,
  dimension: "tokens" | "costMicrousd",
  now = Date.now(),
) {
  const remaining = remainingRunBudget(state, now);
  if (remaining.modelTurns <= 0 || remaining[dimension] <= 0) return 1;
  return Math.max(
    1,
    Math.floor(remaining[dimension] / remaining.modelTurns),
  );
}

/** Input tokens one image or binary part is assumed to add to a request. */
export const ESTIMATED_IMAGE_INPUT_TOKENS = 1_600;

const IMAGE_DATA_URL = /^data:image\/[a-z0-9.+-]+;base64,/i;
const MAX_ESTIMATED_DEPTH = 64;

/**
 * Estimate a model request's input tokens from what it sends: about four
 * characters a token over every key and value, and a fixed allowance for each
 * image, whose encoded size says little about what it costs.
 */
export function estimateModelInputTokens(value: unknown) {
  let characters = 0;
  let images = 0;
  const path = new Set<object>();
  const visit = (item: unknown, key: string | undefined, depth: number) => {
    if (typeof item === "string") {
      if (key === "dataBase64" || IMAGE_DATA_URL.test(item)) images += 1;
      else characters += item.length;
      return;
    }
    if (
      typeof item === "number" ||
      typeof item === "boolean" ||
      typeof item === "bigint"
    ) {
      characters += String(item).length;
      return;
    }
    if (!item || typeof item !== "object") return;
    if (ArrayBuffer.isView(item) || item instanceof ArrayBuffer) {
      images += 1;
      return;
    }
    if (depth >= MAX_ESTIMATED_DEPTH || path.has(item)) return;
    path.add(item);
    if (Array.isArray(item)) {
      for (const entry of item) visit(entry, undefined, depth + 1);
    } else {
      for (const [name, entry] of Object.entries(item)) {
        characters += name.length;
        visit(entry, name, depth + 1);
      }
    }
    path.delete(item);
  };
  visit(value, undefined, 0);
  return Math.ceil(characters / 4) + images * ESTIMATED_IMAGE_INPUT_TOKENS;
}

export type ModelTurnBudgetEstimate = {
  /** The turn's estimated input and the most output it may produce. */
  tokens: number;
  costMicrousd: number;
  /** The same for one more turn, after a full round of tool results. */
  followUpTokens: number;
  followUpCostMicrousd: number;
};

/** A workspace's AI usage over its rolling window, and the limit on it. */
export type TenantDailyBudgetCeiling = Record<
  "tokens" | "costMicrousd",
  { limit: number; used: number }
>;

export type ModelTurnBudgetReservation = {
  tokens: number;
  costMicrousd: number;
  retries: number;
};

/**
 * Reserve one model turn at its estimate. A turn that may call tools is the
 * run's last when no room would be left for one more turn after the tool
 * results, in the run's budget or in the workspace's window: it is then asked
 * for its answer instead.
 */
export function planModelTurnBudget(
  state: RunBudgetStateV1,
  input: {
    estimate: ModelTurnBudgetEstimate;
    toolsEnabled: boolean;
    allowRetry?: boolean;
    ceiling?: TenantDailyBudgetCeiling;
    now?: number;
  },
) {
  const now = input.now ?? Date.now();
  const retries = input.allowRetry !== false &&
      remainingRunBudget(state, now).retries > 0
    ? 1
    : 0;
  const reserved: ModelTurnBudgetReservation = {
    tokens: input.estimate.tokens,
    costMicrousd: input.estimate.costMicrousd,
    retries,
  };
  const next = reserveRunBudget(state, { modelTurns: 1, ...reserved }, now);
  const ceiling = input.ceiling;
  if (ceiling) {
    for (const dimension of ["tokens", "costMicrousd"] as const) {
      const attempted = ceiling[dimension].used + reserved[dimension];
      if (attempted > ceiling[dimension].limit) {
        throw new TenantDailyBudgetExceededError(
          dimension,
          ceiling[dimension].limit,
          attempted,
        );
      }
    }
  }
  const remaining = remainingRunBudget(next, now);
  const room = (dimension: "tokens" | "costMicrousd") => Math.min(
    remaining[dimension],
    ceiling
      ? ceiling[dimension].limit - ceiling[dimension].used - reserved[dimension]
      : Number.POSITIVE_INFINITY,
  );
  const finalTurn = input.toolsEnabled && (
    remaining.modelTurns < 1 ||
    room("tokens") < input.estimate.followUpTokens ||
    room("costMicrousd") < input.estimate.followUpCostMicrousd
  );
  return { state: next, reserved, maxAttempts: 1 + retries, finalTurn };
}

/**
 * Replace a turn's reservation with what it spent. A measure the provider did
 * not report keeps its reservation, and a retry the turn did not make is
 * returned. Spending past a limit is recorded as it happened, so the next
 * reservation fails.
 */
export function settleModelTurnBudget(
  state: RunBudgetStateV1,
  reserved: ModelTurnBudgetReservation,
  spent: { tokens?: number; costMicrousd?: number; retries: number },
): RunBudgetStateV1 {
  const current = runBudgetStateV1Schema.parse(state);
  const settle = (
    dimension: "tokens" | "costMicrousd" | "retries",
    actual: number | undefined,
  ) => Math.min(
    BUDGET_COUNTER_MAX,
    Math.max(0, current.used[dimension] - reserved[dimension]) + (
      actual !== undefined && Number.isFinite(actual)
        ? Math.ceil(Math.max(0, actual))
        : reserved[dimension]
    ),
  );
  return runBudgetStateV1Schema.parse({
    ...current,
    used: {
      ...current.used,
      tokens: settle("tokens", spent.tokens),
      costMicrousd: settle("costMicrousd", spent.costMicrousd),
      retries: settle("retries", Math.min(reserved.retries, spent.retries)),
    },
  });
}

const LOCAL_COMPUTER_VISUAL_ACTION_TOOL_IDS = new Set([
  "local.macos.activate_app",
  "local.macos.open_url",
  "local.macos.press",
  "local.macos.click",
  "local.macos.type",
  "local.macos.key",
  "local.macos.scroll",
]);

export function isBrowserActionTool(input: {
  id?: string;
  name?: string;
  category?: string;
}) {
  if (
    input.id &&
    LOCAL_COMPUTER_VISUAL_ACTION_TOOL_IDS.has(input.id)
  ) return true;
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
