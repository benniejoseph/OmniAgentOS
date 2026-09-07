import { describe, expect, it } from "vitest";

import {
  buildConversationCanvasProjection,
  type ConversationCanvasSource,
} from "@/lib/conversations/canvas";

const NOW = "2026-09-07T15:00:00.000Z";

function source(): ConversationCanvasSource {
  return {
    threads: [{
      id: "thread-1",
      title: "Launch plan",
      mode: "orchestrate",
      projectId: "project-1",
      updatedAt: NOW,
    }],
    runs: [
      {
        id: "run-1",
        threadId: "thread-1",
        mode: "orchestrate",
        status: "completed",
        agentId: "atlas",
        startedAt: NOW,
        completedAt: NOW,
        contextGrantCount: 2,
      },
      {
        id: "run-2",
        threadId: "thread-1",
        mode: "orchestrate",
        status: "completed",
        agentId: "atlas",
        startedAt: NOW,
        completedAt: NOW,
        contextGrantCount: 0,
      },
    ],
    forks: [{
      forkId: "fork-1",
      sourceRunId: "run-1",
      targetRunId: "run-2",
      checkpointId: "checkpoint-1",
      checkpointSequence: 1,
      boundaryKind: "verifier",
      createdAt: NOW,
    }],
    delegations: [
      {
        taskId: "task-1",
        parentExecutionId: "run-2",
        parentDelegationId: null,
        delegationId: "delegation-1",
        delegateAgentId: "sentinel",
        delegateDefinitionVersion: 3,
        state: "result_accepted",
        lifecycleRevision: 4,
        updatedAt: NOW,
      },
      {
        taskId: "task-2",
        parentExecutionId: "run-2",
        parentDelegationId: "delegation-1",
        delegationId: "delegation-2",
        delegateAgentId: "nexus",
        delegateDefinitionVersion: 2,
        state: "working",
        lifecycleRevision: 2,
        updatedAt: NOW,
      },
    ],
    projects: [{
      id: "project-1",
      title: "Release",
      status: "active",
      artifactCount: 1,
      updatedAt: NOW,
    }],
    projectArtifacts: [{
      id: "artifact-project-1",
      projectId: "project-1",
      title: "Release report",
      status: "verified",
      agentId: "atlas",
      updatedAt: NOW,
    }],
    sharedArtifacts: [{
      artifactId: "artifact-shared-1",
      artifactSha256: "a".repeat(64),
      missionId: "mission-1",
      parentExecutionId: "run-2",
      senderTaskId: "task-1",
      recipientTaskIds: ["task-2"],
      kind: "report",
      title: "Verifier report",
      createdAt: NOW,
    }],
    truncated: { runs: false, forks: false, delegations: false, sharedArtifacts: false },
  };
}

describe("P11.3 Conversation canvas projection", () => {
  it("maps every visual edge to a canonical relationship", () => {
    const projection = buildConversationCanvasProjection({ source: source(), generatedAt: NOW });

    expect(projection.version).toBe("p11.3-conversation-canvas:1");
    expect(projection.counts).toEqual({
      conversation: 1,
      run: 2,
      project: 1,
      delegation: 2,
      artifact: 2,
    });
    expect(new Set(projection.edges.map((edge) => edge.kind))).toEqual(new Set([
      "conversation_run",
      "run_fork",
      "conversation_project",
      "project_artifact",
      "run_delegation",
      "delegation_parent",
      "delegation_artifact_produced",
      "delegation_artifact_shared",
    ]));
    expect(projection.edges.every((edge) =>
      edge.authority.length > 0 &&
      edge.relationshipId.length > 0 &&
      edge.contextAccess.state === "not_implied"
    )).toBe(true);
  });

  it("shows context only from exact run grant counts", () => {
    const projection = buildConversationCanvasProjection({ source: source(), generatedAt: NOW });
    const first = projection.nodes.find((node) => node.id === "run:run-1");
    const second = projection.nodes.find((node) => node.id === "run:run-2");

    expect(first?.contextAccess).toMatchObject({ state: "granted", grantCount: 2 });
    expect(second?.contextAccess).toMatchObject({ state: "none", grantCount: 0 });
    expect(projection.memoryBoundary.grantedRunCount).toBe(1);
  });

  it("does not invent dangling fork or artifact relationships", () => {
    const value = source();
    const projection = buildConversationCanvasProjection({
      generatedAt: NOW,
      source: {
        ...value,
        forks: [{ ...value.forks[0], targetRunId: "missing" }],
        sharedArtifacts: [{
          ...value.sharedArtifacts[0],
          senderTaskId: "missing",
          recipientTaskIds: ["also-missing"],
        }],
      },
    });

    expect(projection.edges.some((edge) => edge.kind === "run_fork")).toBe(false);
    expect(projection.nodes.some((node) => node.entityId === "artifact-shared-1")).toBe(false);
  });
});
