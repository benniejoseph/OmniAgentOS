import { describe, expect, it } from "vitest";
import { evaluateTrajectoryLearning } from "@/lib/trajectories/evaluate";
import type { RunTrajectory, TrajectoryVerification } from "@/lib/trajectories/types";

const verification: TrajectoryVerification = {
  valid: true,
  checks: { orderedEvents: true, terminalReceipt: true, usageTotals: true, toolReceipts: true },
  issues: [],
};

describe("trajectory learning evaluation", () => {
  it("promotes only verified owner-accepted outcomes", () => {
    const result = evaluateTrajectoryLearning(trajectory({ feedbackVerdict: "useful", groundingStatus: "verified" }), verification);
    expect(result).toMatchObject({ status: "pass", promotionEligible: true, score: 1 });
  });

  it("blocks learning promotion after owner correction", () => {
    const result = evaluateTrajectoryLearning(trajectory({ feedbackVerdict: "needs_work", groundingStatus: "verified" }), verification);
    expect(result.status).toBe("fail");
    expect(result.promotionEligible).toBe(false);
    expect(result.signals.join(" ")).toMatch(/needing work/i);
  });

  it("does not promote legacy trajectories without explicit grounding evidence", () => {
    const result = evaluateTrajectoryLearning(
      trajectory({ feedbackVerdict: "useful" }),
      verification,
    );
    expect(result).toMatchObject({
      status: "warn",
      promotionEligible: false,
      checks: { grounded: false },
    });
    expect(result.signals.join(" ")).toMatch(/grounding evidence is absent/i);
  });
});

function trajectory(learning: Omit<RunTrajectory["learning"], "citedIds" | "invalidCitationCount">): RunTrajectory {
  return {
    version: 2,
    run: { id: "run", mode: "execute", status: "completed", specialistIds: [], startedAt: new Date().toISOString() },
    request: { promptLength: 1, promptSha256: "a".repeat(64), messageCount: 1 },
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, totalTokens: 2, estimatedCostUsd: 0.01, costKnown: true, latencyMs: 20, fallbackCount: 0 },
    providers: ["openai"], models: ["model"], toolExecutionIds: [], checkpoints: [], learning: {
      ...learning,
      citedIds: [],
      invalidCitationCount: 0,
    },
    events: [], runtime: { app: "asael", version: "test" },
  };
}
