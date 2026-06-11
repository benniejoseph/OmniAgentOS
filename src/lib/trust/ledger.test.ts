import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyOutcome } from "@/lib/trust/ledger";
import type { ActionOutcome, TrustProfile } from "@/lib/trust/types";

beforeEach(() => {
  process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD = "3";
});

afterEach(() => {
  delete process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD;
});

function profile(): TrustProfile {
  return {
    actionClass: "memory.write",
    toolId: "memory.write",
    tenantId: "default",
    riskLevel: 2,
    reversible: true,
    total: 0,
    successes: 0,
    failures: 0,
    rejections: 0,
    humanApprovals: 0,
    cleanStreak: 0,
    autonomyMode: "approve_each",
    updatedAt: new Date().toISOString(),
  };
}

function outcome(kind: ActionOutcome["kind"], overrides: Partial<ActionOutcome> = {}): ActionOutcome {
  return {
    actionClass: "memory.write",
    toolId: "memory.write",
    tenantId: "default",
    kind,
    reversible: true,
    riskLevel: 2,
    humanApproved: true,
    at: new Date().toISOString(),
    ...overrides,
  };
}

describe("applyOutcome", () => {
  it("graduates after enough consecutive successes", () => {
    let current = profile();
    current = applyOutcome(current, outcome("success"));
    current = applyOutcome(current, outcome("success"));
    expect(current.autonomyMode).toBe("approve_each");
    current = applyOutcome(current, outcome("success"));
    expect(current.cleanStreak).toBe(3);
    expect(current.autonomyMode).toBe("auto_with_alert");
    expect(current.successes).toBe(3);
  });

  it("resets the clean streak (and de-graduates) on failure", () => {
    let current = profile();
    for (let i = 0; i < 3; i += 1) {
      current = applyOutcome(current, outcome("success"));
    }
    expect(current.autonomyMode).toBe("auto_with_alert");
    current = applyOutcome(current, outcome("failure"));
    expect(current.cleanStreak).toBe(0);
    expect(current.autonomyMode).toBe("approve_each");
    expect(current.failures).toBe(1);
  });

  it("resets the clean streak on human rejection", () => {
    let current = profile();
    current = applyOutcome(current, outcome("success"));
    current = applyOutcome(current, outcome("rejected"));
    expect(current.cleanStreak).toBe(0);
    expect(current.rejections).toBe(1);
  });

  it("never graduates an irreversible action class", () => {
    let current = { ...profile(), reversible: false };
    for (let i = 0; i < 10; i += 1) {
      current = applyOutcome(current, outcome("success", { reversible: false }));
    }
    expect(current.autonomyMode).toBe("approve_each");
  });
});
