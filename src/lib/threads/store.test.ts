import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-threads-"));
  delete process.env.DATABASE_URL;
});

describe("durable conversation threads (file mode)", () => {
  it("keeps ordered turns and isolates tenants", async () => {
    const store = await import("@/lib/threads/store");
    const thread = await store.createThread({ tenantId: "tenant-a", actorId: "user-a", title: "Plan my week", mode: "orchestrate" });
    await store.appendThreadTurn({ tenantId: "tenant-a", threadId: thread.id, role: "user", content: "Plan my week" });
    await store.appendThreadTurn({ tenantId: "tenant-a", threadId: thread.id, role: "assistant", content: "What matters most this week?" });

    await expect(store.listThreadTurns(thread.id, { tenantId: "tenant-a" })).resolves.toMatchObject([
      { role: "user", content: "Plan my week" },
      { role: "assistant", content: "What matters most this week?" },
    ]);
    const summaries = await store.listConversationSummaries(thread.id, {
      tenantId: "tenant-a",
      levels: ["turn", "episode"],
    });
    expect(summaries.filter((summary) => summary.level === "turn")).toHaveLength(2);
    expect(summaries.filter((summary) => summary.level === "episode")).toHaveLength(1);
    expect(summaries.every((summary) =>
      summary.sourceTurnIds.length > 0 && summary.accessScope.actorId === "user-a"
    )).toBe(true);
    await expect(store.getThread(thread.id, { tenantId: "tenant-b" })).resolves.toBeNull();
    await expect(store.listThreadTurns(thread.id, { tenantId: "tenant-b" })).resolves.toEqual([]);
  });

  it("lists only conversations owned by the current actor", async () => {
    const store = await import("@/lib/threads/store");
    await store.createThread({ tenantId: "tenant-c", actorId: "user-one", title: "One", mode: "research" });
    await store.createThread({ tenantId: "tenant-c", actorId: "user-two", title: "Two", mode: "learn" });
    const threads = await store.listThreads(10, { tenantId: "tenant-c", actorId: "user-one" });
    expect(threads.map((thread) => thread.title)).toEqual(["One"]);
  });

  it("keeps canonical bindings exact in file mode", async () => {
    const store = await import("@/lib/threads/store");
    const authUserId = "11111111-1111-4111-8111-111111111111";
    const actorId = "file-owner@example.test";
    const canonicalActorId = `actor:${authUserId}`;
    const canonicalThread = await store.createThread({
      tenantId: "tenant-file-binding",
      actorId: canonicalActorId,
      title: "Canonical",
      mode: "orchestrate",
    });
    const emailThread = await store.createThread({
      tenantId: "tenant-file-binding",
      actorId,
      title: "Current email",
      mode: "orchestrate",
    });
    const requestActorBinding = {
      version: 1 as const,
      kind: "auth_user" as const,
      authUserId,
      canonicalActorId,
      legacyOwnerActorIds: Object.freeze([actorId]),
      readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
    };

    await expect(store.listThreads(10, {
      tenantId: "tenant-file-binding",
      actorId,
      requestActorBinding,
    })).resolves.toEqual([
      expect.objectContaining({ id: emailThread.id, actorId }),
    ]);
    await expect(store.getOwnedThread(canonicalThread.id, {
      tenantId: "tenant-file-binding",
      actorId,
      requestActorBinding,
    })).resolves.toBeNull();
    await expect(store.getOwnedThread(emailThread.id, {
      tenantId: "tenant-file-binding",
      actorId,
      requestActorBinding,
    })).resolves.toEqual(expect.objectContaining({
      id: emailThread.id,
      actorId,
    }));
  });

  it("returns the conversation a retried request already opened", async () => {
    const store = await import("@/lib/threads/store");
    const threadId = "5f0c4a39-8c1e-8a47-9d2b-1f6e3c7a9b04";
    const thread = await store.createThread({
      id: threadId,
      tenantId: "tenant-retry",
      actorId: "user-retry",
      title: "Plan my week",
      mode: "orchestrate",
    });
    expect(thread.id).toBe(threadId);

    await expect(store.createThread({
      id: threadId,
      tenantId: "tenant-retry",
      actorId: "user-retry",
      title: "Plan my week",
      mode: "orchestrate",
    })).resolves.toEqual(thread);
    expect((await store.listThreads(10, {
      tenantId: "tenant-retry",
      actorId: "user-retry",
    })).filter((candidate) => candidate.id === threadId)).toHaveLength(1);

    for (const conflicting of [
      { tenantId: "tenant-retry", actorId: "user-other" },
      { tenantId: "tenant-other", actorId: "user-retry" },
      { tenantId: "tenant-retry", actorId: "user-retry", projectId: "project-a" },
    ]) {
      await expect(store.createThread({
        id: threadId,
        ...conflicting,
        title: "Plan my week",
        mode: "orchestrate",
      })).rejects.toThrow("Thread identity is already bound to a different conversation.");
    }
    await expect(store.getThread(threadId, { tenantId: "tenant-retry" }))
      .resolves.toMatchObject({ actorId: "user-retry" });
  });

  it("records a retried request's message once", async () => {
    const store = await import("@/lib/threads/store");
    const thread = await store.createThread({
      tenantId: "tenant-retry-turn",
      actorId: "user-retry",
      title: "Plan my week",
      mode: "orchestrate",
    });
    const other = await store.createThread({
      tenantId: "tenant-retry-turn",
      actorId: "user-retry",
      title: "Another plan",
      mode: "orchestrate",
    });
    const turnId = "0e4b7d52-3a91-8c6f-b2d8-7a5e9c1f3b60";
    const turn = await store.appendThreadTurn({
      id: turnId,
      tenantId: "tenant-retry-turn",
      threadId: thread.id,
      role: "user",
      content: "Plan my week",
    });
    expect(turn.id).toBe(turnId);

    await expect(store.appendThreadTurn({
      id: turnId,
      tenantId: "tenant-retry-turn",
      threadId: thread.id,
      role: "user",
      content: "Plan my week",
    })).resolves.toEqual(turn);
    await expect(store.listThreadTurns(thread.id, { tenantId: "tenant-retry-turn" }))
      .resolves.toEqual([turn]);

    for (const conflicting of [
      { threadId: thread.id, role: "user" as const, content: "Plan my month" },
      { threadId: thread.id, role: "assistant" as const, content: "Plan my week" },
      { threadId: other.id, role: "user" as const, content: "Plan my week" },
    ]) {
      await expect(store.appendThreadTurn({
        id: turnId,
        tenantId: "tenant-retry-turn",
        ...conflicting,
      })).rejects.toThrow("Thread turn identity is already bound to a different message.");
    }
    await expect(store.listThreadTurns(thread.id, { tenantId: "tenant-retry-turn" }))
      .resolves.toEqual([turn]);
    await expect(store.listThreadTurns(other.id, { tenantId: "tenant-retry-turn" }))
      .resolves.toEqual([]);
  });
});
