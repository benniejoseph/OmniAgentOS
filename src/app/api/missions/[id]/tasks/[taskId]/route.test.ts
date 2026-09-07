import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-mission-task-status-"),
  );
  process.env.OMNIAGENT_TRUST_UNSIGNED_IDENTITY_HEADERS = "true";
  process.env.OMNIAGENT_ALLOWED_READ_AUDIT_SAMPLE_RATE = "0";
  delete process.env.DATABASE_URL;
});

describe("Mission task status authority", () => {
  it("rejects manual execution status for assigned work", async () => {
    const { createMission, ensureMissionTask } = await import(
      "@/lib/missions/store"
    );
    const { PATCH } = await import(
      "@/app/api/missions/[id]/tasks/[taskId]/route"
    );
    const owner = { tenantId: "tenant-status", actorId: "actor-owner" };
    const mission = await createMission({
      ...owner,
      title: "Governed status",
      objective: "Keep executor state authoritative.",
    });
    const task = await ensureMissionTask(mission.id, {
      sourceKey: "assigned-task",
      title: "Assigned task",
      status: "pending",
      metadata: { assigneeKey: "atlas" },
    }, owner);

    const response = await PATCH(taskRequest(mission.id, task.id, owner, {
      expectedUpdatedAt: task.updatedAt,
      status: "running",
    }), {
      params: Promise.resolve({ id: mission.id, taskId: task.id }),
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "Assigned task progress is controlled by its governed execution.",
    });
  });

  it("retains manual status for unassigned work", async () => {
    const { createMission, ensureMissionTask } = await import(
      "@/lib/missions/store"
    );
    const { PATCH } = await import(
      "@/app/api/missions/[id]/tasks/[taskId]/route"
    );
    const owner = { tenantId: "tenant-status", actorId: "actor-owner" };
    const mission = await createMission({
      ...owner,
      title: "Human status",
      objective: "Allow explicitly unassigned work.",
    });
    const task = await ensureMissionTask(mission.id, {
      sourceKey: "human-task",
      title: "Human task",
      status: "pending",
    }, owner);

    const response = await PATCH(taskRequest(mission.id, task.id, owner, {
      expectedUpdatedAt: task.updatedAt,
      status: "running",
    }), {
      params: Promise.resolve({ id: mission.id, taskId: task.id }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      task: { id: task.id, status: "running" },
    });
  });
});

function taskRequest(
  missionId: string,
  taskId: string,
  owner: { tenantId: string; actorId: string },
  body: Record<string, unknown>,
) {
  return new Request(
    `http://asael.test/api/missions/${missionId}/tasks/${taskId}`,
    {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-omni-tenant-id": owner.tenantId,
        "x-omni-user-id": owner.actorId,
        "x-omni-user-role": "admin",
      },
      body: JSON.stringify(body),
    },
  );
}
