import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { foldRunProjection, foldTrustProfile } from "@/lib/events/projections";
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
      autonomyMode: "approve_each",
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

function runEvent(seq: number, type: string, payload: Record<string, unknown> = {}): DomainEvent {
  return {
    id: `r${seq}`,
    seq,
    streamId: "run:demo-run",
    type: `run.${type}`,
    tenantId: "default",
    actorId: "system",
    payload,
    at: new Date(1700000000000 + seq * 1000).toISOString(),
  };
}

describe("foldRunProjection", () => {
  it("defaults to running with no tool calls for an empty stream", () => {
    expect(foldRunProjection([])).toEqual({
      status: "running",
      memoryContextCount: 0,
      toolCalls: [],
    });
  });

  it("rebuilds a completed run's status, response, and tool calls", () => {
    const events = [
      runEvent(1, "status", { label: "thinking" }),
      runEvent(2, "memory", { title: "context", count: 3 }),
      runEvent(3, "tool", { toolId: "search", toolName: "Search", status: "executed", riskLevel: 1 }),
      runEvent(4, "done", { response: "all done" }),
    ];
    const projection = foldRunProjection(events);
    expect(projection.status).toBe("completed");
    expect(projection.response).toBe("all done");
    expect(projection.memoryContextCount).toBe(3);
    expect(projection.toolCalls).toEqual([
      { toolId: "search", toolName: "Search", status: "executed", riskLevel: 1, dryRun: false, summary: undefined, executionId: undefined },
    ]);
  });

  it("rebuilds the privacy-preserving response receipt used by current runs", () => {
    const projection = foldRunProjection([
      runEvent(1, "done", {
        responseLength: 8,
        responseSha256: "1".repeat(64),
      }),
    ]);
    expect(projection).toMatchObject({
      status: "completed",
      responseLength: 8,
      responseSha256: "1".repeat(64),
    });
    expect(projection.response).toBeUndefined();
  });

  it("rebuilds a failed run's status and error", () => {
    const events = [runEvent(1, "error", { message: "boom" })];
    const projection = foldRunProjection(events);
    expect(projection.status).toBe("failed");
    expect(projection.error).toBe("boom");
  });

  it("rebuilds a canceled run and clears a pending approval", () => {
    const projection = foldRunProjection([
      runEvent(1, "waiting_approval", {
        executionId: "exec-cancel",
        toolId: "write",
        message: "needs approval",
      }),
      runEvent(2, "canceled", { message: "Canceled by the operator." }),
    ]);
    expect(projection).toMatchObject({
      status: "canceled",
      error: "Canceled by the operator.",
    });
    expect(projection.waitingApproval).toBeUndefined();
  });

  it("rebuilds a run waiting on approval", () => {
    const events = [
      runEvent(1, "tool", { toolId: "delete", toolName: "Delete", status: "approval_required" }),
      runEvent(2, "waiting_approval", { executionId: "exec-1", toolId: "delete", message: "needs approval" }),
    ];
    const projection = foldRunProjection(events);
    expect(projection.status).toBe("waiting_approval");
    expect(projection.waitingApproval).toEqual({
      executionId: "exec-1",
      toolId: "delete",
      message: "needs approval",
    });
  });

  it("folds out-of-order input deterministically by seq", () => {
    const events = [
      runEvent(2, "done", { response: "final" }),
      runEvent(1, "tool", { toolId: "search", toolName: "Search", status: "executed" }),
    ];
    const projection = foldRunProjection(events);
    expect(projection.status).toBe("completed");
    expect(projection.response).toBe("final");
    expect(projection.toolCalls).toHaveLength(1);
  });

  it("ignores events outside the run stream namespace", () => {
    const events = [
      { ...runEvent(1, "done", { response: "final" }), streamId: "workflow:other", type: "workflow.done" },
    ];
    expect(foldRunProjection(events).status).toBe("running");
  });
});
