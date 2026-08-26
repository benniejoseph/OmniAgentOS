import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "asael-mission-events-"));
  process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS = "true";
  process.env.OMNIAGENT_ALLOWED_READ_AUDIT_SAMPLE_RATE = "0";
  delete process.env.DATABASE_URL;
});

describe("mission event cursor route", () => {
  it("returns only the authorized actor's public mission lifecycle delta", async () => {
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

    const firstResponse = await GET(missionRequest(mission.id, owner), {
      params: Promise.resolve({ id: mission.id }),
    });
    expect(firstResponse.status).toBe(200);
    const firstPayload = await firstResponse.json() as {
      cursor: number;
      changed: boolean;
      mission: { status: string; updatedAt: string };
      events: Array<Record<string, unknown>>;
    };
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
