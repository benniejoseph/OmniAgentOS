import { describe, expect, it } from "vitest";
import { initialSelfImprovementRuntime, improvementPlanSchema, improvementInspectionSchema, parseImprovementAgentJson, reserveImprovementPhase } from "./runtime";

describe("improvement phase admission", () => {
  it("reserves before work, rejects interrupted replay and preserves release allowance", () => {
    let state = initialSelfImprovementRuntime();
    const first = reserveImprovementPhase(state, 100, "inspect", new Date().toISOString());
    expect(first.reservedModelUsd).toBe(10);
    expect(() => reserveImprovementPhase(first, 100, "inspect", new Date().toISOString())).toThrow("reconciliation");
    for (const phase of ["inspect", "reproduce", "implement", "review", "implement", "review"] as const) {
      state = reserveImprovementPhase(state, 100, phase, new Date().toISOString()); state = { ...state, phaseAttempt: null };
    }
    expect(state.reservedModelUsd).toBe(90);
    expect(() => reserveImprovementPhase(state, 100, "review", new Date().toISOString())).toThrow("reservation");
  });
  it("requires exact distinct test targets and a bounded JSON conclusion", () => {
    const plan = { summary: "Fix date rendering", sourcePaths: ["src/date.ts"], focusedTestPaths: ["src/date.test.ts"], adjacentTestPaths: ["src/calendar.test.ts"], acceptanceCriteria: ["Show local date"] };
    expect(improvementPlanSchema.parse(plan).newSourcePaths).toEqual([]);
    expect(() => improvementPlanSchema.parse({ ...plan, adjacentTestPaths: plan.focusedTestPaths })).toThrow();
    expect(() => improvementPlanSchema.parse({ ...plan, focusedTestPaths: ["../escape.test.ts"] })).toThrow();
    expect(parseImprovementAgentJson('{"decision":"no_change","summary":"No reproduced defect"}', improvementInspectionSchema).decision).toBe("no_change");
    expect(() => parseImprovementAgentJson('Done! {"decision":"no_change"}', improvementInspectionSchema)).toThrow();
  });
});
