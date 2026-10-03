import { describe, expect, it } from "vitest";
import { PILOT_CHECK_RESERVATION, reserveResponsibilityBudget, settleResponsibilityBudget, verifyCumulativeBudget, zeroResponsibilityBudget } from "./cumulative-budget";
import { runtimeHead } from "./runtime-test-fixtures";

describe("Responsibility cumulative budget", () => {
  it("reserves the whole check before dispatch and refuses a concurrent over-limit admission", () => {
    const budget = { ...runtimeHead.budget, maximumChecks: 1, limits: PILOT_CHECK_RESERVATION };
    const reserved = reserveResponsibilityBudget(budget, PILOT_CHECK_RESERVATION);
    expect(reserved).toMatchObject({ reserved: PILOT_CHECK_RESERVATION, usedChecks: 0, reservedChecks: 1 });
    expect(() => reserveResponsibilityBudget(reserved, PILOT_CHECK_RESERVATION)).toThrow(/limit is exhausted/);
  });
  it("does not treat a timeout or process death as free capacity", () => {
    const reserved = reserveResponsibilityBudget(runtimeHead.budget, PILOT_CHECK_RESERVATION);
    expect(settleResponsibilityBudget(reserved, PILOT_CHECK_RESERVATION, { kind: "uncertain_started" })).toEqual(reserved);
    const terminal = settleResponsibilityBudget(reserved, PILOT_CHECK_RESERVATION, { kind: "terminal", charged: PILOT_CHECK_RESERVATION });
    expect(terminal).toMatchObject({ used: PILOT_CHECK_RESERVATION, reserved: zeroResponsibilityBudget(), usedChecks: 1, reservedChecks: 0 });
    expect(() => settleResponsibilityBudget(terminal, PILOT_CHECK_RESERVATION, { kind: "unstarted" })).toThrow();
  });
  it("releases only proven unstarted work and rejects impossible or understated bounds", () => {
    const reserved = reserveResponsibilityBudget(runtimeHead.budget, PILOT_CHECK_RESERVATION);
    expect(settleResponsibilityBudget(reserved, PILOT_CHECK_RESERVATION, { kind: "unstarted" })).toEqual(runtimeHead.budget);
    expect(() => settleResponsibilityBudget(reserved, PILOT_CHECK_RESERVATION, { kind: "terminal", charged: { ...PILOT_CHECK_RESERVATION, toolCalls: 2 } })).toThrow(/exceeds/);
    expect(() => verifyCumulativeBudget({ ...reserved, limits: zeroResponsibilityBudget() })).toThrow();
  });
});
