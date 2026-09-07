import { describe, expect, it } from "vitest";

import { parseConversationCanvasProjection } from "@/components/conversation-canvas";

describe("Conversation canvas client boundary", () => {
  it("keeps only supported nodes and canonical non-memory edges", () => {
    const projection = parseConversationCanvasProjection({
      version: "p11.3-conversation-canvas:1",
      generatedAt: "2026-09-07T15:00:00.000Z",
      digest: "a".repeat(64),
      nodes: [
        node("conversation:thread-1", "conversation", "thread-1"),
        node("run:run-1", "run", "run-1"),
        node("secret:one", "credential", "secret-1"),
      ],
      edges: [
        edge("conversation:thread-1", "run:run-1", "not_implied"),
        edge("conversation:thread-1", "missing", "not_implied"),
        edge("conversation:thread-1", "run:run-1", "granted"),
      ],
      memoryBoundary: {
        mode: "explicit_grants_only",
        grantedRunCount: 0,
        detail: "Only exact grants count.",
      },
      truncated: { runs: false },
    });

    expect(projection?.nodes.map((item) => item.id)).toEqual([
      "conversation:thread-1",
      "run:run-1",
    ]);
    expect(projection?.edges).toHaveLength(1);
    expect(projection?.memoryBoundary.detail).toBe("Only exact grants count.");
  });

  it("rejects an unknown projection version", () => {
    expect(parseConversationCanvasProjection({ version: "future" })).toBeUndefined();
  });
});

function node(id: string, kind: string, entityId: string) {
  return {
    id, kind, entityId, title: entityId, detail: "detail", status: "ready",
    occurredAt: "2026-09-07T15:00:00.000Z", threadId: kind === "conversation" ? entityId : "thread-1",
    runId: kind === "run" ? entityId : null, projectId: null,
    contextAccess: { state: "none", grantCount: 0, detail: "No grants." },
  };
}

function edge(from: string, to: string, access: string) {
  return {
    id: `${from}:${to}:${access}`,
    kind: "conversation_run",
    from,
    to,
    label: "executed as",
    authority: "agent_run.thread_id",
    relationshipId: "run-1",
    contextAccess: { state: access },
  };
}
