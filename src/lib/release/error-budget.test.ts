import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasDatabaseUrl: vi.fn(),
  ensureDatabaseSchema: vi.fn(),
  query: vi.fn(),
  systemScopeReasons: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({
  hasDatabaseUrl: mocks.hasDatabaseUrl,
  ensureDatabaseSchema: mocks.ensureDatabaseSchema,
  getSql: () => ({ query: mocks.query }),
  runWithDatabaseSystemScope: async <T>(reason: string, operation: () => Promise<T>) => {
    mocks.systemScopeReasons.push(reason);
    return operation();
  },
}));

import {
  errorBudgetGate,
  evaluateErrorBudget,
  getReleaseErrorBudget,
  normalizeErrorBudgetException,
  type ErrorBudgetObjectiveReport,
  type ErrorBudgetReport,
} from "@/lib/release/error-budget";

const RUNS = { id: "agent_runs", budgetPercent: 5 } as const;
const TOOLS = { id: "tool_calls", budgetPercent: 10 } as const;

function counts(week: [number, number], day: [number, number]) {
  return {
    week: { finished: week[0], failed: week[1] },
    day: { finished: day[0], failed: day[1] },
  };
}

function report(...objectives: Array<Partial<ErrorBudgetObjectiveReport>>): ErrorBudgetReport {
  return {
    checkedAt: "2026-10-01T12:00:00.000Z",
    measured: true,
    objectives: objectives.map((objective) => ({
      id: "agent_runs",
      objective: 0.95,
      verdict: "within",
      budgetSpent: 0,
      burnRate: 0,
      ...objective,
    })),
  };
}

afterEach(() => {
  vi.clearAllMocks();
  mocks.systemScopeReasons.length = 0;
});

