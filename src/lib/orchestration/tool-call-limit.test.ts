import { describe, expect, it } from "vitest";
import { MAX_DEFERRED_TOOL_CALL_HASHES } from "@/lib/runs/types";
import {
  deferredToolCallNotice,
  deferredToolCallTracker,
  skippedToolCallPayload,
  toolLimitMetadata,
  toolLimitStatus,
  unresolvedToolCallStatus,
} from "./tool-call-limit";

function call(callId: string, argumentsJson = '{"workItemId":"task-a"}') {
  return { callId, name: "app.work_items.show", argumentsJson };
}

describe("deferred tool call tracking", () => {
  it("matches reordered nested arguments with a new provider call ID", () => {
    const tracker = deferredToolCallTracker();
    tracker.defer([call("original", '{"workItemId":"task-a","page":{"cursor":"next","limit":3}}')]);
    expect(tracker.count()).toBe(1);
    tracker.admit([{
      callId: "new-provider-id", name: "app.work_items.show",
      arguments: '{"page":{"limit":3,"cursor":"next"},"workItemId":"task-a"}',
    }]);
    expect(tracker.count()).toBe(0);
  });

  it("leaves the original unresolved when arguments or tool names change", () => {
    const tracker = deferredToolCallTracker();
    tracker.defer([call("original")]);
    tracker.admit([call("changed-arguments", '{"workItemId":"task-b"}')]);
    tracker.admit([{ ...call("changed-tool"), name: "app.work_items.update" }]);
    expect(tracker.count()).toBe(1);
    tracker.admit([call("exact-request-again")]);
    expect(tracker.count()).toBe(0);
  });

  it("deduplicates equivalent requests and carries only digests across pauses", () => {
    const tracker = deferredToolCallTracker();
    tracker.defer([call("first"), call("second"), call("third")]);
    expect(tracker.count()).toBe(1);
    const persisted = tracker.hashes();
    expect(persisted).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
    expect(JSON.stringify(persisted)).not.toContain("task-a");
    const resumed = deferredToolCallTracker(persisted);
    resumed.admit([call("resumed-call")]);
    expect(resumed.count()).toBe(0);
    expect(tracker.count()).toBe(1);
    resumed.replace(persisted);
    expect(resumed.hashes()).toEqual(persisted);
  });

  it("rejects overflow without retaining more than 1,024 distinct requests", () => {
    expect(MAX_DEFERRED_TOOL_CALL_HASHES).toBe(1_024);
    const tracker = deferredToolCallTracker();
    const calls = Array.from({ length: MAX_DEFERRED_TOOL_CALL_HASHES }, (_, index) =>
      call(`call-${index}`, JSON.stringify({ workItemId: `task-${index}` })),
    );
    tracker.defer(calls);
    expect(tracker.count()).toBe(MAX_DEFERRED_TOOL_CALL_HASHES);
    expect(() => tracker.defer([call("duplicate", calls[0].argumentsJson)])).not.toThrow();
    expect(() => tracker.defer([call("overflow", '{"workItemId":"new-task"}')])).toThrow(/deferred tool requests/i);
    expect(tracker.count()).toBe(MAX_DEFERRED_TOOL_CALL_HASHES);
  });
});

describe("tool call limit reporting", () => {
  it("distinguishes a recoverable batch from exhausted calls and rounds", () => {
    expect(toolLimitMetadata({ remainingToolCalls: 25, remainingToolRounds: 7 }, { proposedCalls: 6, admittedCalls: 5 })).toEqual({
      version: 1, reason: "per_turn_calls", proposedCalls: 6, admittedCalls: 5,
      skippedCalls: 1, remainingToolCalls: 25, remainingToolRounds: 7,
    });
    expect(toolLimitMetadata({ remainingToolCalls: 0, remainingToolRounds: 3 })).toEqual({
      version: 1, reason: "run_tool_calls", remainingToolCalls: 0, remainingToolRounds: 3,
    });
    expect(toolLimitMetadata({ remainingToolCalls: 5, remainingToolRounds: 0 })).toEqual({
      version: 1, reason: "run_tool_rounds", remainingToolCalls: 5, remainingToolRounds: 0,
    });
    expect(toolLimitMetadata({ remainingToolRounds: 3 })).toEqual({
      version: 1, reason: "per_turn_calls", remainingToolRounds: 3,
    });
    expect(toolLimitMetadata({ remainingToolRounds: 0 })).toEqual({
      version: 1, reason: "run_tool_rounds", remainingToolRounds: 0,
    });
  });

  it("reports a skipped request safely and permits retry only for a per-turn limit", () => {
    const sensitiveCall = call("safe-call-id", '{"privateSource":"Never expose this client note"}');
    const tracker = deferredToolCallTracker();
    tracker.defer([sensitiveCall]);
    const recoverable = toolLimitMetadata(
      { remainingToolCalls: 12, remainingToolRounds: 3 },
      { proposedCalls: 6, admittedCalls: 5 },
    );
    const payload = skippedToolCallPayload(sensitiveCall, recoverable);
    expect(payload).toMatchObject({
      executed: false,
      skippedCall: { callId: "safe-call-id", toolName: "app.work_items.show" },
      toolLimit: recoverable,
    });
    expect(payload.error).toMatch(/not executed/);
    expect(payload.nextStep).toMatch(/next model turn/);
    expect(payload.nextStep).toMatch(/time, token, cost, approval/);
    expect(Object.keys(payload).sort()).toEqual(["error", "executed", "nextStep", "skippedCall", "toolLimit"]);
    const status = toolLimitStatus(recoverable);
    const unfinished = unresolvedToolCallStatus(1, { remainingToolCalls: 12, remainingToolRounds: 3 });
    expect(status).toMatchObject({ type: "status", label: "tool calls deferred", toolLimit: recoverable });
    expect(unfinished.toolLimit).toMatchObject({ reason: "per_turn_calls", unresolvedCalls: 1 });
    expect(unfinished.detail).toMatch(/No automatic retry/);
    expect(Object.keys(status).sort()).toEqual(["detail", "label", "toolLimit", "type"]);
    const serialized = JSON.stringify({ payload, status, unfinished });
    expect(serialized).not.toContain("Never expose this client note");
    expect(serialized).not.toContain("privateSource");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain(tracker.hashes()[0]);
    for (const allowance of [
      { remainingToolCalls: 0, remainingToolRounds: 3 },
      { remainingToolCalls: 12, remainingToolRounds: 0 },
    ]) {
      const terminal = toolLimitMetadata(allowance);
      const stopped = skippedToolCallPayload(sensitiveCall, terminal);
      expect(stopped.executed).toBe(false);
      expect(stopped.nextStep).toMatch(/Do not start more actions/);
      expect(stopped.nextStep).not.toMatch(/next model turn/);
      expect(toolLimitStatus(terminal)).toMatchObject({ label: "tool budget reached", toolLimit: terminal });
    }
  });

  it("adds a plain-language notice that makes unfinished work explicit", () => {
    const notice = deferredToolCallNotice(2);
    expect(notice).toContain("2");
    expect(notice).toMatch(/unfinished|incomplete|not completed/i);
    expect(notice).not.toMatch(/[\[\]{}]|per.turn|model|tool call|sha256|digest/i);
  });
});
