import { describe, expect, it } from "vitest";
import {
  buildMemoryIntelligenceOverview,
  filterKnowledgeIndex,
  filterMemoryIndex,
  isSourceKnowledgeMemory,
  knowledgeIndexItem,
  memoryIndexItem,
  sliceIntelligencePage,
} from "@/lib/memory/intelligence";
import type { MemoryCatalogRecord } from "@/lib/memory/store";
import type { KnowledgeDocument } from "@/lib/rag/types";

const now = "2026-09-09T09:00:00.000Z";

function memory(
  input: Partial<MemoryCatalogRecord> & Pick<MemoryCatalogRecord, "id" | "title">,
): MemoryCatalogRecord {
  const { id, title, ...overrides } = input;
  return {
    id,
    tenantId: "tenant-a",
    type: "fact",
    tier: "semantic",
    tierPolicyVersion: 1,
    formationReason: "manual_user_entry",
    title,
    tags: [],
    scope: "user",
    source: "manual",
    importance: 0.8,
    confidence: 0.9,
    claimStatus: "active",
    assertedBy: "user",
    evidenceRefCount: 1,
    byteCount: 24,
    useCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function document(
  input: Partial<KnowledgeDocument> & Pick<KnowledgeDocument, "id" | "title">,
): KnowledgeDocument {
  const { id, title, ...overrides } = input;
  return {
    id,
    tenantId: "tenant-a",
    title,
    source: "capture:upload",
    sourceType: "file",
    tags: [],
    contentHash: "content-hash",
    chunkCount: 4,
    totalCharacters: 1_200,
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("memory intelligence projection", () => {
  it("separates durable memory from source knowledge without exposing content", () => {
    const durable = memory({ id: "memory-a", title: "Preferred meeting time" });
    const sourceKnowledge = memory({
      id: "knowledge-a",
      title: "Course transcript 1",
      type: "knowledge",
      formationReason: "canonical_source_observation",
      assertedBy: "import",
      tags: ["rag"],
    });

    expect(isSourceKnowledgeMemory(durable)).toBe(false);
    expect(isSourceKnowledgeMemory(sourceKnowledge)).toBe(true);
    expect(memoryIndexItem(durable)).toEqual(expect.objectContaining({
      category: "facts",
      scope: "personal",
      evidenceCount: 1,
    }));
    expect(memoryIndexItem(durable)).not.toHaveProperty("content");
  });

  it("classifies and searches knowledge by readable source metadata", () => {
    const transcript = knowledgeIndexItem(document({
      id: "doc-a",
      title: "ICT mentorship recording transcript",
      tags: ["video"],
    }));
    const mail = knowledgeIndexItem(document({
      id: "doc-b",
      title: "Weekly update",
      source: "google:mail:message-1",
      sourceType: "api",
    }));

    expect(transcript.category).toBe("transcripts");
    expect(mail.category).toBe("mail");
    expect(filterKnowledgeIndex([transcript, mail], { query: "Gmail" }))
      .toEqual([mail]);
  });

  it("builds an actionable steward status from quality signals", () => {
    const overview = buildMemoryIntelligenceOverview({
      memories: [
        memory({ id: "memory-a", title: "A durable fact", useCount: 3 }),
        memory({
          id: "candidate-a",
          title: "Needs review",
          claimStatus: "candidate",
        }),
        memory({
          id: "source-a",
          title: "Imported source",
          type: "knowledge",
          formationReason: "canonical_source_observation",
          assertedBy: "import",
          tags: ["rag"],
        }),
      ],
      documents: [document({ id: "doc-a", title: "Unclassified feed", sourceType: "api" })],
      knowledgeStats: { documents: 1, chunks: 10, characters: 2000, embedded: 7 },
      graphStats: {
        nodes: 12,
        edges: 18,
        latestBuild: {
          status: "completed",
          createdAt: now,
          latencyMs: 420,
        },
      },
      pendingReviews: 1,
      resolvedReviews: 2,
      deletionBarriers: 1,
      generatedAt: now,
    });

    expect(overview.summary.durableMemories).toBe(2);
    expect(overview.steward.state).toBe("attention");
    expect(overview.steward.learningSignals.retrievalUses).toBe(3);
    expect(overview.summary.graphStatus).toBe("current");
    expect(overview.steward.recommendations.map((item) => item.id))
      .toEqual(expect.arrayContaining(["review", "embedding", "scope"]));
  });

  it("asks Mnemosyne to repair a failed graph projection", () => {
    const overview = buildMemoryIntelligenceOverview({
      memories: [memory({ id: "memory-a", title: "A durable fact" })],
      documents: [],
      knowledgeStats: { documents: 0, chunks: 0, characters: 0, embedded: 0 },
      graphStats: {
        nodes: 12,
        edges: 18,
        latestBuild: {
          status: "failed",
          createdAt: now,
          latencyMs: 17_000,
        },
      },
      pendingReviews: 0,
      resolvedReviews: 0,
      deletionBarriers: 0,
      generatedAt: now,
    });

    expect(overview.summary.graphStatus).toBe("failed");
    expect(overview.steward.healthScore).toBe(65);
    expect(overview.steward.recommendations).toContainEqual(
      expect.objectContaining({ id: "graph", action: "rebuild_graph" }),
    );
  });

  it("does not repeat lifecycle advice during the weekly observation window", () => {
    const overview = buildMemoryIntelligenceOverview({
      memories: Array.from({ length: 24 }, (_, index) =>
        memory({ id: `memory-${index}`, title: `Memory ${index}` })
      ),
      documents: [],
      knowledgeStats: { documents: 0, chunks: 0, characters: 0, embedded: 0 },
      graphStats: {
        nodes: 20,
        edges: 30,
        latestBuild: { status: "completed", createdAt: now, latencyMs: 80 },
      },
      pendingReviews: 0,
      resolvedReviews: 0,
      deletionBarriers: 0,
      lastMaintenanceAt: "2026-09-08T09:00:00.000Z",
      generatedAt: now,
    });

    expect(overview.summary.maintenanceUpdatedAt)
      .toBe("2026-09-08T09:00:00.000Z");
    expect(overview.steward.recommendations)
      .not.toContainEqual(expect.objectContaining({ id: "maintenance" }));
  });

  it("binds pagination cursors to the active index query", () => {
    const items = [
      memoryIndexItem(memory({ id: "a", title: "A" })),
      memoryIndexItem(memory({ id: "b", title: "B" })),
    ];
    const first = sliceIntelligencePage(items, undefined, 1, { query: "" });
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(sliceIntelligencePage(items, first.nextCursor || undefined, 1, {
      query: "",
    }).items[0]?.id).toBe("b");
    expect(() => sliceIntelligencePage(
      items,
      first.nextCursor || undefined,
      1,
      { query: "changed" },
    )).toThrow("invalid or stale");
    expect(filterMemoryIndex(items, { query: "semantic" })).toHaveLength(2);
  });
});
