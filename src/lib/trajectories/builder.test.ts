import { describe, expect, it } from "vitest";
import { buildRunTrajectory } from "@/lib/trajectories/builder";
import { verifyRunTrajectory } from "@/lib/trajectories/verify";
import type { DomainEvent } from "@/lib/events/store";
import type { AgentRunRecord } from "@/lib/runs/types";

const run: AgentRunRecord = {
  id: "run-1",
  tenantId: "personal",
  threadId: "thread-1",
  mode: "execute",
  status: "completed",
  prompt: "private request",
  messages: [{ role: "user", content: "private request" }],
  specialistIds: ["forge"],
  memoryContextCount: 2,
  response: "private answer",
  feedback: { verdict: "needs_work", correction: "private correction", updatedAt: "2026-08-26T00:00:03.000Z" },
  grounding: { status: "verified", citedIds: ["memory:1"], invalidIds: [], sources: [] },
  startedAt: "2026-08-26T00:00:00.000Z",
  completedAt: "2026-08-26T00:00:02.000Z",
};

function event(
  seq: number,
  type: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `event-${seq}`,
    seq,
    streamId: "run:run-1",
    type,
    tenantId: "personal",
    actorId: "owner",
    payload,
    at: `2026-08-26T00:00:0${seq}.000Z`,
  };
}

describe("run trajectory", () => {
  it("exports bounded receipts and aggregates model cost without plaintext", () => {
    const trajectory = buildRunTrajectory(run, [
      event(2, "run.tool", {
        toolId: "web.search",
        toolName: "Search",
        status: "executed",
        executionId: "exec-1",
        summary: "sensitive result",
      }),
      event(1, "run.model", {
        provider: "openai",
        model: "gpt-test",
        tier: "reasoning",
        inputTokens: 10,
        outputTokens: 5,
        cachedInputTokens: 2,
        totalTokens: 15,
        latencyMs: 240,
        fallbackUsed: false,
        estimatedCostUsd: 0.004,
      }),
    ]);

    expect(trajectory.version).toBe(2);
    expect(trajectory.usage).toMatchObject({ totalTokens: 15, estimatedCostUsd: 0.004, costKnown: true });
    expect(trajectory.providers).toEqual(["openai"]);
    expect(trajectory.toolExecutionIds).toEqual(["exec-1"]);
    expect(trajectory.events[1].receipt).not.toHaveProperty("summary");
    expect(JSON.stringify(trajectory)).not.toContain("private request");
    expect(JSON.stringify(trajectory)).not.toContain("private answer");
    expect(JSON.stringify(trajectory)).not.toContain("private correction");
    expect(trajectory.learning).toMatchObject({ feedbackVerdict: "needs_work", correctionLength: 18, groundingStatus: "verified" });
    expect(verifyRunTrajectory(trajectory, run).valid).toBe(true);
  });

  it("detects a modified response receipt", () => {
    const trajectory = buildRunTrajectory(run, []);
    trajectory.response!.sha256 = "0".repeat(64);
    const verification = verifyRunTrajectory(trajectory, run);
    expect(verification.valid).toBe(false);
    expect(verification.checks.terminalReceipt).toBe(false);
  });
});
