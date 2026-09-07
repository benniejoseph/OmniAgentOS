import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendMissionTaskComment: vi.fn(),
  assertMissionTaskReadyForExecution: vi.fn(),
  attachMissionExecutor: vi.fn(),
  createMission: vi.fn(),
  createWorkflowRun: vi.fn(),
  enqueueWorkflowRunTick: vi.fn(),
  ensureMissionTask: vi.fn(),
  getMissionDetail: vi.fn(),
  getMissionTask: vi.fn(),
  getWorkflowRunDetail: vi.fn(),
  listAgentSkills: vi.fn(),
  listMissions: vi.fn(),
  listMissionSummariesForRequest: vi.fn(),
  resolveAgentIdentityForExecution: vi.fn(),
  scheduleWorkflowQueueDrain: vi.fn(),
}));

vi.mock("@/lib/missions/store", () => ({
  ...mocks,
  MissionConflictError: class MissionConflictError extends Error {},
  MissionTransitionError: class MissionTransitionError extends Error {},
}));
vi.mock("@/lib/missions/runtime", () => ({
  attachMissionExecutor: mocks.attachMissionExecutor,
}));
vi.mock("@/lib/agents/identity-store", () => ({
  resolveAgentIdentityForExecution: mocks.resolveAgentIdentityForExecution,
}));
vi.mock("@/lib/skills/store", () => ({
  listAgentSkills: mocks.listAgentSkills,
}));
vi.mock("@/lib/workflows/queue", () => ({
  enqueueWorkflowRunTick: mocks.enqueueWorkflowRunTick,
  scheduleWorkflowQueueDrain: mocks.scheduleWorkflowQueueDrain,
}));
vi.mock("@/lib/workflows/store", () => ({
  createWorkflowRun: mocks.createWorkflowRun,
  deterministicWorkflowRunId: vi.fn(() => "wf-task-start"),
  getWorkflowRunDetail: mocks.getWorkflowRunDetail,
}));
vi.mock("@/lib/workspaces/read-model", () => ({
  canonicalWorkItemStatuses: vi.fn(async (
    _tenantId: string,
    sourceAuthority: string,
    fallbacks: Array<Record<string, unknown>>,
  ) => new Map(fallbacks.map((fallback) => [fallback.sourceId, {
    schemaVersion: 1,
    authority: "canonical_work_item_v1",
    persistence: "postgres",
    workspaceId: "workspace-a",
    projectId: fallback.projectId,
    workItemId: fallback.workItemId,
    kind: fallback.kind,
    sourceAuthority,
    sourceId: fallback.sourceId,
    status: fallback.status,
    sourceStatus: fallback.sourceStatus,
    statusRevision: 1,
    updatedAt: fallback.updatedAt,
  }]))),
}));

import { createAppServiceCaller } from "@/lib/app-services/contracts";
import {
  commentOnMissionTaskService,
  createMissionTaskService,
  listMissionsService,
} from "@/lib/app-services/missions";
import { createExecutionScope } from "@/lib/security/execution-scope";

const context = {
  tenantId: "tenant-a",
  actorId: "actor-a",
  role: "operator" as const,
  source: "service" as const,
};
const executionScope = createExecutionScope({
  tenantId: context.tenantId,
  initiatingActorId: context.actorId,
  executingPrincipalType: "agent",
  executingPrincipalId: "main-agent",
  missionId: "11111111-1111-4111-8111-111111111111",
  correlationId: "correlation-a",
  purpose: "tool.mission.task.create",
});
const mission = {
  id: "11111111-1111-4111-8111-111111111111",
  tenantId: context.tenantId,
  actorId: context.actorId,
  title: "Mission",
  objective: "Objective",
  status: "running" as const,
  priority: "normal" as const,
  source: "user",
  sourceKey: "source-a",
  metadata: {},
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};
const task = {
  id: "22222222-2222-4222-8222-222222222222",
  missionId: mission.id,
  title: "Task",
  status: "triage" as const,
  priority: "normal" as const,
  position: 0,
  dependencyIds: [],
  metadata: {},
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listMissions.mockResolvedValue([mission]);
  mocks.ensureMissionTask.mockResolvedValue(task);
  mocks.getMissionTask.mockResolvedValue(task);
  mocks.listAgentSkills.mockResolvedValue([]);
  mocks.appendMissionTaskComment.mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    missionId: mission.id,
    taskId: task.id,
    kind: "task_comment",
    data: { body: "Done" },
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
  mocks.resolveAgentIdentityForExecution.mockResolvedValue({
    definition: {
      logicalAgentId: "atlas",
      name: "Atlas",
      role: "Orchestrator",
      description: "Plans and executes governed work.",
      instructions: "Complete the assigned work.",
      persona: {},
      modelPolicy: "auto",
      declaredSkills: [],
    },
    principal: {
      principalId: "agent:atlas:1",
      autonomy: "governed",
      approvalPolicy: "risk_based",
      memoryScope: "project",
      toolGrantIds: [],
      contextGrantIds: [],
      capabilityGrantIds: [],
    },
  });
  mocks.attachMissionExecutor.mockResolvedValue({
    id: "attempt-a",
    executorType: "workflow_run",
    executorId: "wf-task-start",
    status: "queued",
  });
  mocks.createWorkflowRun.mockResolvedValue({
    run: {
      id: "wf-task-start",
      status: "queued",
      input: { metadata: {
        missionTaskId: task.id,
        workItemId: task.id,
      } },
    },
  });
  mocks.enqueueWorkflowRunTick.mockResolvedValue({ id: "job-a" });
});

