import { describe, expect, it } from "vitest";
import { parseConversationProgress } from "@/components/conversation-progress-panel";

const eventRef = "a".repeat(64);

function payload() {
  return {
    version: "p11.2-conversation-progress:1",
    runId: "run-one",
    status: "completed",
    terminal: true,
    headline: "Task complete",
    summary: "The finished answer is in the conversation.",
    agent: {
      state: "ready",
      name: "Forge",
      role: "Builder",
      definitionVersion: 3,
      instructions: "private instructions",
    },
    context: {
      state: "recorded",
      usedCount: 2,
      excludedCount: 1,
      droppedCount: 0,
      rawContext: "private context",
    },
    result: {
      state: "completed",
      responseLength: 100,
      groundingStatus: "verified",
      citationCount: 2,
      response: "private response",
    },
    recovery: {
      kind: "checkpoint",
      label: "Correct from checkpoint",
      instruction: "Start a new trace with fresh grants.",
      href: "https://attacker.example",
    },
    items: [{
      id: `event:${eventRef}`,
      source: "event",
      eventRef,
      category: "result",
      state: "completed",
      title: "Result completed",
      summary: "The answer is in the conversation.",
      at: "2026-09-07T00:00:00.000Z",
      technical: {
        eventType: "run.done",
        streamKind: "run",
        sequence: 8,
        payload: "private payload",
      },
      action: {
        kind: "result",
        label: "Open result evidence",
        href: "https://attacker.example",
      },
    }],
  };
}

describe("Conversation progress client contract", () => {
  it("accepts the pinned projection while discarding private and server-supplied navigation fields", () => {
    const parsed = parseConversationProgress(payload());

    expect(parsed).toMatchObject({
      version: "p11.2-conversation-progress:1",
      runId: "run-one",
      agent: { state: "ready", name: "Forge", role: "Builder" },
      context: { usedCount: 2, excludedCount: 1 },
      result: { state: "completed", citationCount: 2 },
      items: [{
        eventRef,
        action: { kind: "result", label: "Open result evidence" },
      }],
    });
    expect(JSON.stringify(parsed)).not.toContain("private");
    expect(JSON.stringify(parsed)).not.toContain("attacker.example");
  });

  it("drops rows without a real event reference and rejects unknown contract versions", () => {
    const invalidRow = payload();
    invalidRow.items[0].eventRef = "not-a-reference";
    expect(parseConversationProgress(invalidRow)?.items).toEqual([]);

    const invalidVersion = payload();
    invalidVersion.version = "future-contract";
    expect(parseConversationProgress(invalidVersion)).toBeUndefined();
  });

  it("keeps historical browser receipts content-free without exposing a retired viewer action", () => {
    const historical = payload();
    historical.items[0].category = "browser";
    historical.items[0].action = {
      kind: "browser",
      label: "Open browser evidence",
      href: "https://attacker.example",
    };

    expect(parseConversationProgress(historical)?.items).toEqual([
      expect.objectContaining({ category: "browser", action: undefined }),
    ]);
  });
});
