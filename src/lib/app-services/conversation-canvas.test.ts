import { describe, expect, it, vi } from "vitest";

import { showConversationCanvasService } from "@/lib/app-services/conversation-canvas";

const NOW = "2026-09-07T15:00:00.000Z";
const caller = {
  context: {
    tenantId: "tenant:test",
    actorId: "owner@example.test",
    role: "admin" as const,
    source: "session" as const,
    auth: {
      userId: "00000000-0000-4000-8000-000000000001",
      email: "owner@example.test",
      sessionId: "session:test",
      tenantName: "Test",
    },
  },
};

describe("Conversation canvas application service", () => {
  it("binds the read to the canonical/current owner scope", async () => {
    const loadSource = vi.fn().mockResolvedValue({
      threads: [{ id: "thread-1", title: "Test", mode: "orchestrate", updatedAt: NOW }],
      runs: [], forks: [], delegations: [], projects: [], projectArtifacts: [], sharedArtifacts: [],
      truncated: { runs: false, forks: false, delegations: false, sharedArtifacts: false },
    });
    const result = await showConversationCanvasService(caller, {
      threadId: "thread-1",
    }, { loadSource });

    expect(loadSource).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant:test",
      actorId: "owner@example.test",
      threadId: "thread-1",
      requestActorBinding: expect.objectContaining({
        canonicalActorId: "actor:00000000-0000-4000-8000-000000000001",
        readableOwnerActorIds: [
          "actor:00000000-0000-4000-8000-000000000001",
          "owner@example.test",
        ],
      }),
      threadLimit: 24,
      runLimit: 120,
      artifactLimit: 80,
    }));
    expect(result.receipt.operation).toBe("app.conversations.canvas.show");
    expect(result.data.projection.counts.conversation).toBe(1);
  });
});
