import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { MISSION_EVENT_SETTLE_MS } from "@/lib/missions/event-cursor";

type MissionEventsPayload = {
  cursor: number;
  changed: boolean;
  mission: { status: string; updatedAt: string };
  events: Array<{ seq: number; type: string; at: string }>;
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "asael-mission-events-"));
  process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS = "true";
  process.env.OMNIAGENT_ALLOWED_READ_AUDIT_SAMPLE_RATE = "0";
  delete process.env.DATABASE_URL;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mission event cursor route", () => {
  it("returns only the authorized actor's public mission lifecycle delta", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-10-01T08:00:00.000Z"));
    const { createMission, ensureMissionTask } = await import("@/lib/missions/store");
    const { GET } = await import("@/app/api/missions/[id]/events/route");
    const owner = { tenantId: "tenant-events", actorId: "actor-owner" };
    const mission = await createMission({
      ...owner,
      title: "Cursor mission",
      objective: "Keep the client projection fresh.",
    });
    await ensureMissionTask(mission.id, {
      sourceKey: "cursor-task",
      title: "Publish one lifecycle event",
    }, owner);
    vi.setSystemTime(Date.now() + MISSION_EVENT_SETTLE_MS);

    const firstResponse = await GET(missionRequest(mission.id, owner), {
      params: Promise.resolve({ id: mission.id }),
    });
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as MissionEventsPayload;
    expect(firstPayload.changed).toBe(true);
    expect(firstPayload.cursor).toBeGreaterThan(0);
    expect(firstPayload.events.map((event) => event.type)).toEqual([
      "mission.created",
      "mission.task.created",
    ]);
    expect(firstPayload.mission).toEqual({
      status: mission.status,
      updatedAt: mission.updatedAt,
    });
    expect(Object.keys(firstPayload.events[0]).sort()).toEqual(["at", "seq", "type"]);

    const caughtUpResponse = await GET(
      missionRequest(mission.id, owner, firstPayload.cursor),
      { params: Promise.resolve({ id: mission.id }) },
    );
    expect(await caughtUpResponse.json()).toMatchObject({
      cursor: firstPayload.cursor,
      changed: false,
      mission: {
        status: mission.status,
        updatedAt: mission.updatedAt,
      },
      events: [],
    });

    const otherActorResponse = await GET(
      missionRequest(mission.id, { ...owner, actorId: "actor-other" }),
      { params: Promise.resolve({ id: mission.id }) },
    );
    expect(otherActorResponse.status).toBe(404);

    const otherTenantResponse = await GET(
      missionRequest(mission.id, { tenantId: "tenant-other", actorId: owner.actorId }),
      { params: Promise.resolve({ id: mission.id }) },
    );
    expect(otherTenantResponse.status).toBe(404);
  });

  it("delivers a burst longer than one page, oldest first, over several reads", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-01T09:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { appendDomainEvent } = await import("@/lib/events/store");
    const { createMission } = await import("@/lib/missions/store");
    const { GET } = await import("@/app/api/missions/[id]/events/route");
    const owner = { tenantId: "tenant-events", actorId: "actor-burst" };
    const mission = await createMission({
      ...owner,
      title: "Burst mission",
      objective: "Report every step.",
    });
    const written = ["mission.created"];
    for (let step = 1; step <= 30; step += 1) {
      await appendDomainEvent({
        ...owner,
        streamId: `mission:${mission.id}`,
        type: `mission.step.${step}`,
      });
      written.push(`mission.step.${step}`);
      // Another stream's event takes the next number in between.
      await appendDomainEvent({
        ...owner,
        streamId: "mission:elsewhere",
        type: "mission.step",
      });
    }
    vi.setSystemTime(startedAt + MISSION_EVENT_SETTLE_MS);

    const pages: MissionEventsPayload[] = [];
    let cursor = 0;
    for (let read = 0; read < 3; read += 1) {
      const response = await GET(missionRequest(mission.id, owner, cursor), {
        params: Promise.resolve({ id: mission.id }),
      });
      const page = await response.json() as MissionEventsPayload;
      pages.push(page);
      cursor = page.cursor;
    }

    expect(pages.map((page) => page.events.length)).toEqual([25, 6, 0]);
    const delivered = pages.flatMap((page) => page.events);
    expect(delivered.map((event) => event.type)).toEqual(written);
    const seqs = delivered.map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((left, right) => left - right));
    expect(pages.map((page) => page.cursor)).toEqual([seqs[24], seqs[30], seqs[30]]);
  });

  it("keeps the cursor before an event too new to read past", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const startedAt = Date.parse("2026-10-01T10:00:00.000Z");
    vi.setSystemTime(startedAt);
    const { appendDomainEvent } = await import("@/lib/events/store");
    const { createMission } = await import("@/lib/missions/store");
    const { GET } = await import("@/app/api/missions/[id]/events/route");
    const owner = { tenantId: "tenant-events", actorId: "actor-late" };
    const mission = await createMission({
      ...owner,
      title: "Late mission",
      objective: "Report a step that lands late.",
    });
    const read = async (afterSeq: number) => {
      const response = await GET(missionRequest(mission.id, owner, afterSeq), {
        params: Promise.resolve({ id: mission.id }),
      });
      return await response.json() as MissionEventsPayload;
    };

    vi.setSystemTime(startedAt + MISSION_EVENT_SETTLE_MS);
    const settled = await read(0);
    expect(settled.events.map((event) => event.type)).toEqual(["mission.created"]);
    expect(settled.cursor).toBe(settled.events[0].seq);

    const step = await appendDomainEvent({
      ...owner,
      streamId: `mission:${mission.id}`,
      type: "mission.step.late",
    });
    vi.setSystemTime(startedAt + 2 * MISSION_EVENT_SETTLE_MS - 1);
    const young = await read(settled.cursor);
    expect(young).toMatchObject({ cursor: settled.cursor, changed: true });
    expect(young.events.map((event) => event.seq)).toEqual([step.seq]);

    vi.setSystemTime(startedAt + 2 * MISSION_EVENT_SETTLE_MS);
    const old = await read(settled.cursor);
    expect(old).toMatchObject({ cursor: step.seq, changed: true });
    expect(old.events.map((event) => event.seq)).toEqual([step.seq]);
  });
});

function missionRequest(
  missionId: string,
  owner: { tenantId: string; actorId: string },
  afterSeq = 0,
) {
  return new Request(
    `http://asael.test/api/missions/${encodeURIComponent(missionId)}/events?afterSeq=${afterSeq}`,
    {
      headers: {
        "x-omni-tenant-id": owner.tenantId,
        "x-omni-user-id": owner.actorId,
        "x-omni-user-role": "viewer",
      },
    },
  );
}
