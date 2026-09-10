import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";

const dbMocks = vi.hoisted(() => {
  const statements: string[] = [];
  const sql = vi.fn((strings: TemplateStringsArray) => {
    const text = strings.join("?");
    statements.push(text);
    if (text.includes("FROM omni_capture_assets")) {
      return Promise.resolve([{ id: "capture-asset-1" }]);
    }
    if (text.includes("omni_retire_knowledge_cognition_memories_v1")) {
      return Promise.resolve([{
        retired_memory_ids: ["memory-cognition-1"],
        retrieval_trace_ids: ["trace-cognition-1"],
        canonical_owner_actor_id: "actor:canonical-owner",
      }]);
    }
    if (text.includes("SELECT document.source_item_id")) {
      return Promise.resolve([{
        source_item_id: "source-item-1",
        current_revision_id: "revision-current",
      }]);
    }
    if (
      text.includes("FROM omni_knowledge_documents") &&
      text.includes("source_item_id") &&
      text.includes("id <>")
    ) {
      return Promise.resolve([{ id: "document-old" }]);
    }
    if (text.includes("SELECT id FROM omni_knowledge_documents")) {
      return Promise.resolve([{ id: "document-1" }]);
    }
    if (text.includes("JOIN omni_evidence_units")) {
      return Promise.resolve([]);
    }
    if (
      (text.includes("SELECT id") || text.includes("SELECT memory.id")) &&
      text.includes("FROM omni_memories")
    ) {
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

const lifecycleMocks = vi.hoisted(() => ({
  retireEvidence: vi.fn(async () => undefined),
  retireMemory: vi.fn(async () => undefined),
  queueRelations: vi.fn(async () => undefined),
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

vi.mock("@/lib/entities/store", () => ({
  retireEntityEvidenceLineage: lifecycleMocks.retireEvidence,
  retireEntityMemoryLineage: lifecycleMocks.retireMemory,
}));

vi.mock("@/lib/entities/relation-projection-queue", () => ({
  queueTemporalRelationProjection: lifecycleMocks.queueRelations,
}));

import {
  deleteKnowledgeDocumentByIdempotencyKey,
  deleteKnowledgeDocumentsBySourcePrefix,
  retireSupersededCaptureKnowledge,
} from "@/lib/rag/store";

describe("Postgres knowledge deletion event boundary", () => {
  beforeEach(() => {
    dbMocks.ensureDatabaseSchema.mockClear();
    dbMocks.getSql.mockClear();
    dbMocks.sql.mockClear();
    dbMocks.sql.transaction.mockClear();
    dbMocks.statements.splice(0);
    eventMocks.appendScopedDomainEvent.mockClear();
    lifecycleMocks.retireEvidence.mockClear();
    lifecycleMocks.retireMemory.mockClear();
    lifecycleMocks.queueRelations.mockClear();
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
    })).resolves.toEqual({ documents: 1, memories: 2 });

    expect(dbMocks.sql.transaction).toHaveBeenCalledTimes(1);
    expect(dbMocks.statements).toContainEqual(
      expect.stringContaining("omni_retire_knowledge_cognition_memories_v1"),
    );
    expect(dbMocks.statements).toEqual(expect.arrayContaining([
      expect.stringContaining("DELETE FROM omni_knowledge_documents"),
      expect.stringContaining("UPDATE omni_memories"),
      expect.stringMatching(
        /SELECT evidence_id AS id, owner_actor_id[\s\S]*SELECT DISTINCT evidence\.id AS evidence_id[\s\S]*ORDER BY owner_actor_id COLLATE "C", evidence_id COLLATE "C"/,
      ),
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
    expect(lifecycleMocks.retireMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: actorId,
        memoryIds: ["memory-1"],
        executionScope: expect.objectContaining({
          initiatingActorId: actorId,
          purpose: "memory.forget.v1",
        }),
        sql: dbMocks.sql,
      }),
    );
    expect(lifecycleMocks.retireMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: "actor:canonical-owner",
        memoryIds: ["memory-cognition-1"],
        executionScope: expect.objectContaining({
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          purpose: "memory.forget.v1",
        }),
        sql: dbMocks.sql,
      }),
    );
    expect(lifecycleMocks.queueRelations).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: actorId,
        sql: dbMocks.sql,
      }),
    );
  });

  it("uses the bounded lifecycle seam for governed Capture supersession", async () => {
    const tenantId = "tenant-capture";
    const actorId = "capture-owner";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      correlationId: "capture-job-current",
      purpose: "capture.ingest.source.index",
    });

    await expect(retireSupersededCaptureKnowledge({
      captureIngestGuard: {
        kind: "asset",
        captureId: "capture-asset-1",
        tenantId,
        actorId,
        ingestJobId: "capture-job-current",
      },
      executionScope,
      keepDocumentId: "document-current",
    })).resolves.toEqual({ documents: 1, memories: 2 });

    expect(dbMocks.statements).toContainEqual(
      expect.stringContaining("omni_retire_knowledge_cognition_memories_v1"),
    );
    expect(lifecycleMocks.retireMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: actorId,
        memoryIds: ["memory-1"],
        executionScope: expect.objectContaining({
          executingPrincipalType: "system",
          purpose: "memory.forget.v1",
        }),
        sql: dbMocks.sql,
      }),
    );
    expect(lifecycleMocks.retireMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: "actor:canonical-owner",
        memoryIds: ["memory-cognition-1"],
        executionScope: expect.objectContaining({
          initiatingActorId: actorId,
          executingPrincipalType: "system",
          purpose: "memory.forget.v1",
        }),
        sql: dbMocks.sql,
      }),
    );
    expect(lifecycleMocks.queueRelations).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: actorId,
        executionScope,
        sql: dbMocks.sql,
      }),
    );
  });

  it("requires owner scope to retire a provider item's private cognition", async () => {
    const tenantId = "tenant-sync";
    const actorId = "sync-owner";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "connector.google.personal_sync",
      correlationId: "personal-sync-delete",
      purpose: "connector.google.personal_sync.ingest",
    });

    await expect(deleteKnowledgeDocumentByIdempotencyKey(
      "oauth:google:drive:file-1",
      { tenantId },
    )).rejects.toThrow("actor-bound execution scope");
    await expect(deleteKnowledgeDocumentByIdempotencyKey(
      "oauth:google:drive:file-1",
      { tenantId, executionScope },
    )).resolves.toEqual(expect.any(String));

    expect(dbMocks.statements).toContainEqual(
      expect.stringContaining("omni_retire_knowledge_cognition_memories_v1"),
    );
    expect(lifecycleMocks.retireMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: actorId,
        memoryIds: ["memory-1"],
        executionScope: expect.objectContaining({
          executingPrincipalId: "connector.google.personal_sync",
          purpose: "memory.forget.v1",
        }),
        sql: dbMocks.sql,
      }),
    );
    expect(lifecycleMocks.retireMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId,
        ownerActorId: "actor:canonical-owner",
        memoryIds: ["memory-cognition-1"],
        executionScope: expect.objectContaining({
          executingPrincipalId: "connector.google.personal_sync",
          purpose: "memory.forget.v1",
        }),
        sql: dbMocks.sql,
      }),
    );
  });
});
