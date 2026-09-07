import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(),
}));

vi.mock("@/lib/db/client", () => db);

import {
  canonicalWorkItemStatuses,
  canonicalWorkItemSurfaces,
} from "@/lib/workspaces/read-model";

const fallback = {
  projectId: "project-a",
  workItemId: "task-a",
  kind: "task" as const,
  sourceId: "task-a",
  status: "waiting" as const,
  sourceStatus: "open",
  updatedAt: "2026-09-07T12:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  db.hasDatabaseUrl.mockReturnValue(false);
});

describe("canonical WorkItem status reads", () => {
  it("keeps one canonical projection in local development", async () => {
    const views = await canonicalWorkItemStatuses(
      "tenant-a",
      "legacy_project_task",
      [fallback],
    );
    expect(views.get("task-a")).toMatchObject({
      authority: "canonical_work_item_v1",
      persistence: "local_projection",
      status: "waiting",
      sourceStatus: "open",
    });
  });

  it("reads and cross-checks the persisted canonical projection", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    db.getSql.mockReturnValue(async () => [{
      source_id: "task-a",
      workspace_id: "workspace:personal:123e4567-e89b-42d3-a456-426614174000",
      project_id: "project-a",
      work_item_id: "task-a",
      kind: "task",
      canonical_status: "waiting",
      source_status: "open",
      status_revision: 3,
      updated_at: fallback.updatedAt,
      source_revision_sha256: "a".repeat(64),
      projection_sha256: "b".repeat(64),
      projection: {
        schemaVersion: 1,
        tenantId: "tenant-a",
        workspaceId: "workspace:personal:123e4567-e89b-42d3-a456-426614174000",
        projectId: "project-a",
        workItemId: "task-a",
        parentWorkItemId: null,
        kind: "task",
        title: "Task",
        detail: "",
        priority: "medium",
        canonicalStatus: "waiting",
        sourceStatus: "open",
        statusRevision: 3,
        sourceAuthority: "legacy_project_task",
        dependencyWorkItemIds: [],
        ownerActorIds: ["actor:123e4567-e89b-42d3-a456-426614174000"],
        assignedAgents: [],
        schedule: { startsAt: null, dueAt: null, timeZone: null },
        recurrence: null,
        risks: [],
        decisions: [],
        artifacts: [],
        createdAt: fallback.updatedAt,
        updatedAt: fallback.updatedAt,
        terminalAt: null,
      },
    }]);
    const views = await canonicalWorkItemStatuses(
      "tenant-a",
      "legacy_project_task",
      [fallback],
    );
    expect(db.ensureDatabaseSchema).toHaveBeenCalledOnce();
    expect(views.get("task-a")).toMatchObject({
      persistence: "postgres",
      statusRevision: 3,
      workItemId: "task-a",
    });
  });

  it("projects assignment, artifacts, governed progress, and exact usage cost together", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    db.getSql
      .mockReturnValueOnce(async () => [{
        source_id: "task-a",
        workspace_id: "workspace:personal:123e4567-e89b-42d3-a456-426614174000",
        project_id: "project-a",
        work_item_id: "task-a",
        kind: "task",
        canonical_status: "running",
        source_status: "doing:running",
        status_revision: 4,
        updated_at: fallback.updatedAt,
        source_revision_sha256: "a".repeat(64),
        projection_sha256: "b".repeat(64),
        projection: {
          schemaVersion: 1,
          tenantId: "tenant-a",
          workspaceId: "workspace:personal:123e4567-e89b-42d3-a456-426614174000",
          projectId: "project-a",
          workItemId: "task-a",
          parentWorkItemId: null,
          kind: "task",
          title: "Task",
          detail: "",
          priority: "medium",
          canonicalStatus: "running",
          sourceStatus: "doing:running",
          statusRevision: 4,
          sourceAuthority: "legacy_project_task",
          dependencyWorkItemIds: [],
          ownerActorIds: ["actor:123e4567-e89b-42d3-a456-426614174000"],
          assignedAgents: [{
            agentId: "atlas",
            principalId: null,
            principalGeneration: null,
          }],
          schedule: { startsAt: null, dueAt: null, timeZone: null },
          recurrence: null,
          risks: [],
          decisions: [],
          artifacts: [{
            artifactId: "artifact-a",
            kind: "project_artifact",
            evidenceRefIds: ["evidence-a"],
          }],
          createdAt: fallback.updatedAt,
          updatedAt: fallback.updatedAt,
          terminalAt: null,
        },
      }])
      .mockReturnValueOnce(async () => [{
        id: "workflow-a",
        status: "running",
        current_step: "execute",
        input: { metadata: { projectTaskId: "task-a" } },
        updated_at: fallback.updatedAt,
        completed_steps: 3,
        total_steps: 6,
        usage_receipt_count: 2,
        unknown_cost_receipt_count: 1,
        known_estimated_cost_microusd: 125_000,
        total_tokens: 2_400,
      }]);

    const views = await canonicalWorkItemSurfaces(
      "tenant-a",
      "legacy_project_task",
      [{ ...fallback, status: "running", sourceStatus: "doing:running", workflowRunId: "workflow-a" }],
    );

    expect(views.get("task-a")).toMatchObject({
      version: "p11.4-work-item-surface:1",
      assignment: { agents: [{ agentId: "atlas" }] },
      artifacts: { count: 1, items: [{ artifactId: "artifact-a", evidenceCount: 1 }] },
      execution: { availability: "current", progressPercent: 50, currentStep: "execute" },
      cost: {
        state: "partial",
        usageReceiptCount: 2,
        unknownCostReceiptCount: 1,
        knownEstimatedCostMicrousd: 125_000,
        totalTokens: 2_400,
      },
    });
  });

  it("fails closed when a persisted canonical projection is missing", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    db.getSql.mockReturnValue(async () => []);
    await expect(canonicalWorkItemStatuses(
      "tenant-a",
      "legacy_project_task",
      [fallback],
    )).rejects.toThrow("projection is missing");
  });

  it("keeps an explicitly readable legacy URL available without inventing persistence", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    db.getSql.mockReturnValue(async () => []);
    const surfaces = await canonicalWorkItemSurfaces(
      "tenant-a",
      "legacy_mission",
      [{
        ...fallback,
        projectId: "mission_project:mission-a",
        workItemId: "mission_root:mission-a",
        sourceId: "mission-a",
        kind: "milestone",
        allowCompatibilityFallback: true,
      }],
    );
    expect(surfaces.get("mission-a")).toMatchObject({
      projection: { sha256: null, sourceRevisionSha256: null },
      status: { persistence: "local_projection", sourceAuthority: "legacy_mission" },
      execution: { availability: "not_started" },
      cost: { state: "not_recorded" },
    });
  });
});
