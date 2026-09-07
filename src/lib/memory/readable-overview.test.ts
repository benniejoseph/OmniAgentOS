import { describe, expect, it } from "vitest";
import { buildMemoryDeletionReceiptV1 } from "@/lib/memory/deletion-receipt";
import {
  projectReadableMemoryOverview,
  readableMemoryOverviewSchema,
} from "@/lib/memory/readable-overview";
import type { MemoryRecord } from "@/lib/memory/types";
import { createExecutionScope } from "@/lib/security/execution-scope";

const memory: MemoryRecord = {
  id: "memory-readable-a",
  type: "fact",
  tier: "semantic",
  title: "Project launch preference",
  content: "PRIVATE CLAIM BODY MUST NOT ENTER THE OVERVIEW",
  tags: ["private-tag"],
  scope: "user",
  source: "manual:private-source-coordinate",
  importance: 0.8,
  confidence: 0.91,
  claimStatus: "active",
  assertedBy: "user",
  evidenceRefs: ["evidence:private-reference"],
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-02T09:00:00.000Z",
  lastUsedAt: "2026-09-03T09:00:00.000Z",
  useCount: 3,
};

describe("readable Memory overview", () => {
  it("projects useful metadata without aggregate private content", () => {
    const deletionReceipt = buildMemoryDeletionReceiptV1({
      tenantId: "tenant-readable",
      memoryId: "memory-deleted",
      executionScope: createExecutionScope({
        tenantId: "tenant-readable",
        initiatingActorId: "actor:readable",
        executingPrincipalType: "user",
        executingPrincipalId: "actor:readable",
        correlationId: "readable-delete",
        purpose: "test.readable.delete",
      }),
      descendantMemoryIds: ["memory-deleted-child"],
      retrievalTraceIds: ["trace-deleted"],
      graphNodeIds: ["node-deleted"],
      graphEdgeIds: ["edge-deleted"],
      forgottenAt: "2026-09-04T09:00:00.000Z",
    });
    const overview = projectReadableMemoryOverview({
      memories: [memory],
      reviews: [{
        id: "review-readable",
        tenantId: "tenant-readable",
        kind: "contradiction",
        status: "pending",
        detectionReason: "explicit_contradiction",
        candidate: { ...memory, id: "memory-candidate", claimStatus: "candidate" },
        existing: memory,
        createdAt: "2026-09-03T10:00:00.000Z",
        updatedAt: "2026-09-03T10:00:00.000Z",
      }],
      traces: [{
        id: "trace-readable",
        query: "PRIVATE RETRIEVAL QUERY",
        profile: {} as never,
        resultCount: 1,
        selectedCount: 1,
        latencyMs: 12,
        results: [{
          id: memory.id,
          kind: "memory",
          sourceKey: "memory:private-source",
          title: "PRIVATE TRACE TITLE",
          score: 1,
          utilityScore: 1,
          confidence: 1,
          reasons: ["private reason"],
        }],
        createdAt: "2026-09-03T11:00:00.000Z",
      }],
      deletionReceipts: [deletionReceipt],
      entityCounts: { people: 2, projects: 1 },
      generatedAt: "2026-09-05T09:00:00.000Z",
    });

    expect(readableMemoryOverviewSchema.parse(overview)).toEqual(overview);
    expect(overview.summary).toMatchObject({
      claims: 1,
      active: 1,
      needsReview: 1,
      people: 2,
      projects: 1,
      recentUses: 1,
      deletionBarriers: 1,
    });
    expect(overview.claims[0]).toMatchObject({
      id: memory.id,
      detailDisclosure: "explicit_selection",
      recentUseCount: 1,
      hasConflict: true,
    });
    expect(overview.deletion).toMatchObject({
      barriers: 1,
      descendantsBlocked: 1,
      tracesInvalidated: 1,
      graphProjectionsInvalidated: 2,
      receiptIdentifiersIncluded: false,
    });
    const serialized = JSON.stringify(overview);
    expect(serialized).not.toContain(memory.content);
    expect(serialized).not.toContain("private-reference");
    expect(serialized).not.toContain("private-source-coordinate");
    expect(serialized).not.toContain("PRIVATE RETRIEVAL QUERY");
    expect(serialized).not.toContain("PRIVATE TRACE TITLE");
    expect(serialized).not.toContain("trace-readable");
    expect(serialized).not.toContain("review-readable");
    expect(serialized).not.toContain(deletionReceipt.id);
    expect(serialized).not.toContain(deletionReceipt.memoryId);
  });
});
