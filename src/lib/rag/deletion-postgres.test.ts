import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";

const dbMocks = vi.hoisted(() => {
  const statements: string[] = [];
  const sql = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    statements.push(text);
    if (text.includes("SELECT id FROM omni_knowledge_documents")) {
      return Promise.resolve([{ id: "document-1" }]);
    }
    if (text.includes("SELECT id") && text.includes("FROM omni_memories")) {
      return Promise.resolve([{ id: "memory-1" }]);
    }
    if (text.includes("information_schema.columns")) {
      return Promise.resolve([{ exists: 1 }]);
    }
    if (text.includes("UPDATE omni_memories")) {
      return Promise.resolve([{ id: "memory-1" }]);
    }
    return Promise.resolve([]);
  }) as ReturnType<typeof vi.fn> & {
    transaction: ReturnType<typeof vi.fn>;
  };
  sql.transaction = vi.fn(
    (callback: (transactionSql: typeof sql) => Promise<unknown>) => callback(sql),
  );
  return {
    ensureDatabaseSchema: vi.fn(async () => undefined),
    getSql: vi.fn(() => sql),
    hasDatabaseUrl: vi.fn(() => true),
    sql,
    statements,
  };
});

const eventMocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async () => undefined),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  ensureDatabaseSchema: dbMocks.ensureDatabaseSchema,
  getSql: dbMocks.getSql,
  hasDatabaseUrl: dbMocks.hasDatabaseUrl,
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: eventMocks.appendScopedDomainEvent,
}));

import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";

describe("Postgres knowledge deletion event boundary", () => {
  beforeEach(() => {
    dbMocks.ensureDatabaseSchema.mockClear();
    dbMocks.getSql.mockClear();
    dbMocks.sql.mockClear();
    dbMocks.sql.transaction.mockClear();
    dbMocks.statements.splice(0);
    eventMocks.appendScopedDomainEvent.mockClear();
  });

  it("commits the source scrub and scoped event through one transaction client", async () => {
    const tenantId = "tenant-a";
    const actorId = "owner";
    const source = "google:drive:";
    await expect(deleteKnowledgeDocumentsBySourcePrefix(source, {
      tenantId,
      actorId,
      mutation: {
        idempotencyKey: "knowledge-delete-1",
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          correlationId: "knowledge-delete-request-1",
          causationId: knowledgeDeletionTargetId(source),
          purpose: "knowledge.delete_source",
        }),
      },
    })).resolves.toEqual({ documents: 1, memories: 1 });

    expect(dbMocks.sql.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.statements).toEqual(expect.arrayContaining([
      expect.stringContaining("DELETE FROM omni_knowledge_documents"),
      expect.stringContaining("UPDATE omni_memories"),
    ]));
    expect(eventMocks.appendScopedDomainEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "knowledge.source_deleted",
        executionScope: expect.objectContaining({
          tenantId,
          initiatingActorId: actorId,
        }),
      }),
      { sql: dbMocks.sql },
    );
  });
});
