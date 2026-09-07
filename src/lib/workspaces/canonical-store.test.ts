import { describe, expect, it, vi } from "vitest";
import type { Mission } from "@/lib/missions/types";
import type { PersonalProject, ProjectTask } from "@/lib/projects/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  missionCanonicalShadowWrite,
  projectCanonicalShadowWrite,
} from "@/lib/workspaces/canonical-store";

const now = "2026-09-07T12:00:00.000Z";
const actorId = "owner@example.com";
const canonicalActorId = "actor:123e4567-e89b-42d3-a456-426614174000";
const workspaceId = "workspace:personal:123e4567-e89b-42d3-a456-426614174000";
const project: PersonalProject = {
  id: "project-a", tenantId: "tenant-a", actorId,
  title: "Project", objective: "Objective", status: "active",
  autonomyMode: "manual", executionStatus: "idle", taskBudget: 12,
  tasksDispatched: 0, maxParallelTasks: 1, requireApproval: true,
  createdAt: now, updatedAt: now,
};
const task: ProjectTask = {
  id: "task-a", tenantId: "tenant-a", projectId: "project-a",
  title: "Task", detail: "", status: "open", priority: "medium",
  agentId: "atlas", position: 0, origin: "manual", dependsOn: [],
  dispatchAttempt: 0, createdAt: now, updatedAt: now,
};
const mission: Mission = {
  id: "mission-a", tenantId: "tenant-a", actorId,
  title: "Mission", objective: "Objective", status: "queued",
  priority: "normal", source: "user", sourceKey: "mission-a", metadata: {},
  createdAt: now, updatedAt: now,
};

describe("canonical work transactional shadow writer", () => {
  it("writes Project, WorkItem, mapping, history, and typed events", async () => {
    const statements: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push(statement);
      if (statement.includes("omni_ensure_personal_workspace_v1")) {
        return [{ workspace_id: workspaceId, owner_actor_id: canonicalActorId }];
      }
      if (statement.includes("INSERT INTO omni_events")) return [{ seq: 1 }];
      return [];
    });
    await projectCanonicalShadowWrite({
      sql,
      project,
      task,
      attribution: { changedFieldIds: ["status", "title"] },
    });
    expect(statements.some((statement) => statement.includes("INSERT INTO omni_work_projects"))).toBe(true);
    const projectInsert = statements.find((statement) =>
      statement.includes("INSERT INTO omni_work_projects")
    );
    expect(projectInsert).not.toContain("ON CONFLICT");
    expect(statements.some((statement) =>
      statement.includes("pg_advisory_xact_lock")
    )).toBe(true);
    expect(statements.some((statement) => statement.includes("INSERT INTO omni_work_items"))).toBe(true);
    expect(statements.some((statement) => statement.includes("INSERT INTO omni_work_compatibility_mappings"))).toBe(true);
    expect(statements.some((statement) => statement.includes("INSERT INTO omni_work_item_status_history"))).toBe(true);
    expect(statements.filter((statement) => statement.includes("INSERT INTO omni_events"))).toHaveLength(2);
  });

  it("makes Mission a canonical Project with one root milestone", async () => {
    const statements: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray) => {
      const statement = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push(statement);
      if (statement.includes("omni_ensure_personal_workspace_v1")) {
        return [{ workspace_id: workspaceId, owner_actor_id: canonicalActorId }];
      }
      if (statement.includes("INSERT INTO omni_events")) return [{ seq: 1 }];
      return [];
    });
    await missionCanonicalShadowWrite({
      sql,
      mission,
      attribution: { changedFieldIds: ["status"] },
    });
    expect(statements.filter((statement) => statement.includes("INSERT INTO omni_work_projects"))).toHaveLength(1);
    expect(statements.filter((statement) => statement.includes("INSERT INTO omni_work_items"))).toHaveLength(1);
    expect(statements.filter((statement) => statement.includes("INSERT INTO omni_events"))).toHaveLength(2);
  });

  it("does not append a new revision when the exact source digest already exists", async () => {
    let projectDigest = "";
    const statements: string[] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const statement = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push(statement);
      if (statement.includes("omni_ensure_personal_workspace_v1")) {
        return [{ workspace_id: workspaceId, owner_actor_id: canonicalActorId }];
      }
      if (statement.includes("INSERT INTO omni_work_projects")) {
        projectDigest = String(params[13]);
      }
      if (statement.includes("FROM omni_work_projects") && statement.includes("FOR UPDATE") && projectDigest) {
        return [{ lifecycle_revision: 1, source_revision_sha256: projectDigest }];
      }
      if (statement.includes("INSERT INTO omni_events")) return [{ seq: 1 }];
      return [];
    });
    await projectCanonicalShadowWrite({
      sql,
      project,
      attribution: { changedFieldIds: ["title"] },
    });
    const firstEventCount = statements.filter((statement) => statement.includes("INSERT INTO omni_events")).length;
    await projectCanonicalShadowWrite({
      sql,
      project,
      attribution: { changedFieldIds: ["title"] },
    });
    expect(statements.filter((statement) => statement.includes("INSERT INTO omni_events"))).toHaveLength(firstEventCount);
  });

  it("binds a newly instantiated Project to an explicit contributor workspace", async () => {
    const sharedWorkspaceId = "workspace:team-release";
    const statements: string[] = [];
    const parameters: unknown[][] = [];
    const sql = vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
      const statement = strings.join("?").replace(/\s+/g, " ").trim();
      statements.push(statement);
      parameters.push(params);
      if (statement.includes("omni_ensure_personal_workspace_v1")) {
        return [{ workspace_id: workspaceId, owner_actor_id: canonicalActorId }];
      }
      if (statement.includes("FROM omni_tenant_workspaces workspace")) {
        return [{ workspace_id: sharedWorkspaceId }];
      }
      if (statement.includes("INSERT INTO omni_events")) return [{ seq: 1 }];
      return [];
    });
    await projectCanonicalShadowWrite({
      sql,
      project,
      attribution: {
        changedFieldIds: ["title"],
        executionScope: createExecutionScope({
          tenantId: project.tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          workspaceId: sharedWorkspaceId,
          correlationId: "instantiate-template",
          purpose: "workspace.template.instantiate.project",
        }),
      },
    });
    const insertIndex = statements.findIndex((statement) =>
      statement.includes("INSERT INTO omni_work_projects")
    );
    expect(insertIndex).toBeGreaterThan(-1);
    expect(parameters[insertIndex]).toContain(sharedWorkspaceId);
    expect(statements.some((statement) =>
      statement.includes("membership.access_level IN ('contributor', 'manager')")
    )).toBe(true);
  });
});