describe("error budget", () => {
  it("judges a week only once enough work finished", () => {
    expect(evaluateErrorBudget(RUNS, counts([19, 19], [19, 19]))).toEqual({
      id: "agent_runs",
      objective: 0.95,
      verdict: "insufficient",
      successRate: 0,
      budgetSpent: 20,
      burnRate: 20,
    });
    expect(evaluateErrorBudget(RUNS, counts([20, 0], [5, 0]))).toEqual({
      id: "agent_runs",
      objective: 0.95,
      verdict: "within",
      successRate: 1,
      budgetSpent: 0,
      burnRate: 0,
    });
    // Nothing finished: no success rate to report.
    expect(evaluateErrorBudget(TOOLS, counts([0, 0], [0, 0]))).toEqual({
      id: "tool_calls",
      objective: 0.9,
      verdict: "insufficient",
      budgetSpent: 0,
      burnRate: 0,
    });
  });

  it("spends the budget at exactly its share of failures", () => {
    // One in twenty is five percent: the whole budget.
    expect(evaluateErrorBudget(RUNS, counts([20, 1], [20, 1]))).toMatchObject({
      verdict: "exhausted",
      successRate: 0.95,
      budgetSpent: 1,
      burnRate: 1,
    });
    expect(evaluateErrorBudget(RUNS, counts([21, 1], [21, 1]))).toMatchObject({
      verdict: "within",
      budgetSpent: 0.9524,
      burnRate: 0.9524,
    });
    expect(evaluateErrorBudget(TOOLS, counts([20, 2], [10, 1])).verdict).toBe("exhausted");
    expect(evaluateErrorBudget(TOOLS, counts([20, 1], [10, 1])).verdict).toBe("within");
  });

  it("lets a spent week recover once the last day keeps to the objective", () => {
    expect(evaluateErrorBudget(RUNS, counts([30, 6], [21, 1]))).toEqual({
      id: "agent_runs",
      objective: 0.95,
      verdict: "recovering",
      successRate: 0.8,
      budgetSpent: 4,
      burnRate: 0.9524,
    });
    // A quiet day neither burns nor proves anything; the hold lifts.
    expect(evaluateErrorBudget(RUNS, counts([30, 6], [0, 0]))).toMatchObject({
      verdict: "recovering",
      burnRate: 0,
    });
    expect(evaluateErrorBudget(RUNS, counts([30, 6], [1, 1]))).toMatchObject({
      verdict: "exhausted",
      burnRate: 20,
    });
  });

  it("accepts one bounded line as an exception's reason", () => {
    expect(normalizeErrorBudgetException(undefined)).toBeUndefined();
    expect(normalizeErrorBudgetException(null)).toBeUndefined();
    expect(normalizeErrorBudgetException("   ")).toBeUndefined();
    expect(normalizeErrorBudgetException("  Ships the fix for failing runs.  "))
      .toBe("Ships the fix for failing runs.");
    expect(normalizeErrorBudgetException(` ${"a".repeat(200)} `)).toBe("a".repeat(200));
    expect(normalizeErrorBudgetException("a".repeat(201))).toBeNull();
    expect(normalizeErrorBudgetException("first line\nsecond line")).toBeNull();
    expect(normalizeErrorBudgetException("tab\tinside")).toBeNull();
    expect(normalizeErrorBudgetException("delete\u007f")).toBeNull();
  });

  it("holds the release while a spent budget still burns", () => {
    const exhausted = report(
      { id: "agent_runs", verdict: "exhausted", budgetSpent: 2, burnRate: 3 },
      { id: "tool_calls", objective: 0.9, verdict: "within" },
    );
    const gate = errorBudgetGate(exhausted);
    expect(gate).toEqual({
      id: "agent_error_budget",
      name: "Agent error budget",
      status: "fail",
      summary: "Agent runs have spent the week's error budget, and the last day still fails faster than the objective allows.",
      details: {
        windowDays: 7,
        burnWindowHours: 24,
        minimumSamples: 20,
        measured: true,
        objectives: exhausted.objectives,
      },
    });

    const both = errorBudgetGate(report(
      { id: "agent_runs", verdict: "exhausted" },
      { id: "tool_calls", verdict: "exhausted" },
    ));
    expect(both.summary).toBe(
      "Agent runs and tool calls have spent the week's error budget, and the last day still fails faster than the objective allows.",
    );
  });

  it("ships a held release under a named exception, and records it", () => {
    const gate = errorBudgetGate(
      report({ id: "agent_runs", verdict: "exhausted" }),
      "Ships the fix for failing runs.",
    );
    expect(gate.status).toBe("pass");
    expect(gate.summary).toBe(
      "Agent runs have spent the week's error budget, and the last day still fails faster than the objective allows. This release ships under a recorded exception.",
    );
    expect(gate.details.exception).toEqual({
      reason: "Ships the fix for failing runs.",
      applied: true,
    });

    // An exception with nothing to excuse is kept, but not applied.
    const unneeded = errorBudgetGate(report({ verdict: "within" }), "Just in case.");
    expect(unneeded.status).toBe("pass");
    expect(unneeded.summary).toBe("No error budget is spent this week.");
    expect(unneeded.details.exception).toEqual({ reason: "Just in case.", applied: false });
  });

  it("fails closed when the budget cannot be read", () => {
    const unread: ErrorBudgetReport = {
      checkedAt: "2026-10-01T12:00:00.000Z",
      measured: false,
      objectives: [],
    };
    expect(errorBudgetGate(unread)).toMatchObject({
      status: "fail",
      summary: "The agent error budget could not be read.",
      details: { measured: false },
    });
    expect(errorBudgetGate(unread, "The database is being restored.")).toMatchObject({
      status: "pass",
      details: { exception: { applied: true } },
    });
  });

  it("passes a recovering or unjudged budget and says which", () => {
    expect(errorBudgetGate(report(
      { id: "agent_runs", verdict: "recovering" },
      { id: "tool_calls", verdict: "within" },
    ))).toMatchObject({
      status: "pass",
      summary: "Agent runs have spent the week's error budget, but the last day is within the objective.",
    });
    expect(errorBudgetGate(report(
      { id: "agent_runs", verdict: "insufficient" },
      { id: "tool_calls", verdict: "insufficient" },
    ))).toMatchObject({
      status: "pass",
      summary: "Too little work finished this week to judge the error budget.",
    });
    expect(errorBudgetGate(report(
      { id: "agent_runs", verdict: "insufficient" },
      { id: "tool_calls", verdict: "within" },
    )).summary).toBe("No error budget is spent this week.");
  });

  it("counts a week and a day of finished work under the system scope", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(true);
    mocks.query.mockResolvedValue([{
      runs_week: 40,
      runs_week_failed: 4,
      runs_day: 10,
      runs_day_failed: 1,
      tools_week: 30,
      tools_week_failed: 1,
      tools_day: 12,
      tools_day_failed: 0,
    }]);
    const now = new Date("2026-10-01T12:00:00.000Z");

    const budget = await getReleaseErrorBudget(now);

    expect(mocks.ensureDatabaseSchema).toHaveBeenCalledTimes(1);
    expect(mocks.systemScopeReasons).toEqual([
      "Count finished agent runs and tool calls for the release error budget.",
    ]);
    expect(mocks.query).toHaveBeenCalledWith(expect.any(String), [
      new Date("2026-09-24T12:00:00.000Z"),
      new Date("2026-09-30T12:00:00.000Z"),
    ]);
    expect(budget).toEqual({
      checkedAt: "2026-10-01T12:00:00.000Z",
      measured: true,
      objectives: [
        evaluateErrorBudget(RUNS, counts([40, 4], [10, 1])),
        evaluateErrorBudget(TOOLS, counts([30, 1], [12, 0])),
      ],
    });
    expect(budget.objectives.map((objective) => objective.verdict))
      .toEqual(["exhausted", "within"]);
  });

  it("finds nothing to judge without a database, and fails closed on a read error", async () => {
    mocks.hasDatabaseUrl.mockReturnValue(false);
    const empty = await getReleaseErrorBudget(new Date("2026-10-01T12:00:00.000Z"));
    expect(empty.measured).toBe(true);
    expect(empty.objectives.map((objective) => objective.verdict))
      .toEqual(["insufficient", "insufficient"]);
    expect(mocks.query).not.toHaveBeenCalled();

    mocks.hasDatabaseUrl.mockReturnValue(true);
    mocks.query.mockRejectedValue(new Error("connection refused"));
    await expect(getReleaseErrorBudget(new Date("2026-10-01T12:00:00.000Z"))).resolves.toEqual({
      checkedAt: "2026-10-01T12:00:00.000Z",
      measured: false,
      objectives: [],
    });
  });
});
