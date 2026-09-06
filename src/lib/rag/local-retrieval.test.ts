import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "asael-local-retrieval-"),
  );
  delete process.env.DATABASE_URL;
});

describe("P4.4 local multilingual retrieval", () => {
  it("retrieves authorized memory without mixing stored vector spaces", async () => {
    const [{ saveMemory, searchMemories }, embedding] = await Promise.all([
      import("@/lib/memory/store"),
      import("@/lib/rag/retrieval-embedding"),
    ]);
    const query = "procedimiento para restaurar la base de datos";
    const queryEmbedding = embedding.embedLocalMultilingualTexts([query])[0];
    const relevant = await saveMemory({
      tenantId: "tenant-local-memory",
      title: "Database restore procedure",
      content: "Restore the database backup before restarting the worker.",
      embedding: queryEmbedding.map((value) => -value),
    });
    await saveMemory({
      tenantId: "tenant-local-memory",
      title: "Customer invoice renewal",
      content: "The customer billing contract renews next quarter.",
      embedding: queryEmbedding,
    });

    const results = await searchMemories(query, {
      tenantId: "tenant-local-memory",
      limit: 2,
      queryEmbedding,
      queryEmbeddingSpaceId: embedding.LOCAL_MULTILINGUAL_EMBEDDING_SPACE,
    });

    expect(results[0]?.record.id).toBe(relevant.id);
    expect(results[0]?.reasons).toContain("semantic match");
  });

  it("retrieves knowledge without an external embedding credential", async () => {
    const [{ createKnowledgeDocument, searchKnowledge }, embedding] =
      await Promise.all([
        import("@/lib/rag/store"),
        import("@/lib/rag/retrieval-embedding"),
      ]);
    const query = "qui possede le projet";
    const queryEmbedding = embedding.embedLocalMultilingualTexts([query])[0];
    const relevant = await createKnowledgeDocument({
      tenantId: "tenant-local-knowledge",
      title: "Project ownership",
      content: "Mira owns the project.",
      chunks: [{
        index: 0,
        content: "Mira is the owner of Project Orion.",
        embedding: queryEmbedding.map((value) => -value),
      }],
    });
    await createKnowledgeDocument({
      tenantId: "tenant-local-knowledge",
      title: "Invoice renewal",
      content: "A billing note.",
      chunks: [{
        index: 0,
        content: "The customer invoice renewal is due next quarter.",
        embedding: queryEmbedding,
      }],
    });

    const results = await searchKnowledge(query, {
      tenantId: "tenant-local-knowledge",
      limit: 2,
      queryEmbedding,
      queryEmbeddingSpaceId: embedding.LOCAL_MULTILINGUAL_EMBEDDING_SPACE,
    });

    expect(results[0]?.chunk.id).toBe(relevant.chunks[0].id);
    expect(results[0]?.reasons).toContain("semantic match");
  });
});
