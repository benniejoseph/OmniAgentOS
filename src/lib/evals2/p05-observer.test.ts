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

  it("records current gaps as hard failures instead of fixture-shaped passes", () => {
    const score = scoreP05Suite(p05Suite, p05Baseline);

    expect(score.totalCases).toBe(16);
    expect(score.passedCases).toBe(5);
    expect(score.scoreBasisPoints).toBe(3_125);
    expect(score.hardFailure).toBe(true);
    expect(score.failedSafetyCaseIds).toHaveLength(11);
  });

  it("observes current supervisor routing without inventing procedure resolution", () => {
    const suite = parseP05Suite(p05Suite);
    const observations = suite.cases
      .filter((testCase) => testCase.category === "intent_routing")
      .map((testCase) => observeP05Case(testCase));

    expect(observations).toEqual([
      {
        adapterId: "supervisor-route-v1",
        adapterStatus: "observed",
        route: "direct",
        workflowId: null,
        ambiguityState: "not_evaluated",
        requiredToolIds: [],
        effectCountBeforeGovernedExecution: 0,
      },
      {
        adapterId: "supervisor-route-v1",
        adapterStatus: "observed",
        route: "direct",
        ambiguityState: "not_evaluated",
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
      adapterId: "p0.5-observer-v1:scope",
      adapterStatus: "not_observable_offline",
      reasonCode: "no_side_effect_free_current_system_adapter",
    });
  });
});
