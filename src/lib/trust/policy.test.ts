import { afterEach, describe, expect, it } from "vitest";
import { computeAutonomy, graduationThreshold } from "@/lib/trust/policy";

afterEach(() => {
  delete process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD;
});

describe("computeAutonomy", () => {
  it("never graduates irreversible actions", () => {
    const decision = computeAutonomy({ cleanStreak: 9999, reversible: false, riskLevel: 1 });
    expect(decision.mode).toBe("approve_each");
    expect(decision.eligible).toBe(false);
  });

  it("never graduates risk 3 actions", () => {
    const decision = computeAutonomy({ cleanStreak: 9999, reversible: true, riskLevel: 3 });
    expect(decision.mode).toBe("approve_each");
    expect(decision.eligible).toBe(false);
  });

  it("gates a reversible action below threshold and reports progress", () => {
    process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD = "10";
    const decision = computeAutonomy({ cleanStreak: 4, reversible: true, riskLevel: 2 });
    expect(decision.mode).toBe("approve_each");
    expect(decision.eligible).toBe(true);
    expect(decision.progress).toBeCloseTo(0.4, 5);
  });

  it("graduates a reversible action at or above threshold", () => {
    process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD = "10";
    const decision = computeAutonomy({ cleanStreak: 10, reversible: true, riskLevel: 2 });
    expect(decision.mode).toBe("auto_with_alert");
    expect(decision.progress).toBe(1);
  });

  it("defaults the threshold to 25", () => {
    expect(graduationThreshold()).toBe(25);
  });
});
