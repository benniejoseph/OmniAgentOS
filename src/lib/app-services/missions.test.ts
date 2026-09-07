import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendMissionTaskComment: vi.fn(),
  createMission: vi.fn(),
  ensureMissionTask: vi.fn(),
  getMissionDetail: vi.fn(),
  getMissionTask: vi.fn(),
  listMissions: vi.fn(),
  listMissionSummariesForRequest: vi.fn(),
}));

vi.mock("@/lib/missions/store", () => mocks);

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
  mocks.appendMissionTaskComment.mockResolvedValue({
    id: "33333333-3333-4333-8333-333333333333",
    missionId: mission.id,
    taskId: task.id,
    kind: "task_comment",
    data: { body: "Done" },
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
  });
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
});
