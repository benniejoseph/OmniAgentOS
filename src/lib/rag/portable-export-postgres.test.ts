import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureSchema: vi.fn(),
  queries: [] as Array<{ text: string; values: unknown[] }>,
  sql: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureSchema,
  getDatabaseTenantContext: () => undefined,
  getSql: () => mocks.sql,
  hasDatabaseUrl: () => true,
}));

import { listActorOwnedKnowledgeForPortableArchive } from "@/lib/rag/store";

const timestamp = "2026-09-06T10:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries.length = 0;
  mocks.sql.mockImplementation((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    mocks.queries.push({ text, values });
    if (text.includes("portable_total_count")) {
      return Promise.resolve([
        documentRow("document-a", 1, 3),
        documentRow("document-partial", 2, 3),
      ]);
    }
    if (text.includes("FROM omni_knowledge_chunks AS chunk")) {
      return Promise.resolve([
        chunkRow("chunk-a", "document-a", 0),
        chunkRow("chunk-partial", "document-partial", 0),
      ]);
    }
    throw new Error(`Unexpected SQL query: ${text}`);
  });
});

describe("actor-owned portable knowledge export", () => {
  it("requires current owner lineage and excludes incomplete evidence sets", async () => {
    const result = await listActorOwnedKnowledgeForPortableArchive({
      tenantId: "tenant-a",
      actorId: "actor-a",
      documentLimit: 5_000,
      chunkLimit: 50_000,
    });

    expect(result.documents.map((document) => document.id)).toEqual(["document-a"]);
    expect(result.chunks.map((chunk) => chunk.id)).toEqual(["chunk-a"]);
    expect(result.totalDocumentCount).toBe(3);
    expect(result.excludedDocumentCount).toBe(2);

    const documentQuery = mocks.queries[0]!;
    expect(documentQuery.text).toContain("source_item.owner_actor_id");
    expect(documentQuery.text).toContain("source_item.current_revision_id = document.source_revision_id");
    expect(documentQuery.values).toContain("tenant-a");
    expect(documentQuery.values).toContain("actor-a");

    const chunkQuery = mocks.queries[1]!;
    expect(chunkQuery.text).toContain("evidence.owner_actor_id");
    expect(chunkQuery.values).toContain("actor-a");
  });
});

function documentRow(id: string, chunkCount: number, totalCount: number) {
  return {
    id,
    tenant_id: "tenant-a",
    title: id,
    source: "manual",
    source_type: "manual",
    tags: [],
    content_hash: "a".repeat(64),
    chunk_count: chunkCount,
    total_characters: 10,
    metadata: {},
    source_item_id: `source-${id}`,
    source_revision_id: `revision-${id}`,
    created_at: timestamp,
    updated_at: timestamp,
    portable_total_count: totalCount,
  };
}

function chunkRow(id: string, documentId: string, chunkIndex: number) {
  return {
    id,
    tenant_id: "tenant-a",
    document_id: documentId,
    source_revision_id: `revision-${documentId}`,
    evidence_unit_id: `evidence-${id}`,
    chunk_index: chunkIndex,
    title: id,
    content: "content",
    tags: [],
    source: "manual",
    token_estimate: 1,
    character_count: 7,
    embedding: null,
    metadata: {},
    created_at: timestamp,
    updated_at: timestamp,
  };
}
