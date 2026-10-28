import { describe, expect, it } from "vitest";
import { initialSelfImprovementRuntime, selfImprovementRuntimeSchema } from "./runtime";
import { selfImprovementPhaseTimeoutMs } from "./phase-deadline";

const plan = { summary: "Synthetic check", sourcePaths: ["src/example.ts"], focusedTestPaths: ["src/example.test.ts"],
  adjacentTestPaths: ["src/neighbor.test.ts"], acceptanceCriteria: ["Keep the control valid."] };
const lint = { executionId: "lint", command: "lint_focused", paths: plan.focusedTestPaths, outputSha256: "a".repeat(64),
  workspaceSha256: "b".repeat(64), exitCode: 0, totalTests: 0, passedTests: 0, failedTests: 0, completedAt: "2026-10-28T08:00:00.000Z" };
const runtime = (phase: "baseline_check" | "verify") => selfImprovementRuntimeSchema.parse({ ...initialSelfImprovementRuntime(), phase, plan,
  preparations: [{ attempt: 0, accepted: false, workspaceSha256: lint.workspaceSha256, testHashes: { [plan.focusedTestPaths[0]]: "c".repeat(64) },
    checks: [{ evidence: lint, output: "", reportComplete: true }] }], checks: [lint] });

describe("the bounded self-improvement compiler phase", () => {
  it.each(["baseline_check", "verify"] as const)("allows 270s only for the next persisted %s typecheck", phase => {
    const value = runtime(phase);
    expect(selfImprovementPhaseTimeoutMs(value)).toBe(270_000);
    if (phase === "baseline_check") value.preparations![0].checks = [];
    else value.checks = [];
    expect(selfImprovementPhaseTimeoutMs(value)).toBe(240_000);
  });
  it("does not extend models, tests, completed preparation, malformed history or native work", () => {
    const value = runtime("baseline_check");
    for (const changed of [
      { ...value, phase: "implement" }, { ...value, plan: null }, { ...value, phase: "unknown" },
      { ...value, phaseAttempt: { key: "reproduce:0", phase: "reproduce", startedAt: lint.completedAt, costCeilingUsd: 2 } },
      { ...value, preparations: [{ ...value.preparations![0], accepted: true }] },
      { ...value, preparations: [{ ...value.preparations![0], checks: [...value.preparations![0].checks, { evidence: { ...lint, command: "typecheck_direct", paths: [] }, output: "", reportComplete: true }] }] },
      { ...value, plan: { ...value.plan, releaseTarget: "macos_app" } },
    ]) {
      const parsed = selfImprovementRuntimeSchema.safeParse(changed);
      expect(selfImprovementPhaseTimeoutMs(parsed.success ? parsed.data : undefined)).toBe(240_000);
    }
    expect(selfImprovementPhaseTimeoutMs(undefined)).toBe(240_000);
  });
});
