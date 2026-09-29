import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  ESTIMATED_IMAGE_INPUT_TOKENS,
  LEGACY_AGENT_RUN_BUDGET_LIMITS,
  RunBudgetExceededError,
  TenantDailyBudgetExceededError,
  budgetPerRemainingModelTurn,
  createRunBudgetState,
  estimateModelInputTokens,
  isBrowserActionTool,
  narrowRunBudgetLimits,
  parsePersistedRunBudgetStateV1,
  planModelTurnBudget,
  remainingRunBudget,
  restoreLegacyAgentRunBudgetState,
  reserveRunBudget,
  settleModelTurnBudget,
  zeroRunBudgetCounters,
} from "@/lib/runs/budgets";
import { AGENT_RUN_BUDGET_LIMITS } from "@/lib/config";

const limits = {
  ...zeroRunBudgetCounters(),
  modelTurns: 4,
  tokens: 20_000,
  costMicrousd: 500_000,
  wallTimeMs: 60_000,
  toolCalls: 8,
  browserActions: 3,
  agents: 3,
  fanOut: 2,
  retries: 2,
  replans: 1,
};

describe("complete run budgets", () => {
  it("keeps compatibility callers on canonical server authority", () => {
    expect(DEFAULT_AGENT_RUN_BUDGET_LIMITS).toEqual(AGENT_RUN_BUDGET_LIMITS);
    expect(DEFAULT_AGENT_RUN_BUDGET_LIMITS).toMatchObject({
      modelTurns: 14,
      toolCalls: 30,
      agents: 7,
      fanOut: 6,
    });
    expect(() => narrowRunBudgetLimits(DEFAULT_AGENT_RUN_BUDGET_LIMITS, {
      modelTurns: DEFAULT_AGENT_RUN_BUDGET_LIMITS.modelTurns + 1,
    })).toThrow("cannot exceed its parent limit");
  });

  it("does not widen a parked legacy continuation when server authority grows", () => {
    expect(LEGACY_AGENT_RUN_BUDGET_LIMITS).toMatchObject({
      modelTurns: 7,
      toolCalls: 30,
      agents: 5,
      fanOut: 4,
    });
    expect(LEGACY_AGENT_RUN_BUDGET_LIMITS.modelTurns).toBeLessThan(
      DEFAULT_AGENT_RUN_BUDGET_LIMITS.modelTurns,
    );
    expect(restoreLegacyAgentRunBudgetState({
      startedAt: "2026-09-06T00:00:00.000Z",
      toolSteps: 6,
      toolCallsPerStep: 5,
    })).toMatchObject({
      limits: { modelTurns: 7, toolCalls: 30 },
      used: { modelTurns: 7, toolCalls: 30 },
    });
  });

  it("inherits a configured server turn ceiling for compatibility callers", async () => {
    vi.resetModules();
    vi.stubEnv("OMNIAGENT_AGENT_MAX_MODEL_TURNS", "9");

    const configured = await import("@/lib/config");
    const compatibility = await import("@/lib/runs/budgets");

    expect(configured.AGENT_RUN_BUDGET_LIMITS.modelTurns).toBe(9);
    expect(compatibility.DEFAULT_AGENT_RUN_BUDGET_LIMITS.modelTurns).toBe(9);
    expect(() => compatibility.narrowRunBudgetLimits(
      compatibility.DEFAULT_AGENT_RUN_BUDGET_LIMITS,
      { modelTurns: 10 },
    )).toThrow("cannot exceed its parent limit");
  });

  it("lets a lower current server ceiling narrow the legacy fallback", async () => {
    vi.resetModules();
    vi.stubEnv("OMNIAGENT_AGENT_MAX_MODEL_TURNS", "5");

    const compatibility = await import("@/lib/runs/budgets");
    const restored = compatibility.restoreLegacyAgentRunBudgetState({
      startedAt: "2026-09-06T00:00:00.000Z",
      toolSteps: 6,
      toolCallsPerStep: 5,
    });

    expect(restored.limits.modelTurns).toBe(5);
    expect(restored.used.modelTurns).toBe(5);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("accounts for every P6.7 dimension and rejects over-budget work before reservation", () => {
    let state = createRunBudgetState(limits, {
      startedAt: "2026-09-06T00:00:00.000Z",
    });
    state = reserveRunBudget(state, {
      modelTurns: 1,
      tokens: 2_000,
      costMicrousd: 20_000,
      toolCalls: 1,
      browserActions: 1,
      agents: 2,
      fanOut: 1,
      retries: 1,
      replans: 1,
    }, new Date("2026-09-06T00:00:10.000Z").getTime());

    expect(state.used).toMatchObject({
      modelTurns: 1,
      tokens: 2_000,
      wallTimeMs: 10_000,
      toolCalls: 1,
      replans: 1,
    });
    expect(() => reserveRunBudget(
      state,
      { replans: 1 },
      new Date("2026-09-06T00:00:11.000Z").getTime(),
    )).toThrow(RunBudgetExceededError);
    expect(remainingRunBudget(
      state,
      new Date("2026-09-06T00:00:12.000Z").getTime(),
    ).replans).toBe(0);
  });

  it("allows delegated authority only to inherit or narrow every dimension", () => {
    expect(narrowRunBudgetLimits(limits, {
      tokens: 10_000,
      agents: 1,
      fanOut: 0,
    })).toMatchObject({ tokens: 10_000, agents: 1, fanOut: 0 });
    expect(() => narrowRunBudgetLimits(limits, { fanOut: 3 }))
      .toThrow("cannot exceed its parent limit");
  });

  it("normalizes only legacy decimal token counters from durable state", () => {
    const state = createRunBudgetState(limits, {
      used: { modelTurns: 1, tokens: 2_000 },
      startedAt: "2026-09-06T00:00:00.000Z",
    });

    expect(parsePersistedRunBudgetStateV1({
      ...state,
      limits: { ...state.limits, tokens: "20000" },
      used: { ...state.used, tokens: "2000" },
    })).toMatchObject({
      limits: { tokens: 20_000 },
      used: { tokens: 2_000 },
    });
    expect(parsePersistedRunBudgetStateV1({
      ...state,
      limits: { ...state.limits, tokens: "[redacted]" },
    })).toBeUndefined();
  });

  it("recognizes native and connector browser operations without counting web search", () => {
    expect(isBrowserActionTool({ id: "browser.click" })).toBe(true);
    expect(isBrowserActionTool({ id: "mcp:playwright:browser_fill_form" })).toBe(true);
    expect(isBrowserActionTool({ id: "web.search", category: "web" })).toBe(false);
  });

  it("keeps every model turn inside the run budget after fixed context costs", () => {
    let state = createRunBudgetState({
      ...limits,
      modelTurns: 13,
      tokens: 64_000,
      costMicrousd: 2_500_000,
    });
    state = reserveRunBudget(state, { tokens: 4_096, costMicrousd: 1_000 });

    for (let turn = 0; turn < 13; turn += 1) {
      state = reserveRunBudget(state, {
        modelTurns: 1,
        tokens: budgetPerRemainingModelTurn(state, "tokens"),
        costMicrousd: budgetPerRemainingModelTurn(state, "costMicrousd"),
      });
    }

    expect(state.used.modelTurns).toBe(13);
    expect(state.used.tokens).toBe(64_000);
    expect(state.used.costMicrousd).toBe(2_500_000);
  });
});

describe("model turn estimates and settlement", () => {
  const startedAt = "2026-09-29T00:00:00.000Z";
  const now = Date.parse(startedAt);
  const fresh = (used: Partial<typeof limits> = {}) =>
    createRunBudgetState(limits, { startedAt, used });
  const estimate = {
    tokens: 3_000,
    costMicrousd: 50_000,
    followUpTokens: 6_000,
    followUpCostMicrousd: 90_000,
  };

  it("counts keys and values at four characters a token and each image at a fixed allowance", () => {
    expect(estimateModelInputTokens("abcd".repeat(10))).toBe(10);
    // "ab" "cdef" "n" "12345" "ok" "true" "big" "1000" "none": 29 characters.
    expect(estimateModelInputTokens({
      ab: "cdef",
      n: 12_345,
      ok: true,
      big: BigInt(1_000),
      none: null,
    })).toBe(Math.ceil(29 / 4));
    expect(estimateModelInputTokens([
      "data:image/png;base64,".padEnd(40_000, "A"),
      { dataBase64: "B".repeat(40_000) },
      new Uint8Array(40_000),
      new ArrayBuffer(8),
    ])).toBe(4 * 1_600 + Math.ceil(10 / 4));
    expect(ESTIMATED_IMAGE_INPUT_TOKENS).toBe(1_600);
    expect(estimateModelInputTokens("data:text/plain;base64,QUJD")).toBe(7);
  });

  it("counts a shared value each time it is sent and stops at cycles and depth", () => {
    const shared = { v: "abcdefgh" };
    expect(estimateModelInputTokens([shared, shared])).toBe(Math.ceil(18 / 4));
    const cyclic: Record<string, unknown> = { k: "abcd" };
    cyclic.self = cyclic;
    expect(estimateModelInputTokens(cyclic)).toBe(Math.ceil(9 / 4));
    const nest = (levels: number) => {
      let value: unknown = "abcdefgh";
      for (let level = 0; level < levels; level += 1) value = [value];
      return value;
    };
    expect(estimateModelInputTokens(nest(64))).toBe(2);
    expect(estimateModelInputTokens(nest(65))).toBe(0);
  });

  it("reserves a turn at its estimate with one retry while retries remain", () => {
    const plan = planModelTurnBudget(fresh(), {
      estimate,
      toolsEnabled: true,
      now,
    });
    expect(plan).toMatchObject({
      reserved: { tokens: 3_000, costMicrousd: 50_000, retries: 1 },
      maxAttempts: 2,
      finalTurn: false,
    });
    expect(plan.state.used).toMatchObject({
      modelTurns: 1,
      tokens: 3_000,
      costMicrousd: 50_000,
      retries: 1,
    });
    expect(planModelTurnBudget(fresh(), {
      estimate,
      toolsEnabled: true,
      allowRetry: false,
      now,
    })).toMatchObject({ maxAttempts: 1, reserved: { retries: 0 } });
    expect(planModelTurnBudget(fresh({ retries: 2 }), {
      estimate,
      toolsEnabled: true,
      now,
    })).toMatchObject({ maxAttempts: 1, reserved: { retries: 0 } });
  });

  it("makes a tool turn final when the run has no room for a turn after its results", () => {
    const plan = (used: Partial<typeof limits>, toolsEnabled = true) =>
      planModelTurnBudget(fresh(used), { estimate, toolsEnabled, now }).finalTurn;
    expect(plan({ modelTurns: 2 })).toBe(false);
    expect(plan({ modelTurns: 3 })).toBe(true);
    // 20,000 - 11,000 - 3,000 leaves exactly the 6,000 follow-up tokens.
    expect(plan({ tokens: 11_000 })).toBe(false);
    expect(plan({ tokens: 11_001 })).toBe(true);
    // 500,000 - 360,000 - 50,000 leaves exactly the 90,000 follow-up cost.
    expect(plan({ costMicrousd: 360_000 })).toBe(false);
    expect(plan({ costMicrousd: 360_001 })).toBe(true);
    expect(plan({ modelTurns: 3, tokens: 11_001 }, false)).toBe(false);
  });

  it("checks the workspace's window after the run's own limits", () => {
    const ceiling = (tokensUsed: number, costUsed = 0) => ({
      tokens: { limit: 100_000, used: tokensUsed },
      costMicrousd: { limit: 1_000_000, used: costUsed },
    });
    const plan = (
      state: ReturnType<typeof fresh>,
      window: ReturnType<typeof ceiling>,
    ) => planModelTurnBudget(state, {
      estimate,
      toolsEnabled: true,
      ceiling: window,
      now,
    });
    expect(plan(fresh(), ceiling(91_000)).finalTurn).toBe(false);
    expect(plan(fresh(), ceiling(91_001)).finalTurn).toBe(true);
    expect(plan(fresh(), ceiling(0, 860_000)).finalTurn).toBe(false);
    expect(plan(fresh(), ceiling(0, 860_001)).finalTurn).toBe(true);
    expect(plan(fresh(), ceiling(97_000)).state.used.tokens).toBe(3_000);

    let error: unknown;
    try {
      plan(fresh(), ceiling(97_001));
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TenantDailyBudgetExceededError);
    expect(error).toBeInstanceOf(RunBudgetExceededError);
    expect(error).toMatchObject({
      name: "TenantDailyBudgetExceededError",
      code: "run_budget_exhausted",
      dimension: "tokens",
      limit: 100_000,
      attempted: 100_001,
      message:
        "The workspace's token budget for the last 24 hours is exhausted "
        + "(100001 requested, limit 100000).",
    });
    expect(() => plan(fresh(), ceiling(0, 950_001))).toThrow(
      "The workspace's cost budget for the last 24 hours is exhausted "
        + "(1000001 requested, limit 1000000).",
    );

    let runError: unknown;
    try {
      plan(fresh({ tokens: 17_001 }), ceiling(97_001));
    } catch (caught) {
      runError = caught;
    }
    expect(runError).toBeInstanceOf(RunBudgetExceededError);
    expect(runError).not.toBeInstanceOf(TenantDailyBudgetExceededError);
    expect((runError as Error).message).toBe(
      "Run token budget is exhausted (20001 requested, limit 20000).",
    );
  });

  it("replaces a turn's reservation with what it spent", () => {
    const plan = planModelTurnBudget(fresh({ tokens: 4_000, costMicrousd: 1_000 }), {
      estimate,
      toolsEnabled: true,
      now,
    });
    expect(settleModelTurnBudget(plan.state, plan.reserved, {
      tokens: 1_234,
      costMicrousd: 20_000.2,
      retries: 0,
    }).used).toMatchObject({
      modelTurns: 1,
      tokens: 5_234,
      costMicrousd: 21_001,
      retries: 0,
    });
    // A measure the provider did not report keeps its reservation, and a
    // retry the turn made stays charged.
    expect(settleModelTurnBudget(plan.state, plan.reserved, {
      costMicrousd: Number.NaN,
      retries: 3,
    }).used).toMatchObject({ tokens: 7_000, costMicrousd: 51_000, retries: 1 });

    const over = settleModelTurnBudget(plan.state, plan.reserved, {
      tokens: 25_000,
      costMicrousd: -5,
      retries: 1,
    });
    expect(over.used).toMatchObject({
      tokens: 29_000,
      costMicrousd: 1_000,
      retries: 1,
    });
    expect(remainingRunBudget(over, now).tokens).toBe(0);
    expect(() => planModelTurnBudget(over, {
      estimate,
      toolsEnabled: false,
      now,
    })).toThrow("Run token budget is exhausted (32000 requested, limit 20000).");
    expect(settleModelTurnBudget(plan.state, plan.reserved, {
      tokens: 5e12,
      retries: 0,
    }).used.tokens).toBe(1_000_000_000_000);
  });
});
