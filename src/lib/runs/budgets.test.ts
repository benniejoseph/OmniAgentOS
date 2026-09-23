import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_AGENT_RUN_BUDGET_LIMITS,
  RunBudgetExceededError,
  budgetPerRemainingModelTurn,
  createRunBudgetState,
  isBrowserActionTool,
  narrowRunBudgetLimits,
  parsePersistedRunBudgetStateV1,
  remainingRunBudget,
  reserveRunBudget,
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
      modelTurns: 13,
      toolCalls: 30,
    });
    expect(() => narrowRunBudgetLimits(DEFAULT_AGENT_RUN_BUDGET_LIMITS, {
      modelTurns: DEFAULT_AGENT_RUN_BUDGET_LIMITS.modelTurns + 1,
    })).toThrow("cannot exceed its parent limit");
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