describe("P9.1 mission application service", () => {
  it("binds reads to the exact tenant and actor", async () => {
    const result = await listMissionsService(
      createAppServiceCaller({ context, executionScope }),
      { limit: 20 },
    );
    expect(mocks.listMissions).toHaveBeenCalledWith(20, {
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    expect(result.data.missions[0]).toMatchObject({ id: mission.id });
    expect(result.receipt.operation).toBe("missions.list");
  });

  it("uses the same validated, evented mutation boundary for task creation", async () => {
    const caller = createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "task-create-1",
    });
    const result = await createMissionTaskService(caller, {
      missionId: mission.id,
      title: "Task",
    });
    expect(mocks.ensureMissionTask).toHaveBeenCalledWith(
      mission.id,
      expect.objectContaining({
        sourceKey: expect.stringMatching(/^app-service:task:[a-f0-9]{64}$/),
        status: "triage",
      }),
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId: context.actorId,
        executionScope,
        idempotencyKey: "task-create-1",
      }),
    );
    expect(result.receipt).toMatchObject({
      operation: "mission.task.create",
      eventContract: "missions.atomic-events.v1",
    });
  });

  it("fails closed when a comment task is outside the mission", async () => {
    mocks.getMissionTask.mockResolvedValue({ ...task, missionId: crypto.randomUUID() });
    const result = await commentOnMissionTaskService(
      createAppServiceCaller({
        context,
        executionScope,
        idempotencyKey: "comment-1",
      }),
      { missionId: mission.id, taskId: task.id, body: "Done" },
    );
    expect(result.data.comment).toBeNull();
    expect(mocks.appendMissionTaskComment).not.toHaveBeenCalled();
  });

  it("starts an assigned WorkItem through one governed workflow", async () => {
    const assignedTask = {
      ...task,
      tenantId: context.tenantId,
      actorId: context.actorId,
      instructions: "Prepare the release notes.",
      definitionOfDone: "Every shipped change is covered.",
      status: "pending" as const,
      metadata: { assigneeKey: "atlas" },
    };
    mocks.assertMissionTaskReadyForExecution.mockResolvedValue(assignedTask);
    const { startMissionTaskService } = await import("@/lib/app-services/missions");
    const result = await startMissionTaskService(createAppServiceCaller({
      context,
      executionScope,
      idempotencyKey: "start-task-1",
    }), {
      missionId: mission.id,
      taskId: task.id,
      expectedUpdatedAt: task.updatedAt,
    });

    expect(mocks.createWorkflowRun).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `mission-task:${task.id}:start-task-1`,
      mode: "execute",
      metadata: expect.objectContaining({
        source: "mission_work_item",
        missionId: mission.id,
        missionTaskId: task.id,
        workItemId: task.id,
        workspaceId: "workspace-a",
        primaryAgentId: "atlas",
      }),
      executionAuthority: expect.objectContaining({
        executionScope: expect.objectContaining({
          executingPrincipalType: "agent",
          executingPrincipalId: "agent:atlas:1",
          workspaceId: "workspace-a",
          projectId: `mission_project:${mission.id}`,
          missionId: mission.id,
          causationId: task.id,
        }),
      }),
    }));
    expect(mocks.attachMissionExecutor).toHaveBeenCalledBefore(
      mocks.createWorkflowRun,
    );
    expect(mocks.enqueueWorkflowRunTick).toHaveBeenCalledWith(
      "wf-task-start",
      "mission_work_item_started",
      undefined,
      context.tenantId,
    );
    expect(result.data.execution).toMatchObject({
      authority: "governed_workflow_v1",
      workItemId: task.id,
      executorId: "wf-task-start",
    });
    expect(result.receipt.operation).toBe("mission.task.start");
  });
});
