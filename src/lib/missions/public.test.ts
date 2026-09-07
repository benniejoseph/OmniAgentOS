import { describe, expect, it } from "vitest";
import {
  buildDelegationMessageV1,
  buildSharedMissionArtifactV1,
} from "@/lib/delegation/channel";
import {
  buildDelegationTaskV1,
  transitionDelegationTaskV1,
} from "@/lib/delegation/lifecycle";
import { buildContract } from "@/lib/delegation/test-fixtures";
import { toMissionDetailView } from "@/lib/missions/public";
import type { MissionDetail } from "@/lib/missions/types";

describe("browser-safe mission projections", () => {
  it("omits ownership, fences, raw executor payloads, and artifact bodies", () => {
    const detail = fixture();
    const view = toMissionDetailView(detail);
    const serialized = JSON.stringify(view);

    expect(view.mission).not.toHaveProperty("tenantId");
    expect(view.mission).not.toHaveProperty("actorId");
    expect(view.attempts[0]).not.toHaveProperty("fenceToken");
    expect(view.attempts[0]).not.toHaveProperty("input");
    expect(view.attempts[0]).not.toHaveProperty("output");
    expect(view.artifacts[0]).not.toHaveProperty("data");
    expect(serialized).not.toContain("secret-fence");
    expect(serialized).not.toContain("private executor input");
    expect(serialized).not.toContain("private artifact body");
  });

  it("exposes only explicitly shared channel content without principal authority", () => {
    const detail = fixture();
    const task = workingDelegationTask();
    const shared = buildSharedMissionArtifactV1({
      task,
      missionId: detail.mission.id,
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "analysis",
      title: "Bounded findings",
      mediaType: "text/plain",
      content: "Explicitly shared findings.",
      createdAt: "2026-09-07T06:00:30.000Z",
    });
    const message = buildDelegationMessageV1({
      task,
      missionId: detail.mission.id,
      recipients: { parent: true, delegationTaskIds: [] },
      kind: "handoff",
      body: "Proposal ready for review.",
      artifactReferences: [{
        artifactId: shared.artifactId,
        artifactSha256: shared.artifactSha256,
      }],
      createdAt: "2026-09-07T06:00:40.000Z",
    });
    detail.artifacts.push(
      {
        id: "artifact-shared",
        tenantId: detail.mission.tenantId,
        actorId: detail.mission.actorId,
        missionId: detail.mission.id,
        sourceKey: shared.artifactId,
        kind: "delegation_shared_artifact",
        title: shared.title,
        data: { protocol: shared },
        createdAt: shared.createdAt,
        updatedAt: shared.createdAt,
      },
      {
        id: "artifact-message",
        tenantId: detail.mission.tenantId,
        actorId: detail.mission.actorId,
        missionId: detail.mission.id,
        sourceKey: message.messageId,
        kind: "delegation_message",
        title: "Scout handoff",
        data: { protocol: message },
        createdAt: message.createdAt,
        updatedAt: message.createdAt,
      },
    );

    const view = toMissionDetailView(detail);
    expect(view.artifacts[1].data).toMatchObject({
      content: "Explicitly shared findings.",
      sender: { agentId: task.delegateAgentId },
      boundary: { contentIsUntrusted: true, authorityImpact: "none" },
    });
    expect(view.artifacts[2].data).toMatchObject({
      body: "Proposal ready for review.",
      sender: { agentId: task.delegateAgentId },
    });
    expect(JSON.stringify(view.artifacts.slice(1))).not.toContain(
      task.delegatePrincipalId,
    );
  });
});

function workingDelegationTask() {
  const baseContract = buildContract();
  let task = buildDelegationTaskV1(buildContract({
    scope: { ...baseContract.scope, missionId: "mission-1" },
  }));
  task = transitionDelegationTaskV1({
    task,
    transition: { to: "accepted" },
    at: "2026-09-07T06:00:10.000Z",
  }).task;
  return transitionDelegationTaskV1({
    task,
    transition: { to: "working" },
    at: "2026-09-07T06:00:20.000Z",
  }).task;
}

function fixture(): MissionDetail {
  const now = "2026-08-26T00:00:00.000Z";
  return {
    mission: {
      id: "mission-1",
      tenantId: "private-tenant",
      actorId: "private-actor",
      title: "Prepare a brief",
      objective: "Produce an evidence-backed brief.",
      status: "running",
      priority: "normal",
      source: "user",
      sourceKey: "private-source-key",
      metadata: { private: true },
      createdAt: now,
      updatedAt: now,
    },
    tasks: [{
      id: "task-1",
      tenantId: "private-tenant",
      actorId: "private-actor",
      missionId: "mission-1",
      title: "Research",
      instructions: "Collect evidence.",
      definitionOfDone: "Sources recorded.",
      status: "running",
      priority: "normal",
      position: 0,
      sourceKey: "private-task-key",
      dependencyIds: [],
      input: { private: true },
      metadata: { private: true },
      createdAt: now,
      updatedAt: now,
    }],
    attempts: [{
      id: "attempt-1",
      tenantId: "private-tenant",
      actorId: "private-actor",
      missionId: "mission-1",
      taskId: "task-1",
      executorKey: "agent_run:run-1",
      executorType: "agent_run",
      executorId: "run-1",
      fenceToken: "secret-fence",
      status: "running",
      agentRunId: "run-1",
      input: { value: "private executor input" },
      output: { value: "private executor output" },
      createdAt: now,
      updatedAt: now,
    }],
    artifacts: [{
      id: "artifact-1",
      tenantId: "private-tenant",
      actorId: "private-actor",
      missionId: "mission-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      sourceKey: "private-artifact-key",
      kind: "execution_receipt",
      title: "Research result",
      data: { value: "private artifact body" },
      createdAt: now,
      updatedAt: now,
    }],
  };
}
