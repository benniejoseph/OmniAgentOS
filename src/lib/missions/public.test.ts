import { describe, expect, it } from "vitest";
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
});

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
