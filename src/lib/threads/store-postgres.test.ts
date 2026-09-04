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

import { getOwnedThread, getThread, listThreads } from "@/lib/threads/store";

const authUserId = "11111111-1111-4111-8111-111111111111";
const actorId = "thread-owner@example.test";
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

describe("Postgres thread owner reads", () => {
  it("unions canonical and current-email partitions before ordering and limiting", async () => {
    dbMocks.rows.push(
      threadRow("canonical-thread", canonicalActorId, "2026-09-04T12:00:00.000Z"),
      threadRow("email-thread", actorId, "2026-09-04T12:00:00.000Z"),
    );

    await expect(listThreads(2, {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual([
      expect.objectContaining({ id: "canonical-thread", actorId }),
      expect.objectContaining({ id: "email-thread", actorId }),
    ]);

    const statement = dbMocks.statements[0];
    expect(statement.text).toMatch(
      /WHERE tenant_id = \$\d+[\s\S]*AND \(actor_id = \$\d+ OR actor_id = \$\d+\)[\s\S]*ORDER BY updated_at DESC, id ASC[\s\S]*LIMIT \$\d+/,
    );
    expect(statement.params).toContain("tenant-a");
    expect(statement.params).toContain(canonicalActorId);
    expect(statement.params).toContain(actorId);
    expect(statement.params).toContain(2);
  });

  it("keeps the tenant-only resolver separate from owner-scoped lookup", async () => {
    dbMocks.rows.push(
      threadRow("canonical-thread", canonicalActorId, "2026-09-04T12:00:00.000Z"),
    );

    await expect(getThread("canonical-thread", {
      tenantId: "tenant-a",
    })).resolves.toEqual(expect.objectContaining({
      id: "canonical-thread",
      actorId: canonicalActorId,
    }));
    expect(dbMocks.statements[0].text).not.toContain("actor_id =");

    dbMocks.statements.splice(0);
    await expect(getOwnedThread("canonical-thread", {
      tenantId: "tenant-a",
      actorId,
      requestActorBinding: binding,
    })).resolves.toEqual(expect.objectContaining({
      id: "canonical-thread",
      actorId,
    }));
    expect(dbMocks.statements[0].text).toMatch(
      /WHERE id = \$\d+ AND tenant_id = \$\d+[\s\S]*AND \(actor_id = \$\d+ OR actor_id = \$\d+\)/,
    );
  });

  it("uses an exact actor query when no request binding is supplied", async () => {
    await expect(getOwnedThread("missing-thread", {
      tenantId: "tenant-a",
      actorId,
    })).resolves.toBeNull();

    expect(dbMocks.statements[0].params).toEqual([
      "missing-thread",
      "tenant-a",
      actorId,
      actorId,
    ]);
  });
});

function threadRow(id: string, ownerActorId: string, updatedAt: string) {
  return {
    id,
    tenant_id: "tenant-a",
    actor_id: ownerActorId,
    title: id,
    mode: "orchestrate",
    created_at: "2026-09-04T10:00:00.000Z",
    updated_at: updatedAt,
  };
}

function renderStatement(strings: TemplateStringsArray, params: unknown[]) {
  return strings.reduce(
    (statement, part, index) =>
      statement + part + (index < params.length ? `$${index + 1}` : ""),
    "",
  );
}
