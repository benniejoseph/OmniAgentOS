import { describe, expect, it } from "vitest";
import { evaluateTrajectoryOutcome } from "@/lib/trajectories/evaluate";
import type { RunTrajectory, TrajectoryVerification } from "@/lib/trajectories/types";

const verification: TrajectoryVerification = {
  valid: true,
  checks: { orderedEvents: true, terminalReceipt: true, usageTotals: true, toolReceipts: true },
  issues: [],
};

describe("trajectory outcome evaluation", () => {
  it("qualifies only verified owner-accepted outcomes for retention", () => {
    const result = evaluateTrajectoryOutcome(trajectory({ feedbackVerdict: "useful", groundingStatus: "verified" }), verification);
    expect(result).toMatchObject({ status: "pass", retentionEligible: true, score: 1 });
  });

  it("blocks retention after owner correction", () => {
    const result = evaluateTrajectoryOutcome(trajectory({ feedbackVerdict: "needs_work", groundingStatus: "verified" }), verification);
    expect(result.status).toBe("fail");
    expect(result.retentionEligible).toBe(false);
    expect(result.signals.join(" ")).toMatch(/needing work/i);
  });

  it("does not promote legacy trajectories without explicit grounding evidence", () => {
    const result = evaluateTrajectoryOutcome(
      trajectory({ feedbackVerdict: "useful" }),
      verification,
    );
    expect(result).toMatchObject({
      status: "warn",
      retentionEligible: false,
      checks: { grounded: false },
    });
    expect(result.signals.join(" ")).toMatch(/grounding evidence is absent/i);
  });
});

function trajectory(outcomeEvidence: Omit<RunTrajectory["outcomeEvidence"], "citedIds" | "invalidCitationCount">): RunTrajectory {
  return {
    version: 3,
    run: { id: "run", mode: "execute", status: "completed", specialistIds: [], startedAt: new Date().toISOString() },
    request: { promptLength: 1, promptSha256: "a".repeat(64), messageCount: 1 },
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2, estimatedCostUsd: 0.01, costKnown: true, latencyMs: 20, fallbackCount: 0 },
    providers: ["openai"], models: ["model"], toolExecutionIds: [], checkpoints: [], outcomeEvidence: {
      ...outcomeEvidence,
      citedIds: [],
      invalidCitationCount: 0,
    },
    events: [], runtime: { app: "asael", version: "test" },
  };
}
