import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  queries: [] as string[],
  events: [] as string[],
  returnedMemoryRows: [] as Array<Record<string, unknown>>,
}));

function createSql(transactionScoped = false) {
  const sql = Object.assign(async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => {
    const query = strings.join("?");
    mocks.queries.push(query);
    mocks.events.push("query");
    if (query.includes("INSERT INTO omni_memories")) {
      return ((params[0] || []) as Array<Record<string, unknown>>).map(
        (row) => ({ ...row, _inserted: true }),
      );
    }
    if (
      query.includes("SELECT *") &&
      query.includes("FROM omni_memories")
    ) {
      return mocks.returnedMemoryRows;
    }
    return [];
  }, {
    transactionScoped,
    transaction: async <T>(operation: (
      transaction: ReturnType<typeof createSql>,
    ) => Promise<T>) => operation(createSql(true)),
  });
  return sql;
}

const sql = createSql();

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined),
  getDatabaseTenantContext: vi.fn(() => undefined),
  hasDatabaseUrl: vi.fn(() => true),
  getSql: vi.fn(() => sql),
}));

vi.mock("@/lib/db/memory-access-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/memory-access-scope")>()),
  setTransactionLocalDatabaseMemoryAccessScope: vi.fn(async () => {
    mocks.events.push("scope");
  }),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: vi.fn(async () => {
    mocks.events.push("event");
  }),
}));

import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import {
  listMemories,
  previewMemoryDeletion,
  saveMemory,
  searchMemories,
} from "@/lib/memory/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const ownerActorId = "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";

function accessScope(purposeId: string) {
  return {
    version: 1 as const,
    tenantId: "tenant-a",
    initiatingActorId: ownerActorId,
    executingPrincipalType: "user" as const,
    executingPrincipalId: ownerActorId,
    workspaceId: null,
    projectId: null,
    missionId: null,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purposeId,
    purpose: `test.${purposeId}`,
  };
}

function executionScope(purposeId: string) {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: ownerActorId,
    executingPrincipalType: "user",
    executingPrincipalId: ownerActorId,
    correlationId: "memory_test",
    purpose: `test.${purposeId}`,
  });
}

describe("Postgres memory recall", () => {
  beforeEach(() => {
    mocks.queries.length = 0;
    mocks.events.length = 0;
    mocks.returnedMemoryRows.length = 0;
  });

  it("ranks the projected lexical score from an outer query", async () => {
    await expect(
      searchMemories("release verification", { tenantId: "tenant-a" }),
    ).resolves.toEqual([]);

    const lexicalQuery = mocks.queries.find((query) =>
      query.includes("AS lexical_score"),
    );
    expect(lexicalQuery).toContain("FROM (\n      SELECT *");
    expect(lexicalQuery).toContain(") ranked");
    expect(lexicalQuery).toContain(
      "ORDER BY (ranked.lexical_score * (0.35 + ranked.confidence * 0.65))",
    );
    expect(lexicalQuery).not.toContain("ORDER BY (lexical_score *");
  });

  it("installs scope before persisting and reconstructs the immutable binding", async () => {
    const binding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      originPurpose: "api.memory.write",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    });
    const record = await saveMemory({
      id: "private-memory-a",
      tenantId: "tenant-a",
      title: "Private preference",
      content: "Keep this isolated.",
      accessBinding: binding,
      databaseAccessScope: accessScope(MEMORY_PURPOSE_IDS.write),
      executionScope: executionScope(MEMORY_PURPOSE_IDS.write),
    });

    expect(mocks.events.slice(0, 2)).toEqual(["scope", "query"]);
    expect(mocks.queries[0]).toContain("access_contract_version");
    expect(record.accessBinding).toEqual(binding);
  });

  it("owns a scoped read transaction and rejects read purpose for writes", async () => {
    await expect(listMemories({
      tenantId: "tenant-a",
      accessScope: accessScope(MEMORY_PURPOSE_IDS.read),
    })).resolves.toEqual([]);
    expect(mocks.events.slice(0, 2)).toEqual(["scope", "query"]);

    const binding = buildUserPrivateMemoryAccessBindingV1({
      tenantId: "tenant-a",
      ownerActorId,
      originPurpose: "api.memory.write",
    });
    await expect(saveMemory({
      tenantId: "tenant-a",
      title: "Wrong purpose",
      content: "This must fail before SQL.",
      accessBinding: binding,
      databaseAccessScope: accessScope(MEMORY_PURPOSE_IDS.read),
      executionScope: executionScope(MEMORY_PURPOSE_IDS.read),
    })).rejects.toThrow("not authorized for this operation");
  });

  it("uses indexed trace lineage for governed deletion previews", async () => {
    mocks.returnedMemoryRows.push({
      id: "private-memory-a",
      tenant_id: "tenant-a",
      type: "preference",
      title: "Private preference",
      content: "Keep this isolated.",
      tags: [],
      evidence_refs: [],
      claim_status: "active",
      asserted_by: "user",
      created_at: "2026-09-06T00:00:00.000Z",
      updated_at: "2026-09-06T00:00:00.000Z",
    });

    await expect(previewMemoryDeletion("private-memory-a", {
      tenantId: "tenant-a",
      accessScope: accessScope(MEMORY_PURPOSE_IDS.forget),
    })).resolves.toMatchObject({
      memory: { id: "private-memory-a" },
    });

    const traceQuery = mocks.queries.find((query) =>
      query.includes("FROM omni_retrieval_traces trace"),
    );
    expect(traceQuery).toContain("trace.memory_ids &&");
    expect(traceQuery).not.toContain("jsonb_array_elements");
  });
});
