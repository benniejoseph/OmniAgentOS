import { afterEach, describe, expect, it } from "vitest";
import { computeAutonomy, graduationThreshold } from "@/lib/trust/policy";

afterEach(() => {
  delete process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD;
});

describe("computeAutonomy", () => {
  it("never graduates irreversible actions", () => {
    const decision = computeAutonomy({ cleanStreak: 9999, reversible: false, riskLevel: 1 });
    expect(decision.mode).toBe("approve_each");
    expect(decision.stage).toBe("manual");
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
    expect(decision.stage).toBe("supervised");
    expect(decision.eligible).toBe(true);
    expect(decision.progress).toBeCloseTo(0.4, 5);
  });

  it("graduates a reversible action at or above threshold", () => {
    process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD = "10";
    const decision = computeAutonomy({ cleanStreak: 10, reversible: true, riskLevel: 2 });
    expect(decision.mode).toBe("auto_with_alert");
    expect(decision.stage).toBe("autonomous");
    expect(decision.progress).toBe(1);
    expect(decision.budget).toEqual({ maxActions: 3, windowSeconds: 3600 });
  });

  it("demotes stale evidence until fresh supervised outcomes arrive", () => {
    const decision = computeAutonomy({
      cleanStreak: 40,
      total: 40,
      successes: 40,
      reversible: true,
      riskLevel: 1,
      lastOutcomeAt: "2025-01-01T00:00:00.000Z",
    }, new Date("2026-01-01T00:00:00.000Z"));
    expect(decision.mode).toBe("approve_each");
    expect(decision.stage).not.toBe("autonomous");
    expect(decision.freshness).toBeLessThan(0.5);
  });

  it("weights failures enough to prevent streak-only promotion", () => {
    const decision = computeAutonomy({
      cleanStreak: 10,
      total: 15,
      successes: 14,
      failures: 1,
      reversible: true,
      riskLevel: 1,
      lastOutcomeAt: "2026-01-10T00:00:00.000Z",
      lastFailureAt: "2026-01-01T00:00:00.000Z",
    }, new Date("2026-01-10T00:00:01.000Z"));
    expect(decision.score).toBeLessThan(0.7);
    expect(decision.mode).toBe("approve_each");
  });

  it("defaults the threshold to 25", () => {
    expect(graduationThreshold()).toBe(25);
  });
});
