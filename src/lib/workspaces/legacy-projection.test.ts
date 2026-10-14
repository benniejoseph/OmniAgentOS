import { describe, expect, it } from "vitest";
import type { Mission, MissionTask } from "@/lib/missions/types";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import {
  activeCompatibilityMapping,
  missionProjectCanonicalProjection,
  missionRootCanonicalProjection,
  missionTaskCanonicalProjection,
  projectCanonicalProjection,
  projectTaskCanonicalProjection,
} from "@/lib/workspaces/legacy-projection";

const now = "2026-09-07T12:00:00.000Z";
const authority = {
  workspaceId: "workspace:personal:123e4567-e89b-42d3-a456-426614174000",
  canonicalOwnerActorId: "actor:123e4567-e89b-42d3-a456-426614174000",
};
const project: PersonalProject = {
  id: "project-a", tenantId: "tenant-a", actorId: "owner@example.com",
  title: "Project", objective: "Objective", status: "active",
  autonomyMode: "manual", executionStatus: "idle", taskBudget: 12,
  tasksDispatched: 0, maxParallelTasks: 1, requireApproval: true,
  createdAt: now, updatedAt: now,
};
const task: ProjectTask = {
  id: "task-a", tenantId: "tenant-a", projectId: "project-a",
  title: "Task", detail: "Detail", status: "done", priority: "medium",
  agentId: "atlas", position: 0, origin: "manual", dependsOn: ["z", "a", "a"],
  workflowStatus: "completed", dispatchAttempt: 1,
  createdAt: now, updatedAt: now, completedAt: now,
};
const mission: Mission = {
  id: "mission-a", tenantId: "tenant-a", actorId: "owner@example.com",
  title: "Mission", objective: "Objective", status: "succeeded",
  priority: "high", source: "user", sourceKey: "mission-a", metadata: {},
  createdAt: now, updatedAt: now, terminalAt: now,
};
const missionTask: MissionTask = {
  id: "mission-task-a", tenantId: "tenant-a", actorId: "owner@example.com",
  missionId: "mission-a", title: "Mission task", instructions: "Do it",
  definitionOfDone: "Done", status: "blocked", priority: "normal", position: 0,
  sourceKey: "mission-task-a", dependencyIds: [], input: {},
  metadata: { assigneeKey: "atlas", scheduledAt: now },
  createdAt: now, updatedAt: now,
};

describe("legacy canonical work projections", () => {
  it("retains the deployed projection and source hashes when commitment fields are absent", () => {
    const value = projectTaskCanonicalProjection(project, task, [], authority, 1);
    expect(value.projectionSha256).toBe("3ac92a60b3823ec12c2b659b596fe87d8ba1dd852007970dcc02dcd8cb775227");
    expect(value.sourceRevisionSha256).toBe("a98ba9d88a6293f6ecb674b36eb9c89fa4c4b481400b115018a99e7a08775a28");
    expect(value.projection).not.toHaveProperty("humanOwner");
    expect(value.projection.schedule).not.toHaveProperty("dueDate");
  });

  it("projects named people separately from access owners and preserves date precision", () => {
    const value = projectTaskCanonicalProjection(project, { ...task, humanOwner: "Jonah Patel", dueDate: "2026-10-17", dueTimeZone: "Asia/Kolkata" }, [], authority, 1);
    expect(value.projection).toMatchObject({ humanOwner: "Jonah Patel", ownerActorIds: [authority.canonicalOwnerActorId], assignedAgents: [{ agentId: "atlas" }],
      schedule: { startsAt: null, dueAt: null, dueDate: "2026-10-17", timeZone: "Asia/Kolkata" } });
    expect(value.sourceRevisionSha256).not.toBe("a98ba9d88a6293f6ecb674b36eb9c89fa4c4b481400b115018a99e7a08775a28");
    const unknownZone = projectTaskCanonicalProjection(project, { ...task, dueDate: "2026-10-17" }, [], authority, 1);
    expect(unknownZone.projection.schedule).toMatchObject({ dueDate: "2026-10-17", dueAt: null, timeZone: null });
  });

  it("preserves Project and ProjectTask ids without claiming legacy success", () => {
    const canonicalProject = projectCanonicalProjection(project, authority, 1);
    const canonicalTask = projectTaskCanonicalProjection(project, task, [], authority, 1);
    expect(canonicalProject.projection.projectId).toBe(project.id);
    expect(canonicalTask.projection.workItemId).toBe(task.id);
    expect(canonicalTask.projection.canonicalStatus).toBe("unverified");
    expect(canonicalTask.projection.dependencyWorkItemIds).toEqual(["a", "z"]);
  });

  it("projects Mission as one Project plus a root milestone and child WorkItems", () => {
    const canonicalProject = missionProjectCanonicalProjection(mission, authority, 1);
    const root = missionRootCanonicalProjection(mission, [], authority, 1);
    const child = missionTaskCanonicalProjection(mission, missionTask, [], authority, 1);
    expect(canonicalProject.projection.projectId).toBe("mission_project:mission-a");
    expect(root.projection.workItemId).toBe("mission_root:mission-a");
    expect(root.projection.canonicalStatus).toBe("unverified");
    expect(child.projection.parentWorkItemId).toBe(root.projection.workItemId);
    expect(child.projection.canonicalStatus).toBe("blocked");
    expect(child.projection.assignedAgents[0]?.agentId).toBe("atlas");
  });

  it("binds compatibility records only to exact canonical targets", () => {
    const projected = projectTaskCanonicalProjection(project, task, [], authority, 2);
    const mapping = activeCompatibilityMapping({
      tenantId: task.tenantId,
      sourceKind: "legacy_project_task",
      sourceId: task.id,
      sourceOwnerActorId: project.actorId,
      sourceRevisionSha256: projected.sourceRevisionSha256,
      canonicalOwnerActorId: authority.canonicalOwnerActorId,
      workspaceId: authority.workspaceId,
      projectId: project.id,
      workItemId: task.id,
      revision: 2,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    });
    expect(mapping.state).toBe("active");
    expect(mapping.workItemId).toBe(task.id);
  });
});
