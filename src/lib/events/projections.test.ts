import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldTrustProfile } from "@/lib/events/projections";
import type { DomainEvent } from "@/lib/events/store";

beforeEach(() => {
  process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD = "3";
});

afterEach(() => {
  delete process.env.OMNIAGENT_AUTONOMY_GRADUATION_THRESHOLD;
});

function outcomeEvent(seq: number, kind: string, overrides: Partial<DomainEvent["payload"]> = {}): DomainEvent {
  return {
    id: `e${seq}`,
    seq,
    streamId: "trust:demo.tool",
    type: `trust.outcome.${kind}`,
    tenantId: "default",
    actorId: "system",
    payload: { toolId: "demo.tool", reversible: true, riskLevel: 2, humanApproved: true, ...overrides },
    at: new Date(1700000000000 + seq * 1000).toISOString(),
  };
}

describe("foldTrustProfile", () => {
  it("returns undefined for an empty stream", () => {
    expect(foldTrustProfile([], { actionClass: "demo.tool", tenantId: "default" })).toBeUndefined();
  });

  it("rebuilds counters, streak, and autonomy mode from events", () => {
    const events = [
      outcomeEvent(1, "success"),
      outcomeEvent(2, "success"),
      outcomeEvent(3, "failure"),
      outcomeEvent(4, "success"),
      outcomeEvent(5, "success"),
      outcomeEvent(6, "success"),
    ];
    const profile = foldTrustProfile(events, { actionClass: "demo.tool", tenantId: "default" });
    expect(profile).toMatchObject({
      total: 6,
      successes: 5,
      failures: 1,
      cleanStreak: 3,
      autonomyMode: "auto_with_alert",
    });
  });

  it("folds out-of-order input deterministically by seq", () => {
    const events = [outcomeEvent(2, "failure"), outcomeEvent(1, "success"), outcomeEvent(3, "success")];
    const profile = foldTrustProfile(events, { actionClass: "demo.tool", tenantId: "default" });
    expect(profile?.cleanStreak).toBe(1);
    expect(profile?.total).toBe(3);
  });

  it("ignores non-outcome events in the stream", () => {
    const events = [
      outcomeEvent(1, "success"),
      { ...outcomeEvent(2, "success"), type: "trust.note" },
    ];
    const profile = foldTrustProfile(events, { actionClass: "demo.tool", tenantId: "default" });
    expect(profile?.total).toBe(1);
  });
});
