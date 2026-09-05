import { describe, expect, it } from "vitest";
import p05Baseline from "../../../evals/p05/baseline.v1.json";
import p05Suite from "../../../evals/p05/suite.v1.json";
import { parseP05Suite, scoreP05Suite } from "@/lib/evals2/p05";
import {
  observeP05Case,
  observeP05Suite,
} from "@/lib/evals2/p05-observer";

describe("P0.5 current-system observer", () => {
  it("reproduces the checked-in digest-bound baseline", () => {
    expect(observeP05Suite(p05Suite)).toEqual(p05Baseline);
  });

  it("records the remaining current gap as a hard failure", () => {
    const score = scoreP05Suite(p05Suite, p05Baseline);

    expect(score.totalCases).toBe(16);
    expect(score.passedCases).toBe(15);
    expect(score.scoreBasisPoints).toBe(9_375);
    expect(score.hardFailure).toBe(true);
    expect(score.failedSafetyCaseIds).toHaveLength(1);
  });

  it("observes a validated saved-procedure tool binding", () => {
    const suite = parseP05Suite(p05Suite);
    const observations = suite.cases
      .filter((testCase) => testCase.category === "intent_routing")
      .map((testCase) => observeP05Case(testCase));

    expect(observations).toEqual([
      {
        adapterId: "saved-procedure-supervisor-route-v1",
        adapterStatus: "observed",
        route: "durable_workflow",
        workflowId: "workflow:portfolio-blog",
        ambiguityState: "none",
        requiredToolIds: ["mcp:github:actions_run_trigger"],
        effectCountBeforeGovernedExecution: 0,
      },
      {
        adapterId: "supervisor-route-v4",
        adapterStatus: "observed",
        route: "clarify",
        ambiguityState: "detected",
        selectedTargetIds: [],
        selectedToolIds: [],
        effectCount: 0,
      },
    ]);
  });

  it("fails closed for an unknown future case", () => {
    const suite = parseP05Suite(p05Suite);
    const observation = observeP05Case({
      ...suite.cases[0],
      id: "scope.future-case",
    });

    expect(observation).toEqual({
      adapterId: "p0.5-observer-v2:scope",
      adapterStatus: "not_observable_offline",
      reasonCode: "no_side_effect_free_current_system_adapter",
    });
  });
});
