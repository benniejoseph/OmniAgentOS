import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

  it("reads one type from a stream before its limit", async () => {
    const store = await import("@/lib/events/store");
    for (const n of [1, 2, 3]) {
      await store.appendDomainEvent({ streamId: "typed:1", type: "typed.other", payload: { n } });
    }
    await store.appendDomainEvent({ streamId: "typed:1", type: "typed.wanted", payload: { n: 4 } });
    await store.appendDomainEvent({ streamId: "typed:2", type: "typed.wanted", payload: { n: 5 } });
    await store.appendDomainEvent({ streamId: "typed:1", type: "typed.wanted", payload: { n: 6 } });

    const first = await store.listStreamEvents("typed:1", { type: "typed.wanted", limit: 1 });
    expect(first.map((event) => event.payload.n)).toEqual([4]);
    const wanted = await store.listStreamEvents("typed:1", { type: "typed.wanted" });
    expect(wanted.map((event) => event.payload.n)).toEqual([4, 6]);
  });

  it("scopes reads by tenant", async () => {
    const store = await import("@/lib/events/store");
    await store.appendDomainEvent({ streamId: "t:x", type: "x", tenantId: "tenant-a" });
    await store.appendDomainEvent({ streamId: "t:x", type: "x", tenantId: "tenant-b" });

    const aOnly = await store.listStreamEvents("t:x", { tenantId: "tenant-a" });
    expect(aOnly).toHaveLength(1);
    expect(aOnly[0].tenantId).toBe("tenant-a");
  });

  it("keeps conversation summary events inside readable actor aliases", async () => {
    const store = await import("@/lib/events/store");
    const tenantId = "tenant-private-summary";
    const streamId = "conversation-summary:episode-private";
    await store.appendDomainEvent({
      streamId,
      type: "conversation.summary.enriched",
      tenantId,
      actorId: "actor:canonical-owner",
      payload: { enrichmentId: "canonical-private" },
    });
    await store.appendDomainEvent({
      streamId,
      type: "conversation.summary.rebuilt",
      tenantId,
      actorId: "legacy-owner@example.test",
      payload: { summaryId: "legacy-private" },
    });
    await store.appendDomainEvent({
      streamId,
      type: "conversation.summary.enriched",
      tenantId,
      actorId: "sibling@example.test",
      payload: { enrichmentId: "sibling-private" },
    });

    const visible = await store.listStreamEvents(streamId, {
      tenantId,
      privateActorIds: [
        "actor:canonical-owner",
        "legacy-owner@example.test",
      ],
    });

    expect(visible.map((event) => event.actorId)).toEqual([
      "actor:canonical-owner",
      "legacy-owner@example.test",
    ]);
    expect(JSON.stringify(visible)).not.toContain("sibling-private");
  });

  it("filters only private summary events from mixed recent tenant reads", async () => {
    const store = await import("@/lib/events/store");
    const tenantId = "tenant-mixed-events";
    await store.appendDomainEvent({
      streamId: "conversation-summary:owned-episode",
      type: "conversation.summary.enriched",
      tenantId,
      actorId: "actor:owner",
    });
    await store.appendDomainEvent({
      streamId: "conversation-summary:sibling-episode",
      type: "conversation.summary.enriched",
      tenantId,
      actorId: "actor:sibling",
      payload: { enrichmentId: "private-sibling-enrichment" },
    });
    await store.appendDomainEvent({
      streamId: "project:shared-tenant-event",
      type: "project.updated",
      tenantId,
      actorId: "actor:sibling",
      payload: { projectId: "ordinary-tenant-event" },
    });

    const visible = await store.listRecentEvents({
      tenantId,
      privateActorIds: ["actor:owner"],
    });

    expect(visible.map((event) => event.streamId)).toEqual([
      "project:shared-tenant-event",
      "conversation-summary:owned-episode",
    ]);
    expect(JSON.stringify(visible)).not.toContain("private-sibling-enrichment");
  });

  it("reads only the latest event timestamp for explicit actor aliases", async () => {
    const store = await import("@/lib/events/store");
    await store.appendDomainEvent({
      id: "maintenance-old",
      streamId: "memory-maintenance:tenant-a",
      type: "memory.maintenance.completed",
      tenantId: "tenant-a",
      actorId: "actor:old",
    });
    const newest = await store.appendDomainEvent({
      id: "maintenance-new",
      streamId: "memory-maintenance:tenant-a",
      type: "memory.maintenance.completed",
      tenantId: "tenant-a",
      actorId: "actor:new",
    });

    await expect(store.getLatestScopedStreamEventAt(
      "memory-maintenance:tenant-a",
      {
        tenantId: "tenant-a",
        actorIds: ["actor:old", "actor:new"],
        type: "memory.maintenance.completed",
      },
    )).resolves.toBe(newest.at);
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

  it("reads a correlation only inside its tenant and initiating actor boundary", async () => {
    const store = await import("@/lib/events/store");
    await store.appendDomainEvent({
      streamId: "intent:one",
      type: "intent.captured",
      tenantId: "tenant-trace",
      actorId: "actor-one",
      correlationId: "correlation-one",
    });
    await store.appendDomainEvent({
      streamId: "workflow:one",
      type: "workflow.completed",
      tenantId: "tenant-trace",
      actorId: "actor-one",
      correlationId: "correlation-one",
    });
    await store.appendDomainEvent({
      streamId: "workflow:private",
      type: "workflow.private",
      tenantId: "tenant-trace",
      actorId: "actor-two",
      correlationId: "correlation-one",
    });
    await store.appendDomainEvent({
      streamId: "workflow:other-tenant",
      type: "workflow.private",
      tenantId: "tenant-other",
      actorId: "actor-one",
      correlationId: "correlation-one",
    });

    const events = await store.listCorrelatedEvents("correlation-one", {
      tenantId: "tenant-trace",
      actorId: "actor-one",
    });

    expect(events.map((event) => event.type)).toEqual([
      "intent.captured",
      "workflow.completed",
    ]);
    expect(events.every((event) =>
      event.tenantId === "tenant-trace" && event.actorId === "actor-one"
    )).toBe(true);
  });

  it("reads recent actor events only inside the tenant, actor, types, window, and payload match", async () => {
    const store = await import("@/lib/events/store");
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-09-25T10:00:00.000Z"));
      await store.appendDomainEvent({
        streamId: "voice:old",
        type: "voice.realtime_started",
        tenantId: "tenant-recent",
        actorId: "actor-one",
        payload: { conversationId: "thread-one" },
      });
      vi.setSystemTime(new Date("2026-09-25T10:40:00.000Z"));
      const started = await store.appendDomainEvent({
        streamId: "voice:new",
        type: "voice.realtime_started",
        tenantId: "tenant-recent",
        actorId: "actor-one",
        payload: { conversationId: "thread-one" },
      });
      const sent = await store.appendDomainEvent({
        streamId: "voice:new",
        type: "voice.realtime_sent",
        tenantId: "tenant-recent",
        actorId: "actor-one",
        payload: { conversationId: "thread-one" },
      });
      for (const input of [
        { type: "voice.realtime_started", tenantId: "tenant-recent", actorId: "actor-one", conversationId: "thread-two" },
        { type: "voice.realtime_started", tenantId: "tenant-recent", actorId: "actor-two", conversationId: "thread-one" },
        { type: "voice.realtime_started", tenantId: "tenant-other", actorId: "actor-one", conversationId: "thread-one" },
        { type: "voice.speech_streamed", tenantId: "tenant-recent", actorId: "actor-one", conversationId: "thread-one" },
      ]) {
        await store.appendDomainEvent({
          streamId: "voice:noise",
          type: input.type,
          tenantId: input.tenantId,
          actorId: input.actorId,
          payload: { conversationId: input.conversationId },
        });
      }

      const events = await store.listRecentActorEvents({
        tenantId: "tenant-recent",
        actorId: "actor-one",
        types: ["voice.realtime_started", "voice.realtime_sent"],
        since: new Date("2026-09-25T10:10:00.000Z"),
        payloadMatch: { key: "conversationId", value: "thread-one" },
      });
      expect(events.map((event) => event.id)).toEqual([sent.id, started.id]);

      const unmatched = await store.listRecentActorEvents({
        tenantId: "tenant-recent",
        actorId: "actor-one",
        types: ["voice.realtime_started"],
        since: new Date("2026-09-25T09:00:00.000Z"),
        limit: 2,
      });
      expect(unmatched).toHaveLength(2);
      expect(unmatched.every((event) =>
        event.tenantId === "tenant-recent" && event.actorId === "actor-one"
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    await expect(store.listRecentActorEvents({
      tenantId: "tenant-recent",
      actorId: "actor-one",
      types: ["voice.realtime_started"],
      since: new Date(),
      payloadMatch: { key: "conversationId') OR true --", value: "x" },
    })).rejects.toThrow("invalid payload match");
    await expect(store.listRecentActorEvents({
      tenantId: "tenant-recent",
      actorId: "actor-one",
      types: [],
      since: new Date(),
    })).rejects.toThrow("one to sixteen event types");
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

  it("uses an explicitly injected transaction client without ambient database configuration", async () => {
    const store = await import("@/lib/events/store");
    const calls: string[] = [];
    const sql = Object.assign(
      async (strings: TemplateStringsArray) => {
        const statement = strings.join("?").replace(/\s+/g, " ").trim();
        calls.push(statement);
        return [{ seq: "73" }];
      },
      {
        query: async () => [],
        unsafe: async () => [],
        transaction: async () => undefined,
        transactionScoped: true,
      },
    );

    const event = await store.appendDomainEvent(
      {
        id: "injected-sql-event",
        streamId: "ceremony:1",
        type: "ceremony.recorded",
        tenantId: "tenant-injected",
        actorId: "actor-injected",
      },
      { sql },
    );

    expect(event.seq).toBe(73);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("INSERT INTO omni_events");
  });

  it("survives append failures via the safe wrapper", async () => {
    const store = await import("@/lib/events/store");
    const result = await store.appendDomainEventSafely({ streamId: "ok", type: "ok" });
    expect(result?.streamId).toBe("ok");
  });
});
