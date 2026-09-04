import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";

const dbMocks = vi.hoisted(() => {
  const rows: Record<string, unknown>[] = [];
  const statements: Array<{ text: string; params: unknown[] }> = [];
  const sql = vi.fn(
    (strings: TemplateStringsArray, ...params: unknown[]) => {
      statements.push({ text: renderStatement(strings, params), params });
      return Promise.resolve([...rows]);
    },
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getDatabaseTenantContext: vi.fn(() => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => true),
    rows,
    sql,
    statements,
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/db/client")>();
  return {
    ...actual,
    ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
    getDatabaseTenantContext: dbMocks.getDatabaseTenantContext,
    getSql: dbMocks.getSql,
    hasDatabaseUrl: dbMocks.hasDatabaseUrl,
  };
});

import {
  getOwnedProject,
  getProject,
  listProjects,
  listProjectSummaries,
} from "@/lib/projects/store";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "project-owner@example.test";
const canonicalActorId = `actor:${authUserId}`;
const binding: CanonicalRequestActorBindingV1 = {
  version: 1,
  kind: "auth_user",
  authUserId,
  canonicalActorId,
  legacyOwnerActorIds: Object.freeze([actorId]),
  readableOwnerActorIds: Object.freeze([canonicalActorId, actorId]),
};

beforeEach(() => {
  dbMocks.rows.splice(0);
  dbMocks.statements.splice(0);
  dbMocks.ensureDatabaseSchema.mockClear();
  dbMocks.getDatabaseTenantContext.mockClear();
  dbMocks.getSql.mockClear();
  dbMocks.hasDatabaseUrl.mockClear();
  dbMocks.sql.mockClear();
});

describe("Postgres project owner reads", () => {
  it("merges owner partitions before globally ordering and limiting lists", async () => {
    dbMocks.rows.push(
      projectRow("canonical-project", canonicalActorId),
      projectRow("email-project", actorId),
    );

    await expect(listProjects(2, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual([
      expect.objectContaining({ id: "canonical-project", actorId }),
      expect.objectContaining({ id: "email-project", actorId }),
    ]);

    const listStatement = dbMocks.statements[0];
    expect(listStatement.text).toMatch(
      /WHERE tenant_id = \$\d+[\s\S]*AND \(actor_id = \$\d+ OR actor_id = \$\d+\)[\s\S]*CASE status[\s\S]*updated_at DESC,[\s\S]*id ASC[\s\S]*LIMIT \$\d+/,
    );
    expect(listStatement.params).toContain(canonicalActorId);
    expect(listStatement.params).toContain(actorId);
    expect(listStatement.params).toContain(2);

    dbMocks.statements.splice(0);
    await expect(listProjectSummaries(2, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual([
      expect.objectContaining({
        id: "canonical-project",
        actorId,
        taskCount: 2,
        artifactCount: 1,
      }),
      expect.objectContaining({
        id: "email-project",
        actorId,
        taskCount: 2,
        artifactCount: 1,
      }),
    ]);

    const summaryStatement = dbMocks.statements[0];
    expect(summaryStatement.text).toMatch(
      /WHERE projects\.tenant_id = \$\d+[\s\S]*AND \(projects\.actor_id = \$\d+ OR projects\.actor_id = \$\d+\)[\s\S]*CASE projects\.status[\s\S]*projects\.updated_at DESC,[\s\S]*projects\.id ASC[\s\S]*LIMIT \$\d+/,
    );
  });

  it("keeps mutation-facing getProject separate from owner-scoped lookup", async () => {
    dbMocks.rows.push(projectRow("canonical-project", canonicalActorId));

    await expect(getProject("canonical-project", {
      tenantId: "tenant-a",
      actorId,
    })).resolves.toEqual(expect.objectContaining({
      id: "canonical-project",
      actorId: canonicalActorId,
    }));
    expect(dbMocks.statements[0].params).not.toContain(canonicalActorId);
    expect(dbMocks.statements[0].text).not.toContain(" OR actor_id = ");

    dbMocks.statements.splice(0);
    await expect(getOwnedProject("canonical-project", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      id: "canonical-project",
      actorId,
    }));
    expect(dbMocks.statements[0].text).toMatch(
      /WHERE id = \$\d+ AND tenant_id = \$\d+[\s\S]*AND \(actor_id = \$\d+ OR actor_id = \$\d+\)/,
    );
  });

  it("uses an exact actor query when no request binding is supplied", async () => {
    await expect(getOwnedProject("missing-project", {
      tenantId: "tenant-a",
      actorId,
    })).resolves.toBeUndefined();

    expect(dbMocks.statements[0].params).toEqual([
      "missing-project",
      "tenant-a",
      actorId,
      actorId,
    ]);
  });
});

function projectRow(id: string, ownerActorId: string) {
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    title: id,
    objective: `Complete ${id}`,
    status: "active",
    autonomy_mode: "manual",
    execution_status: "idle",
    task_budget: 12,
    tasks_dispatched: 0,
    max_parallel_tasks: 1,
    require_approval: true,
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: "2026-09-04T12:00:00.000Z",
    task_count: 2,
    completed_task_count: 1,
    active_task_count: 0,
    artifact_count: 1,
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
