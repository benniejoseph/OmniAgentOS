import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { estimateContextTokens } from "@/lib/rag/context-budget";

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

  it("builds a complete context pack when the OpenAI key is absent", async () => {
    delete process.env.OPENAI_API_KEY;
    const [{ saveMemory }, { buildContextPack }] = await Promise.all([
      import("@/lib/memory/store"),
      import("@/lib/rag/context-engine"),
    ]);
    const relevant = await saveMemory({
      tenantId: "tenant-local-context",
      title: "Worker deployment failure",
      content: "Restart the worker after a failed deployment.",
      importance: 0.8,
    });

    const pack = await buildContextPack("implantacao falha do processador", {
      tenantId: "tenant-local-context",
      limit: 2,
      persistTrace: false,
      queryPlanning: { allowSemanticModel: false },
    });

    expect(pack.results[0]).toMatchObject({
      kind: "memory",
      id: relevant.id,
    });
    expect(pack.profile.embedding).toMatchObject({
      provider: "local",
      requiresCredential: false,
      externalDisclosure: false,
    });
    expect(pack.profile.reranker).toMatchObject({
      algorithm: "pairwise_logistic_regression",
      externalDisclosure: false,
    });
  });

  it("persists a lineage-deduplicated pack that cannot exceed either token limit", async () => {
    const [{ saveMemory }, { buildContextPack }] = await Promise.all([
      import("@/lib/memory/store"),
      import("@/lib/rag/context-engine"),
    ]);
    const repeated = "Restore the Orion database from its verified backup. ";
    await saveMemory({
      tenantId: "tenant-context-budget",
      title: "Orion restore source A",
      content: repeated.repeat(18),
      type: "knowledge",
      tier: "semantic",
      evidenceRefs: ["knowledge:orion-runbook"],
      importance: 0.9,
    });
    await saveMemory({
      tenantId: "tenant-context-budget",
      title: "Orion restore source B",
      content: `${repeated.repeat(15)}Validate the checksum.`,
      type: "knowledge",
      tier: "semantic",
      evidenceRefs: ["knowledge:orion-runbook"],
      importance: 0.85,
    });
    await saveMemory({
      tenantId: "tenant-context-budget",
      title: "Orion recovery approval",
      content: "The approved decision is to stop writes before the Orion restore.",
      type: "decision",
      tier: "decision",
      evidenceRefs: ["turn:orion-decision"],
      importance: 0.95,
    });

    const pack = await buildContextPack(
      "What is the approved Orion database restore procedure?",
      {
        tenantId: "tenant-context-budget",
        limit: 6,
        persistTrace: true,
        queryPlanning: { allowSemanticModel: false },
        contextBudget: {
          modelInputTokenLimit: 1_200,
          reservedModelTokens: 300,
          taskContextTokenLimit: 760,
          duplicateTokenShareTarget: 0.2,
        },
      },
    );

    expect(pack.budget).toMatchObject({
      version: "p4.5-context-budget:1",
      effectiveTokenLimit: 760,
      withinBudget: true,
    });
    expect(estimateContextTokens(pack.contextBlock)).toBeLessThanOrEqual(760);
    expect(pack.budget.duplicateCandidateCount).toBeGreaterThan(0);
    expect(pack.budget.duplicateTokenShare).toBeLessThanOrEqual(0.2);
    expect(pack.results.every((item) =>
      /^[a-f0-9]{64}$/.test(item.lineageRefSha256 || "") &&
      Boolean(item.contextTier) &&
      Number.isInteger(item.tokenEstimate)
    )).toBe(true);
    expect(pack.trace?.contextBudget).toEqual(pack.budget);
    expect(JSON.stringify(pack.trace?.contextBudget)).not.toContain(
      "orion-runbook",
    );
  });
});
