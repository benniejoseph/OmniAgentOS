import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import type { AgentRunRecord } from "@/lib/runs/types";
import { buildConversationProgressV1 } from "@/lib/trajectories/conversation-progress";

const run: AgentRunRecord = {
  id: "run-one",
  tenantId: "tenant-one",
  ownerActorId: "actor-one",
  threadId: "00000000-0000-4000-8000-000000000001",
  mode: "execute",
  status: "completed",
  prompt: "private request that must not appear",
  messages: [{ role: "user", content: "private transcript that must not appear" }],
  memoryContextCount: 1,
  response: "private result that must not appear",
  grounding: {
    status: "verified",
    citedIds: ["knowledge:one"],
    invalidIds: [],
    sources: [],
  },
  startedAt: "2026-09-07T00:00:00.000Z",
  completedAt: "2026-09-07T00:00:08.000Z",
};

function event(
  id: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
  options: Partial<DomainEvent> = {},
): DomainEvent {
  return {
    id,
    seq,
    streamId: "run:run-one",
    type,
    tenantId: "tenant-one",
    actorId: "actor-one",
    correlationId: "request-one",
    payload,
    at: `2026-09-07T00:00:${String(seq).padStart(2, "0")}.000Z`,
    ...options,
  };
}

const readyIdentity = {
  state: "ready" as const,
  card: {
    logicalAgentId: "forge",
    definitionVersion: 4,
    name: "Forge",
    role: "Builder",
    status: "ready",
  },
};

describe("Conversation progress projection", () => {
  it("joins event-backed context, Agent, browser, voice, approval, checkpoint, and result progress", () => {
    const events = [
      event("intent-one", 1, "intent.semantic_resolved", {}, {
        streamId: "intent:request-one",
      }),
      event("scope-one", 2, "run.scope_bound"),
      event("harness-one", 3, "run.harness", {
        mode: "execute",
        model: "gpt-test",
        privateInstructions: "do not expose this",
      }),
      event("context-one", 4, "run.context.receipt", {
        actualCount: 2,
        excludedCount: 3,
        droppedCount: 1,
        rawContext: "do not expose this",
      }),
      event("browser-one", 5, "run.tool", {
        toolId: "mcp:playwright:browser_navigate",
        toolName: "Open website",
        status: "executed",
        riskLevel: 1,
        input: { url: "https://private.example/secret" },
      }),
      event("approval-one", 6, "run.waiting_approval", {
        executionId: "execution-one",
        arguments: "do not expose this",
      }),
      event("checkpoint-one", 7, "run.checkpoint.recorded", {
        checkpointId: "checkpoint-one",
        checkpointSha256: "a".repeat(64),
        sequence: 3,
        boundaryKind: "approval",
        boundaryPhase: "waiting",
        lifecycleState: "waiting",
        resumeDisposition: "awaiting_signal",
      }),
      event("voice-one", 1, "voice.command_reviewed", {
        runId: "run-one",
        confidenceBand: "high",
        reviewMethod: "visible_review",
        transcript: "do not expose this",
      }, {
        streamId: `thread:${run.threadId}`,
        correlationId: "request-one",
        at: "2026-09-07T00:00:07.500Z",
      }),
      event("done-one", 8, "run.done", {
        grounding: { status: "verified" },
        response: "do not expose this",
      }),
    ];

    const projection = buildConversationProgressV1({
      run,
      events,
      correlationId: "request-one",
      agentIdentity: readyIdentity,
    });

    expect(projection).toMatchObject({
      version: "p11.2-conversation-progress:1",
      runId: "run-one",
      terminal: true,
      headline: "Task complete",
      agent: {
        state: "ready",
        logicalAgentId: "forge",
        definitionVersion: 4,
      },
      context: {
        state: "recorded",
        usedCount: 2,
        excludedCount: 3,
        droppedCount: 1,
      },
      result: {
        state: "completed",
        responseLength: run.response?.length,
        groundingStatus: "verified",
        citationCount: 1,
      },
      recovery: { kind: "checkpoint" },
    });
    expect(projection.items.map((item) => item.category)).toEqual([
      "request",
      "agent",
      "plan",
      "context",
      "browser",
      "approval",
      "approval",
      "voice",
      "result",
    ]);
    expect(projection.items.every((item) => /^[a-f0-9]{64}$/.test(item.eventRef))).toBe(true);
    expect(projection.items.find((item) => item.source === "checkpoint"))
      .toMatchObject({
        state: "waiting",
        checkpoint: {
          checkpointId: "checkpoint-one",
          resumeDisposition: "awaiting_signal",
        },
      });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain("private request");
    expect(serialized).not.toContain("private transcript");
    expect(serialized).not.toContain("private result");
    expect(serialized).not.toContain("do not expose this");
    expect(serialized).not.toContain("private.example");
  });

  it("rejects unrelated, cross-tenant, and sibling-actor events", () => {
    const projection = buildConversationProgressV1({
      run,
      correlationId: "request-one",
      agentIdentity: { state: "unbound" },
      events: [
        event("valid", 1, "run.harness"),
        event("other-correlation", 1, "voice.speech_streamed", { runId: "other-run" }, {
          streamId: `thread:${run.threadId}`,
          correlationId: "other-request",
        }),
        event("other-actor", 2, "voice.command_reviewed", { runId: "run-one" }, {
          streamId: `thread:${run.threadId}`,
          actorId: "actor-other",
        }),
        event("other-tenant", 3, "run.model", {}, { tenantId: "tenant-other" }),
      ],
    });

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0].technical.eventType).toBe("run.harness");
  });

  it("projects exact-run speech even when its provider correlation is separate", () => {
    const projection = buildConversationProgressV1({
      run,
      correlationId: "request-one",
      agentIdentity: { state: "definition_unavailable" },
      events: [
        event("speech-one", 1, "voice.speech_streamed", {
          runId: "run-one",
          characters: 120,
          audio: "must never appear",
        }, {
          streamId: `thread:${run.threadId}`,
          correlationId: "voice-speech:separate",
        }),
      ],
    });

    expect(projection.items).toHaveLength(1);
    expect(projection.items[0]).toMatchObject({
      category: "voice",
      title: "Result spoken",
      state: "completed",
    });
    expect(JSON.stringify(projection)).not.toContain("must never appear");
  });

  it("returns actionable approval recovery without claiming completion", () => {
    const waitingRun = { ...run, status: "waiting_approval" as const, response: undefined, completedAt: undefined };
    const projection = buildConversationProgressV1({
      run: waitingRun,
      correlationId: "request-one",
      agentIdentity: readyIdentity,
      events: [event("approval", 1, "run.waiting_approval")],
    });

    expect(projection).toMatchObject({
      terminal: false,
      headline: "Approval required",
      result: { state: "pending", responseLength: 0 },
      recovery: {
        kind: "approval",
        href: "/app/approvals",
      },
    });
  });
});
