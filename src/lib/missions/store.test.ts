import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { listStreamEvents } from "@/lib/events/store";
import {
  createMission,
  ensureMissionTask,
  getMission,
  getMissionDetail,
  listMissions,
  MissionConflictError,
  MissionNotFoundError,
  MissionTransitionError,
  recordMissionArtifact,
  startMissionAttempt,
  transitionMission,
  transitionMissionAttempt,
  transitionMissionTask,
} from "@/lib/missions/store";

describe("unified mission kernel", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(os.tmpdir(), "asael-missions-"));
  });

  it("runs an idempotent, fenced lifecycle and records compact events", async () => {
    const owner = { tenantId: "personal", actorId: "bennie" };
    const mission = await createMission({
      ...owner,
      title: "Prepare the launch brief",
      objective: "Produce a verified launch brief and evidence bundle.",
      sourceKey: "chat:launch-brief",
      priority: "high",
    });
    const duplicateMission = await createMission({
      ...owner,
      title: "This title is ignored by idempotency",
      objective: "This objective is ignored too.",
      sourceKey: "chat:launch-brief",
    });
    expect(duplicateMission.id).toBe(mission.id);
    expect((await listMissions(20, owner)).map((item) => item.id)).toEqual([mission.id]);

    const runningMission = await transitionMission(mission.id, "running", owner);
    expect(runningMission.startedAt).toBeTruthy();

    const task = await ensureMissionTask(mission.id, {
      sourceKey: "plan:research",
      title: "Research launch evidence",
      definitionOfDone: "Every claim has a source.",
      input: { query: "launch evidence" },
    }, owner);
    const duplicateTask = await ensureMissionTask(mission.id, {
      sourceKey: "plan:research",
      title: "Duplicate task",
    }, owner);
    expect(duplicateTask.id).toBe(task.id);
    await transitionMissionTask(task.id, "running", owner);

    const attempt = await startMissionAttempt(task.id, {
      executorKey: "workflow:research:v1",
      executorId: "research-agent",
      executorType: "agent",
    }, owner);
    const duplicateAttempt = await startMissionAttempt(task.id, {
      executorKey: "workflow:research:v1",
      executorId: "ignored-agent",
    }, owner);
    expect(duplicateAttempt.id).toBe(attempt.id);
    expect(duplicateAttempt.fenceToken).toBe(attempt.fenceToken);

    await expect(transitionMissionAttempt(attempt.id, "running", {
      fenceToken: "stale-token",
    }, owner)).rejects.toBeInstanceOf(MissionConflictError);

    const runningAttempt = await transitionMissionAttempt(attempt.id, "running", {
      fenceToken: attempt.fenceToken,
    }, owner);
    const completedAttempt = await transitionMissionAttempt(attempt.id, "succeeded", {
      fenceToken: attempt.fenceToken,
      output: { claims: 4, verified: true },
    }, owner);
    expect(runningAttempt.startedAt).toBeTruthy();
    expect(completedAttempt.output).toEqual({ claims: 4, verified: true });
    expect(completedAttempt.terminalAt).toBeTruthy();
    await expect(transitionMissionAttempt(attempt.id, "failed", {
      fenceToken: attempt.fenceToken,
    }, owner)).rejects.toBeInstanceOf(MissionTransitionError);
    await expect(transitionMissionAttempt(attempt.id, "succeeded", {
      fenceToken: attempt.fenceToken,
      output: { overwritten: true },
    }, owner)).rejects.toThrow(/immutable/i);

    await transitionMissionTask(task.id, "succeeded", owner);
    await expect(startMissionAttempt(task.id, {
      executorKey: "workflow:research:v2",
      executorId: "research-agent",
    }, owner)).rejects.toBeInstanceOf(MissionTransitionError);

    const artifact = await recordMissionArtifact({
      ...owner,
      missionId: mission.id,
      taskId: task.id,
      attemptId: attempt.id,
      sourceKey: "attempt:research:result",
      kind: "report",
      title: "Launch evidence report",
      mimeType: "application/json",
      data: { claims: 4, verified: true },
    });
    const duplicateArtifact = await recordMissionArtifact({
      ...owner,
      missionId: mission.id,
      sourceKey: "attempt:research:result",
      title: "Duplicate result",
      data: { overwritten: true },
    });
    expect(duplicateArtifact.id).toBe(artifact.id);
    expect(duplicateArtifact.data).toEqual({ claims: 4, verified: true });

    const detail = await getMissionDetail(mission.id, owner);
    expect(detail).toMatchObject({
      mission: { id: mission.id, status: "running" },
      tasks: [{ id: task.id, status: "succeeded" }],
      attempts: [{ id: attempt.id, status: "succeeded" }],
      artifacts: [{ id: artifact.id }],
    });

    const completedMission = await transitionMission(mission.id, "succeeded", owner);
    expect(completedMission.terminalAt).toBeTruthy();
    await expect(ensureMissionTask(mission.id, {
      sourceKey: "plan:research",
      title: "Cannot re-ensure on a terminal mission",
    }, owner)).rejects.toBeInstanceOf(MissionTransitionError);
    await expect(transitionMission(mission.id, "running", owner))
      .rejects.toBeInstanceOf(MissionTransitionError);
    expect((await transitionMission(mission.id, "archived", owner)).status).toBe("archived");

    const events = await listStreamEvents(`mission:${mission.id}`, {
      tenantId: owner.tenantId,
    });
    expect(events.map((event) => event.type)).toEqual([
      "mission.created",
      "mission.status.changed",
      "mission.task.created",
      "mission.task.status.changed",
      "mission.attempt.created",
      "mission.attempt.status.changed",
      "mission.attempt.status.changed",
      "mission.task.status.changed",
      "mission.artifact.recorded",
      "mission.status.changed",
      "mission.status.changed",
    ]);
    expect(events.every((event) => !("objective" in event.payload))).toBe(true);
  });

  it("isolates missions and child writes by tenant and actor", async () => {
    const bennie = { tenantId: "personal", actorId: "bennie" };
    const otherActor = { tenantId: "personal", actorId: "other" };
    const otherTenant = { tenantId: "other-tenant", actorId: "bennie" };
    const first = await createMission({
      ...bennie,
      title: "Private mission",
      objective: "Private objective",
      sourceKey: "shared-source-key",
    });
    const second = await createMission({
      ...otherActor,
      title: "Other actor mission",
      objective: "Other objective",
      sourceKey: "shared-source-key",
    });
    const third = await createMission({
      ...otherTenant,
      title: "Other tenant mission",
      objective: "Other tenant objective",
      sourceKey: "shared-source-key",
    });

    expect(new Set([first.id, second.id, third.id]).size).toBe(3);
    expect(await getMission(first.id, otherActor)).toBeUndefined();
    expect(await getMission(first.id, otherTenant)).toBeUndefined();
    expect((await listMissions(20, bennie)).map((item) => item.id)).toEqual([first.id]);
    await expect(ensureMissionTask(first.id, {
      sourceKey: "foreign-task",
      title: "Cannot attach",
    }, otherActor)).rejects.toBeInstanceOf(MissionNotFoundError);
  });

  it("only archives missions after an outcome is terminal", async () => {
    const owner = { tenantId: "personal", actorId: "bennie" };
    const draft = await createMission({
      ...owner,
      title: "Draft mission",
      objective: "Remain active until work has a terminal outcome.",
      sourceKey: "archive:draft",
    });
    await expect(transitionMission(draft.id, "archived", owner))
      .rejects.toBeInstanceOf(MissionTransitionError);
    await transitionMission(draft.id, "running", owner);
    await expect(transitionMission(draft.id, "archived", owner))
      .rejects.toBeInstanceOf(MissionTransitionError);
    await transitionMission(draft.id, "canceled", owner);
    expect((await transitionMission(draft.id, "archived", owner)).status).toBe("archived");
  });
});
