import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createMission,
  ensureMissionTask,
  getMissionDetail,
  transitionMissionAttempt,
} from "@/lib/missions/store";
import {
  attachMissionExecutor,
  syncMissionExecutor,
} from "@/lib/missions/runtime";

describe("mission executor bridge", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "asael-mission-runtime-"));
  });

  it("tracks an approval pause, resume, verified result, and artifact", async () => {
    const owner = { tenantId: "personal", actorId: "owner" };
    const mission = await createMission({
      ...owner,
      title: "Ship the brief",
      objective: "Produce one verified brief.",
      sourceKey: "turn:1",
    });
    const task = await ensureMissionTask(mission.id, {
      sourceKey: "turn:1",
      title: "Draft and verify",
    }, owner);
    await attachMissionExecutor({
      taskId: task.id,
      executorType: "agent_run",
      executorId: "run-1",
      status: "running",
    }, owner);
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-1",
      status: "waiting",
    }, owner);
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: "waiting" },
      tasks: [{ status: "blocked" }],
      attempts: [{ status: "waiting" }],
    });

    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-1",
      status: "running",
    }, owner);
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-1",
      status: "succeeded",
      output: { responseLength: 42, responseSha256: "a".repeat(64) },
    }, owner);
    const detail = await getMissionDetail(mission.id, owner);
    expect(detail).toMatchObject({
      mission: { status: "succeeded" },
      tasks: [{ status: "succeeded" }],
      attempts: [{ status: "succeeded" }],
      artifacts: [{ kind: "execution_receipt", data: { responseLength: 42 } }],
    });
  });

  it("repairs task, artifact, and mission projections when terminal sync is retried", async () => {
    const owner = { tenantId: "personal", actorId: "owner" };
    const mission = await createMission({
      ...owner,
      title: "Repair a partial completion",
      objective: "Reconcile every durable completion projection.",
      sourceKey: "turn:partial",
    });
    const task = await ensureMissionTask(mission.id, {
      sourceKey: "turn:partial",
      title: "Finish atomically",
    }, owner);
    const attempt = await attachMissionExecutor({
      taskId: task.id,
      executorType: "agent_run",
      executorId: "run-partial",
    }, owner);

    await transitionMissionAttempt(attempt.id, "succeeded", {
      fenceToken: attempt.fenceToken,
      output: { responseLength: 84, responseSha256: "b".repeat(64) },
    }, owner);
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: "draft" },
      tasks: [{ status: "pending" }],
      attempts: [{ status: "succeeded" }],
      artifacts: [],
    });

    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-partial",
      status: "succeeded",
      output: { ignoredRetryPatch: true },
    }, owner);
    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-partial",
      status: "succeeded",
    }, owner);

    const detail = await getMissionDetail(mission.id, owner);
    expect(detail).toMatchObject({
      mission: { status: "succeeded" },
      tasks: [{ status: "succeeded" }],
      attempts: [{ status: "succeeded", output: { responseLength: 84 } }],
      artifacts: [{
        kind: "execution_receipt",
        data: { responseLength: 84, responseSha256: "b".repeat(64) },
      }],
    });
    expect(detail?.artifacts).toHaveLength(1);
  });

  it("derives waiting and terminal mission state from every parallel task", async () => {
    const owner = { tenantId: "personal", actorId: "owner" };
    const mission = await createMission({
      ...owner,
      title: "Run parallel specialists",
      objective: "Wait for every specialist before deciding the mission outcome.",
      sourceKey: "turn:parallel",
    });
    const firstTask = await ensureMissionTask(mission.id, {
      sourceKey: "turn:parallel:first",
      title: "First specialist",
      position: 0,
    }, owner);
    const secondTask = await ensureMissionTask(mission.id, {
      sourceKey: "turn:parallel:second",
      title: "Second specialist",
      position: 1,
    }, owner);
    await attachMissionExecutor({
      taskId: firstTask.id,
      executorType: "agent_run",
      executorId: "run-first",
      status: "running",
    }, owner);
    await attachMissionExecutor({
      taskId: secondTask.id,
      executorType: "agent_run",
      executorId: "run-second",
      status: "running",
    }, owner);

    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-first",
      status: "waiting",
    }, owner);
    expect((await getMissionDetail(mission.id, owner))?.mission.status).toBe("running");

    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-first",
      status: "failed",
      error: "Specialist failed.",
    }, owner);
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: "running" },
      tasks: [{ status: "failed" }, { status: "running" }],
    });

    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-second",
      status: "waiting",
    }, owner);
    expect((await getMissionDetail(mission.id, owner))?.mission.status).toBe("waiting");

    await syncMissionExecutor({
      executorType: "agent_run",
      executorId: "run-second",
      status: "succeeded",
      output: { verified: true },
    }, owner);
    expect(await getMissionDetail(mission.id, owner)).toMatchObject({
      mission: { status: "failed" },
      tasks: [{ status: "failed" }, { status: "succeeded" }],
    });
  });
});
