import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: vi.fn(),
  hasDatabaseUrl: vi.fn(),
}));

vi.mock("@/lib/db/client", () => db);

import { canonicalWorkItemStatuses } from "@/lib/workspaces/read-model";

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

  it("fails closed when a persisted canonical projection is missing", async () => {
    db.hasDatabaseUrl.mockReturnValue(true);
    db.getSql.mockReturnValue(async () => []);
    await expect(canonicalWorkItemStatuses(
      "tenant-a",
      "legacy_project_task",
      [fallback],
    )).rejects.toThrow("projection is missing");
  });
});
