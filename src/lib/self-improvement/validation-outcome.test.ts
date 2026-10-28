import { describe, expect, it } from "vitest";
import { improvementPlanSchema, improvementPreparationSchema } from "./runtime";
import { assessImprovementPreparation, incompleteStaticCheck } from "./validation-outcome";

const plan = improvementPlanSchema.parse({ summary: "Synthetic capacity regression", sourcePaths: ["src/example.ts"],
  focusedTestPaths: ["src/example.test.ts"], adjacentTestPaths: ["src/neighbor.test.ts"], acceptanceCriteria: ["Preserve valid controls and reject the invalid boundary."] });
const preparation = () => improvementPreparationSchema.parse({ attempt: 1, accepted: false, workspaceSha256: "a".repeat(64),
  testHashes: { "src/example.test.ts": "b".repeat(64) }, checks: ["lint_focused", "typecheck_direct", "test_focused"].map((command, index) => ({
    evidence: { command, executionId: `execution-${index}`, paths: index === 1 ? [] : plan.focusedTestPaths,
      outputSha256: "c".repeat(64), workspaceSha256: "a".repeat(64), completedAt: "2026-10-28T07:44:57.070Z",
      exitCode: index === 2 ? 1 : 0, totalTests: index === 2 ? 4 : 0, passedTests: index === 2 ? 3 : 0,
      failedTests: index === 2 ? 1 : 0, pendingTests: 0, executedPaths: index === 2 ? plan.focusedTestPaths : [] },
    output: index === 2 ? "Three relevant controls passed; the target regression failed." : "", reportComplete: true,
  })) });

describe("self-improvement static check completion", () => {
  it("retains the captured corrected three-control/one-regression shape without blaming its tests for exit137", () => {
    const value = preparation(); value.checks[1].evidence.exitCode = 137;
    value.checks[1].output = "Generating route types...\nTypes generated successfully\n";
    const before = structuredClone(value);
    expect(assessImprovementPreparation(value, plan)).toEqual({ outcome: "static_check_incomplete", check: value.checks[1].evidence });
    expect(value).toEqual(before);
  });
  it("accepts the same valid red baseline only after static checks complete successfully", () => {
    expect(assessImprovementPreparation(preparation(), plan)).toEqual({ outcome: "accepted" });
  });
  it("does not treat an explicitly incomplete static report as an actionable test failure", () => {
    const value = preparation(); value.checks[1].reportComplete = false;
    expect(assessImprovementPreparation(value, plan)).toEqual({ outcome: "static_check_incomplete", check: value.checks[1].evidence });
  });
  it.each(["type_diagnostic", "invalid_control"])("keeps completed %s failures actionable within the existing correction", kind => {
    const value = preparation();
    if (kind === "type_diagnostic") value.checks[1].evidence.exitCode = 2;
    else { value.checks[2].evidence.passedTests = 0; value.checks[2].evidence.failedTests = 4; }
    expect(assessImprovementPreparation(value, plan)).toEqual({ outcome: "invalid" });
  });
  it.each([137, 143, -9])("treats static termination exit%s as incomplete without naming a termination cause", exitCode => {
    const check = { command: "macos_analyze", exitCode };
    expect(incompleteStaticCheck([check])).toBe(check);
  });
  it("does not reinterpret test outcomes or ordinary compiler diagnostics as static interruption", () => {
    expect(incompleteStaticCheck([{ command: "test_focused", exitCode: 1 }, { command: "typecheck_direct", exitCode: 2 }])).toBeUndefined();
  });
});
