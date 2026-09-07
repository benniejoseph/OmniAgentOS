import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  recordMissionArtifact: vi.fn(),
  listMissionArtifacts: vi.fn(async () => []),
  appendScopedDomainEvent: vi.fn(async () => ({ id: "event" })),
  persistenceAvailable: vi.fn(() => true),
  listTasks: vi.fn(async () => []),
}));

vi.mock("@/lib/missions/store", () => ({
  recordMissionArtifact: mocks.recordMissionArtifact,
  listMissionArtifacts: mocks.listMissionArtifacts,
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));
vi.mock("@/lib/delegation/store", () => ({
  delegationTaskPersistenceAvailable: mocks.persistenceAvailable,
  listDelegationTasksForExecution: mocks.listTasks,
}));

import {
  listDelegationChannelForTask,
  sendDelegationMessage,
  shareDelegationMissionArtifact,
} from "@/lib/delegation/channel-store";
import {
  buildDelegationTaskV1,
  transitionDelegationTaskV1,
} from "@/lib/delegation/lifecycle";
import { buildContract } from "@/lib/delegation/test-fixtures";
import { createExecutionScope } from "@/lib/security/execution-scope";

function task(delegationId = "delegation:one") {
  let value = buildDelegationTaskV1(buildContract({ delegationId }));
  value = transitionDelegationTaskV1({
    task: value,
    transition: { to: "accepted" },
    at: "2026-09-07T06:00:10.000Z",
  }).task;
  return transitionDelegationTaskV1({
    task: value,
    transition: { to: "working" },
    at: "2026-09-07T06:00:20.000Z",
  }).task;
}

function parentScope() {
  return createExecutionScope({
    tenantId: "tenant-one",
    initiatingActorId: "actor-one",
    executingPrincipalType: "agent",
    executingPrincipalId: "principal:atlas:1",
    missionId: "mission:one",
    correlationId: "run-one",
    purpose: "agent.run",
  });
}

describe("delegation Mission channel store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.persistenceAvailable.mockReturnValue(true);
    mocks.listMissionArtifacts.mockResolvedValue([]);
  });

  it("shares an artifact and emits content-free exact causation", async () => {
    mocks.recordMissionArtifact.mockImplementation(async (input) => ({
      id: "mission-artifact:one",
      kind: input.kind,
      data: input.data,
    }));
    const shared = await shareDelegationMissionArtifact({
      task: task(),
      parentExecutionScope: parentScope(),
      missionId: "mission:one",
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "analysis",
      title: "Findings",
      mediaType: "text/plain",
      content: "Bounded findings.",
      evidenceIds: ["evidence:one"],
      toolExecutionIds: ["tool:one"],
      createdAt: "2026-09-07T06:00:30.000Z",
    });
    expect(shared.artifactId).toMatch(/^delegation-artifact:/);
    expect(mocks.recordMissionArtifact).toHaveBeenCalledWith(expect.objectContaining({
      kind: "delegation_shared_artifact",
      sourceKey: shared.artifactId,
      executionScope: expect.objectContaining({
        executingPrincipalId: task().delegatePrincipalId,
        delegationId: task().delegationId,
      }),
    }));
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "delegation.artifact.shared",
      payload: expect.objectContaining({
        parentExecutionId: "run-one",
        taskId: task().taskId,
        toolExecutionIds: ["tool:one"],
      }),
    }));
    expect(JSON.stringify(mocks.appendScopedDomainEvent.mock.calls[0]?.[0]?.payload))
      .not.toContain("Bounded findings");
  });

  it("validates sibling recipients and referenced artifact visibility", async () => {
    const sender = task();
    const sibling = task("delegation:sibling");
    mocks.listTasks.mockResolvedValue([sender, sibling]);
    const shared = await (async () => {
      mocks.recordMissionArtifact.mockImplementation(async (input) => ({
        id: "stored",
        kind: input.kind,
        data: input.data,
      }));
      return shareDelegationMissionArtifact({
        task: sender,
        parentExecutionScope: parentScope(),
        missionId: "mission:one",
        recipients: { parent: true, delegationTaskIds: [sibling.taskId] },
        kind: "evidence",
        title: "Evidence",
        mediaType: "text/plain",
        content: "Evidence content.",
        createdAt: "2026-09-07T06:00:30.000Z",
      });
    })();
    mocks.listMissionArtifacts.mockResolvedValue([{
      id: "stored",
      tenantId: sender.tenantId,
      actorId: sender.ownerActorId,
      missionId: "mission:one",
      sourceKey: shared.artifactId,
      kind: "delegation_shared_artifact",
      title: shared.title,
      data: { protocol: shared },
      createdAt: shared.createdAt,
      updatedAt: shared.createdAt,
    }]);
    const message = await sendDelegationMessage({
      task: sibling,
      parentExecutionScope: parentScope(),
      missionId: "mission:one",
      recipients: { parent: true, delegationTaskIds: [sender.taskId] },
      kind: "handoff",
      body: "I reviewed the shared evidence.",
      artifactReferences: [{
        artifactId: shared.artifactId,
        artifactSha256: shared.artifactSha256,
      }],
      createdAt: "2026-09-07T06:00:40.000Z",
    });
    expect(message.artifactReferences).toHaveLength(1);
    await expect(listDelegationChannelForTask({
      task: sibling,
      parentExecutionScope: parentScope(),
      missionId: "mission:one",
    })).resolves.toHaveLength(1);
  });

  it("rejects an unproven sibling and a different Mission scope", async () => {
    mocks.listTasks.mockResolvedValue([task()]);
    await expect(sendDelegationMessage({
      task: task(),
      parentExecutionScope: parentScope(),
      missionId: "mission:one",
      recipients: { parent: false, delegationTaskIds: ["delegation-task:missing"] },
      kind: "question",
      body: "Can you review this?",
    })).rejects.toThrow(/active sibling/);
    await expect(sendDelegationMessage({
      task: task(),
      parentExecutionScope: parentScope(),
      missionId: "mission:other",
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "question",
      body: "Can the parent review this?",
    })).rejects.toThrow(/parent scope/);
  });

  it("records sibling-only delivery without claiming parent delivery", async () => {
    const sender = task();
    const sibling = task("delegation:sibling-only");
    mocks.listTasks.mockResolvedValue([sender, sibling]);
    mocks.recordMissionArtifact.mockImplementation(async (input) => ({
      id: "stored",
      kind: input.kind,
      data: input.data,
    }));
    await sendDelegationMessage({
      task: sender,
      parentExecutionScope: parentScope(),
      missionId: "mission:one",
      recipients: { parent: false, delegationTaskIds: [sibling.taskId] },
      kind: "progress",
      body: "Sibling-only progress update.",
      createdAt: "2026-09-07T06:00:40.000Z",
    });
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ recipientParent: false }),
    }));
  });
});
