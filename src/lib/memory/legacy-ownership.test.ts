import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const statements: string[] = [];
  const rows = [
    {
      id: "memory-a",
      claim_status: "active",
      updated_at: "2026-09-08T00:00:00.000Z",
    },
    {
      id: "memory-b",
      claim_status: "superseded",
      updated_at: "2026-09-07T00:00:00.000Z",
    },
  ];
  const sql = vi.fn(async (strings: TemplateStringsArray) => {
    const statement = strings.join("?");
    statements.push(statement);
    if (statement.includes("FROM omni_memories memory") && statement.includes("SELECT id, claim_status")) {
      return rows;
    }
    if (statement.includes("AS lifecycle_count")) {
      return [{ lifecycle_count: 0, promotion_count: 0, partial_review_count: 0 }];
    }
    if (statement.includes("UPDATE omni_memories")) return rows.map(({ id }) => ({ id }));
    if (statement.includes("UPDATE omni_memory_reconciliation_reviews")) return [{ id: "review-a" }];
    if (statement.includes("UPDATE omni_retrieval_traces")) return [{ id: "trace-a" }];
    if (statement.includes("SELECT id") && statement.includes("omni_memory_graph_nodes")) {
      return [{ id: "node-a" }];
    }
    if (statement.includes("DELETE FROM omni_memory_graph_edges")) return [{ id: "edge-a" }];
    if (statement.includes("DELETE FROM omni_memory_graph_nodes")) return [{ id: "node-a" }];
    return [];
  });
  Object.assign(sql, {
    transaction: vi.fn(async (operation: (transaction: typeof sql) => unknown) =>
      operation(sql)),
  });
  return { appendScopedDomainEvent: vi.fn(), rows, sql, statements };
});

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getSql: vi.fn(() => mocks.sql),
  hasDatabaseUrl: vi.fn(() => true),
  runWithDatabaseSystemScope: vi.fn(
    async (_reason: string, operation: () => Promise<unknown>) => operation(),
  ),
  runWithDatabaseTenantScope: vi.fn(
    async (_tenantId: string, operation: () => Promise<unknown>) => operation(),
  ),
}));
vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import {
  migrateLegacyDurableMemoryOwnership,
  previewLegacyDurableMemoryOwnership,
} from "@/lib/memory/legacy-ownership";
import { createExecutionScope } from "@/lib/security/execution-scope";

const tenantId = "tenant-a";
const ownerActorId = "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";

describe("legacy durable memory owner enrollment", () => {
  beforeEach(() => {
    mocks.sql.mockClear();
    mocks.statements.length = 0;
    mocks.appendScopedDomainEvent.mockReset();
  });

  it("binds the exact previewed cohort and repairs derived owner boundaries", async () => {
    const preview = await previewLegacyDurableMemoryOwnership({ tenantId });
    expect(preview).toMatchObject({
      count: 2,
      activeCount: 1,
      historicalCount: 1,
    });

    const result = await migrateLegacyDurableMemoryOwnership({
      tenantId,
      ownerActorId,
      expectedManifestSha256: preview.manifestSha256,
      migratedAt: "2026-09-09T00:00:00.000Z",
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: ownerActorId,
        executingPrincipalType: "user",
        executingPrincipalId: ownerActorId,
        workspaceId: null,
        projectId: null,
        missionId: null,
        correlationId: "owner-enrollment-test",
        purpose: "test.memory.owner-enrollment",
      }),
    });

    expect(result).toMatchObject({
      migratedCount: 2,
      reviewCount: 1,
      traceCount: 1,
      removedGraphNodeCount: 1,
      removedGraphEdgeCount: 1,
    });
    expect(mocks.statements.some((statement) =>
      statement.includes("omni.memory_owner_enrollment_v1")
    )).toBe(true);
    expect(mocks.statements.some((statement) =>
      statement.includes("UPDATE omni_memory_reconciliation_reviews")
    )).toBe(true);
    expect(mocks.statements.some((statement) =>
      statement.includes("UPDATE omni_retrieval_traces")
    )).toBe(true);
    expect(mocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "memory.legacy_owner_enrollment.completed",
        payload: expect.objectContaining({ migratedCount: 2 }),
      }),
      expect.anything(),
    );
  });
});
