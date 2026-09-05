import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-events-"));
  delete process.env.DATABASE_URL;
});

describe("event store (file mode)", () => {
  it("appends with monotonic sequence and reads streams in order", async () => {
    const store = await import("@/lib/events/store");
    const a = await store.appendDomainEvent({ streamId: "run:1", type: "run.status", payload: { n: 1 } });
    const b = await store.appendDomainEvent({ streamId: "run:1", type: "run.done", payload: { n: 2 } });
    const other = await store.appendDomainEvent({ streamId: "run:2", type: "run.status", payload: { n: 3 } });

    expect(b.seq).toBeGreaterThan(a.seq);
    expect(other.seq).toBeGreaterThan(b.seq);

    const stream = await store.listStreamEvents("run:1");
    expect(stream.map((event) => event.type)).toEqual(["run.status", "run.done"]);
  });

  it("scopes reads by tenant", async () => {
    const store = await import("@/lib/events/store");
    await store.appendDomainEvent({ streamId: "t:x", type: "x", tenantId: "tenant-a" });
    await store.appendDomainEvent({ streamId: "t:x", type: "x", tenantId: "tenant-b" });

    const aOnly = await store.listStreamEvents("t:x", { tenantId: "tenant-a" });
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0].tenantId).toBe("tenant-a");
  });

  it("scopes stream cursors by actor and returns a bounded newest-first delta", async () => {
    const store = await import("@/lib/events/store");
    const first = await store.appendDomainEvent({
      streamId: "mission:cursor",
      type: "mission.created",
      tenantId: "tenant-cursor",
      actorId: "actor-a",
    });
    await store.appendDomainEvent({
      streamId: "mission:cursor",
      type: "mission.private",
      tenantId: "tenant-cursor",
      actorId: "actor-b",
    });
    const second = await store.appendDomainEvent({
      streamId: "mission:cursor",
      type: "mission.task.created",
      tenantId: "tenant-cursor",
      actorId: "actor-a",
    });
    const third = await store.appendDomainEvent({
      streamId: "mission:cursor",
      type: "mission.status.changed",
      tenantId: "tenant-cursor",
      actorId: "actor-a",
    });

    const delta = await store.listStreamEvents("mission:cursor", {
      tenantId: "tenant-cursor",
      actorId: "actor-a",
      afterSeq: first.seq,
      limit: 2,
      order: "desc",
    });

    expect(delta.map((event) => event.seq)).toEqual([third.seq, second.seq]);
    expect(delta.every((event) => event.actorId === "actor-a")).toBe(true);
  });

  it("filters recent events by type", async () => {
    const store = await import("@/lib/events/store");
    await store.appendDomainEvent({ streamId: "s:1", type: "trust.outcome.success", tenantId: "default" });
    const recent = await store.listRecentEvents({ tenantId: "default", type: "trust.outcome.success" });
    expect(recent.length).toBeGreaterThan(0);
    expect(recent.every((event) => event.type === "trust.outcome.success")).toBe(true);
  });

  it("treats a stable event id as an exact idempotency binding", async () => {
    const store = await import("@/lib/events/store");
    const first = await store.appendDomainEvent({
      id: "stable-event-id",
      streamId: "project:stable",
      type: "project.created",
      tenantId: "tenant-stable",
      actorId: "actor-stable",
      payload: { schemaVersion: 1, projectId: "stable" },
    });
    const replay = await store.appendDomainEvent({
      id: "stable-event-id",
      streamId: "project:stable",
      type: "project.created",
      tenantId: "tenant-stable",
      actorId: "actor-stable",
      payload: { projectId: "stable", schemaVersion: 1 },
    });

    expect(replay).toEqual(first);
    await expect(store.appendDomainEvent({
      id: "stable-event-id",
      streamId: "project:stable",
      type: "project.created",
      tenantId: "tenant-stable",
      actorId: "actor-stable",
      payload: { schemaVersion: 1, projectId: "different" },
    })).rejects.toThrow("already bound to a different event");
  });

  it("survives append failures via the safe wrapper", async () => {
    const store = await import("@/lib/events/store");
    const result = await store.appendDomainEventSafely({ streamId: "ok", type: "ok" });
    expect(result?.streamId).toBe("ok");
  });
});
