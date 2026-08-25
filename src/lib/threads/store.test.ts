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
});
