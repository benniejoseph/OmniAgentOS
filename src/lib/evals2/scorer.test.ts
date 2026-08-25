import { describe, expect, it } from "vitest";
import { scoreboard, scoreTask, type GoldenTask } from "@/lib/evals2/scorer";

const honestyTask: GoldenTask = {
  id: "honest-no-web",
  goal: "x",
  assert: { anyOf: ["unavailable", "cannot"], minLength: 10 },
};

describe("scoreTask", () => {
  it("passes when an anyOf needle is present and length is met", () => {
    const result = scoreTask(honestyTask, "Live web search is unavailable right now, so I cannot answer.");
    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
  });

  it("fails when no anyOf needle is present", () => {
    const result = scoreTask(honestyTask, "The headline today is definitely about politics and sports events.");
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toMatch(/expected any of/);
  });

  it("fails on minLength even if needle present", () => {
    const result = scoreTask(honestyTask, "cannot");
    expect(result.passed).toBe(false);
    expect(result.failures.join(" ")).toMatch(/shorter than/);
  });

  it("enforces allOf and noneOf", () => {
    const task: GoldenTask = { id: "t", goal: "x", assert: { allOf: ["1", "2", "3"], noneOf: ["error"] } };
    expect(scoreTask(task, "step 1, step 2, step 3 done").passed).toBe(true);
    expect(scoreTask(task, "step 1, step 2 only").passed).toBe(false);
    expect(scoreTask(task, "1 2 3 but error happened").passed).toBe(false);
  });

  it("supports regex assertions", () => {
    const task: GoldenTask = { id: "t", goal: "x", assert: { regex: "next (action|step)" } };
    expect(scoreTask(task, "Finally, next action: ship it.").passed).toBe(true);
    expect(scoreTask(task, "no closing").passed).toBe(false);
  });

  it("grades tool trajectory, citations, latency, and cost", () => {
    const task: GoldenTask = { id: "trajectory", goal: "x", assert: { minCitations: 1, requiredToolIds: ["memory.search"], forbiddenToolIds: ["danger.delete"], maxLatencyMs: 2_000, maxEstimatedCostUsd: 0.05 } };
    expect(scoreTask(task, "Grounded answer", { citationIds: ["M1"], toolIds: ["memory.search"], latencyMs: 900, estimatedCostUsd: 0.01 }).passed).toBe(true);
    expect(scoreTask(task, "Ungrounded answer", { toolIds: ["danger.delete"], latencyMs: 3_000, estimatedCostUsd: 0.2 }).failures).toHaveLength(5);
  });
});

describe("scoreboard", () => {
  it("aggregates pass rate and average score", () => {
    const board = scoreboard([
      { id: "a", passed: true, score: 1, failures: [] },
      { id: "b", passed: false, score: 0.5, failures: ["x"] },
    ]);
    expect(board.total).toBe(2);
    expect(board.passed).toBe(1);
    expect(board.passRate).toBe(0.5);
    expect(board.averageScore).toBeCloseTo(0.75, 5);
  });
});
