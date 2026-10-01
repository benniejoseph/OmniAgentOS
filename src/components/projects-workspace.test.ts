import { describe, expect, it } from "vitest";
import {
  nextProjectTaskStatus,
  normalizeProjects,
  withRefreshedProject,
} from "@/components/projects-workspace";

const status = {
  schemaVersion: 1,
  authority: "canonical_work_item_v1",
  persistence: "postgres",
  workspaceId: "workspace:personal:test",
  projectId: "project-a",
  workItemId: "task-a",
  kind: "task",
  sourceAuthority: "legacy_project_task",
  sourceId: "task-a",
  status: "running",
  sourceStatus: "doing:running",
  statusRevision: 2,
  updatedAt: "2026-09-07T12:00:00.000Z",
} as const;

const workItem = {
  version: "p11.4-work-item-surface:1",
  projection: {
    authority: "canonical_work_item_v1",
    sha256: "a".repeat(64),
    sourceRevisionSha256: "b".repeat(64),
  },
  status,
  assignment: {
    authority: "canonical_work_item_v1",
    agents: [{ agentId: "atlas", principalId: null, principalGeneration: null }],
  },
  artifacts: {
    authority: "canonical_work_item_v1",
    count: 1,
    items: [{ artifactId: "artifact-a", kind: "project_artifact", evidenceCount: 1 }],
  },
  execution: {
    authority: "governed_workflow_v1",
    availability: "current",
    workflowRunId: "workflow-a",
    sourceStatus: "running",
    currentStep: "execute",
    completedSteps: 3,
    totalSteps: 6,
    progressPercent: 50,
    updatedAt: "2026-09-07T12:00:00.000Z",
  },
  cost: {
    authority: "ai_usage_ledger_v1",
    state: "known",
    usageReceiptCount: 1,
    unknownCostReceiptCount: 0,
    totalTokens: 2_400,
    knownEstimatedCostMicrousd: 125_000,
  },
} as const;

const project = {
  id: "project-a",
  tasks: [{ id: "task-a", workItemStatus: status, workItem }],
  artifacts: [{ id: "artifact-a" }],
};
const canonicalWorkItem = normalizeProjects([project])![0]!.tasks[0]!.workItem;

describe("Projects canonical WorkItem boundary", () => {
  it("accepts the pinned canonical truth shared with Missions", () => {
    expect(normalizeProjects([project])?.[0].tasks[0].workItem).toMatchObject({
      version: "p11.4-work-item-surface:1",
      assignment: { agents: [{ agentId: "atlas" }] },
      artifacts: { count: 1 },
      execution: { progressPercent: 50 },
      cost: { state: "known", knownEstimatedCostMicrousd: 125_000 },
    });
  });

  it("rejects drifted or incomplete WorkItem truth", () => {
    expect(normalizeProjects([{ ...project, tasks: [{
      ...project.tasks[0],
      workItem: { ...workItem, version: "p11.4-work-item-surface:2" },
    }] }])).toBeUndefined();
    expect(normalizeProjects([{ ...project, tasks: [{
      ...project.tasks[0],
      workItemStatus: { ...status, status: "succeeded" },
    }] }])).toBeUndefined();
    expect(normalizeProjects([{ ...project, tasks: [{
      ...project.tasks[0],
      workItem: { ...workItem, cost: undefined },
    }] }])).toBeUndefined();
  });
});

describe("Projects task transitions", () => {
  it("reopens terminal canonical work instead of advancing a stale legacy status", () => {
    expect(nextProjectTaskStatus({
      status: "open",
      workItem: { ...canonicalWorkItem, status: { ...canonicalWorkItem.status, status: "failed", sourceStatus: "doing:failed" } },
    })).toBe("open");
  });

  it("advances active canonical work through doing and done", () => {
    expect(nextProjectTaskStatus({ status: "open", workItem: canonicalWorkItem })).toBe("done");
    expect(nextProjectTaskStatus({
      status: "open",
      workItem: {
        ...canonicalWorkItem,
        status: { ...canonicalWorkItem.status, status: "waiting", sourceStatus: "open:queued" },
        execution: { ...canonicalWorkItem.execution, availability: "unavailable" },
      },
    })).toBe("doing");
  });
});

describe("Projects refreshed from the server", () => {
  function taskWith(id: string, sourceStatus: string) {
    const taskStatus = { ...status, workItemId: id, sourceId: id, sourceStatus };
    return {
      id,
      workItemStatus: taskStatus,
      workItem: { ...workItem, status: taskStatus },
    };
  }
  const known = normalizeProjects([
    {
      id: "project-a",
      executionStatus: "running",
      tasks: [taskWith("task-a", "doing:running"), taskWith("task-b", "open:queued")],
      artifacts: [{ id: "artifact-b" }, { id: "artifact-a" }],
    },
    { id: "project-b", executionStatus: "running", tasks: [], artifacts: [] },
  ])!;

  it("takes what the read returns and keeps what it left out", () => {
    const refreshed = withRefreshedProject(known, "project-a", {
      id: "project-a",
      executionStatus: "waiting_approval",
      tasks: [taskWith("task-a", "doing:waiting_approval"), taskWith("task-c", "open:queued")],
      artifacts: [{ id: "artifact-c" }, { id: "artifact-b", verdict: "useful" }],
    });

    expect(refreshed[0]).toMatchObject({ id: "project-a", executionStatus: "waiting_approval" });
    expect(refreshed[0]!.tasks.map((task) => [task.id, task.workItem.status.sourceStatus])).toEqual([
      ["task-a", "doing:waiting_approval"],
      ["task-c", "open:queued"],
      ["task-b", "open:queued"],
    ]);
    expect(refreshed[0]!.artifacts).toEqual([
      { id: "artifact-c" },
      { id: "artifact-b", verdict: "useful" },
      { id: "artifact-a" },
    ]);
    expect(refreshed[1]).toBe(known[1]);
  });

  it("ignores a read of another project or one it cannot trust", () => {
    expect(withRefreshedProject(known, "project-a", {
      id: "project-b",
      executionStatus: "completed",
      tasks: [],
      artifacts: [],
    })).toBe(known);
    expect(withRefreshedProject(known, "project-a", {
      id: "project-a",
      executionStatus: "completed",
      tasks: [{ ...taskWith("task-a", "done:completed"), workItemStatus: { ...status, status: "failed" } }],
      artifacts: [],
    })).toBe(known);
    expect(withRefreshedProject(known, "project-a", undefined)).toBe(known);
  });
});
