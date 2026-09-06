import { describe, expect, it } from "vitest";

import {
  allocateContextBudget,
  annotateContextEvidenceLineage,
  estimateContextTokens,
} from "@/lib/rag/context-budget";
import type { ContextEvidenceItem } from "@/lib/rag/types";

const timestamp = "2026-09-06T00:00:00.000Z";

describe("P4.5 context lineage and token allocation", () => {
  it("collapses canonical chunks and their derived memory into one lineage", () => {
    const items = annotateContextEvidenceLineage([
      knowledge("chunk-a", "revision-a", "document-a", "first passage"),
      knowledge("chunk-b", "revision-a", "document-a", "second passage"),
      memory("memory-a", "semantic", "derived claim", ["knowledge:document-a"]),
      memory("memory-b", "decision", "independent decision", ["turn:turn-b"]),
    ]);

    expect(new Set(items.slice(0, 3).map((item) => item.lineageRefSha256)).size)
      .toBe(1);
    expect(items[3].lineageRefSha256).not.toBe(items[0].lineageRefSha256);
    expect(items.map((item) => item.contextTier)).toEqual([
      "semantic",
      "semantic",
      "semantic",
      "critical",
    ]);
    expect(items.every((item) => /^[a-f0-9]{64}$/.test(item.lineageRefSha256)))
      .toBe(true);
  });

  it("honors both hard limits and keeps duplicate-lineage tokens below target", () => {
    const repeated = "Repeated canonical source detail. ".repeat(18);
    const items = annotateContextEvidenceLineage([
      memory("decision-a", "decision", "Critical approved decision. ".repeat(12), ["turn:decision"]),
      knowledge("chunk-a", "revision-a", "document-a", repeated),
      knowledge("chunk-b", "revision-a", "document-a", `${repeated} Additional section.`),
      memory("episode-a", "episodic", "Historical execution notes. ".repeat(15), ["turn:episode"]),
      graph("graph-a", "Operational relationship map. ".repeat(12)),
    ]);
    const render = (selected: readonly (typeof items)[number][]) => [
      "Context header",
      ...selected.map((item) => `${item.kind}:${item.id}\n${item.content}`),
      "Context footer",
    ].join("\n---\n");

    const result = allocateContextBudget({
      items,
      limits: {
        modelInputTokenLimit: 900,
        reservedModelTokens: 200,
        taskContextTokenLimit: 620,
        duplicateTokenShareTarget: 0.2,
      },
      render,
    });

    expect(result.receipt.effectiveTokenLimit).toBe(620);
    expect(estimateContextTokens(result.contextBlock)).toBeLessThanOrEqual(620);
    expect(result.receipt.estimatedTokens).toBe(
      estimateContextTokens(result.contextBlock),
    );
    expect(result.receipt.withinBudget).toBe(true);
    expect(result.receipt.duplicateCandidateCount).toBeGreaterThan(0);
    expect(result.receipt.duplicateTokenShare).toBeLessThanOrEqual(0.2);
    expect(result.items.some((item) => item.contextTier === "critical")).toBe(true);
    expect(result.receipt.tierAllocations.find((item) => item.tier === "critical")?.selectedCount)
      .toBeGreaterThan(0);
    expect(result.receipt.receiptSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.receipt)).not.toContain("revision-a");
  });

  it("uses remaining model capacity when it is smaller than the task limit", () => {
    const items = annotateContextEvidenceLineage([
      memory("decision-a", "decision", "Decision context. ".repeat(20), ["turn:a"]),
    ]);
    const result = allocateContextBudget({
      items,
      limits: {
        modelInputTokenLimit: 160,
        reservedModelTokens: 120,
        taskContextTokenLimit: 500,
      },
      render: (selected) => `profile\n${selected.map((item) => item.content).join("\n")}`,
    });

    expect(result.receipt.effectiveTokenLimit).toBe(40);
    expect(result.receipt.estimatedTokens).toBeLessThanOrEqual(40);
  });
});

function memory(
  id: string,
  tier: "semantic" | "decision" | "episodic",
  content: string,
  evidenceRefs: string[],
): ContextEvidenceItem {
  return {
    id,
    kind: "memory",
    sourceKey: `memory:${id}`,
    title: id,
    content,
    score: 0.9,
    utilityScore: 0.9,
    supportScore: 0.9,
    diversityScore: 1,
    freshnessScore: 0.8,
    confidence: 0.9,
    reasons: [],
    result: {
      score: 0.9,
      reasons: [],
      record: {
        id,
        type: tier === "decision" ? "decision" : tier === "episodic" ? "episode" : "fact",
        tier,
        title: id,
        content,
        tags: [],
        scope: "user",
        source: "fixture",
        importance: 0.8,
        evidenceRefs,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
}

function knowledge(
  id: string,
  sourceRevisionId: string,
  documentId: string,
  content: string,
): ContextEvidenceItem {
  return {
    id,
    kind: "knowledge",
    sourceKey: `knowledge:${documentId}`,
    title: id,
    content,
    score: 0.8,
    utilityScore: 0.8,
    supportScore: 0.8,
    diversityScore: 1,
    freshnessScore: 0.8,
    confidence: 0.8,
    reasons: [],
    result: {
      score: 0.8,
      vectorScore: 0.8,
      lexicalScore: 0.8,
      recencyScore: 0.8,
      reasons: [],
      chunk: {
        id,
        documentId,
        sourceRevisionId,
        evidenceUnitId: `${sourceRevisionId}:${id}`,
        chunkIndex: id.endsWith("a") ? 0 : 1,
        title: id,
        content,
        tags: [],
        source: "fixture",
        tokenEstimate: estimateContextTokens(content),
        characterCount: content.length,
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      document: {
        id: documentId,
        sourceRevisionId,
        title: documentId,
        source: "fixture",
        sourceType: "text",
        tags: [],
        contentHash: "hash",
        chunkCount: 2,
        totalCharacters: content.length,
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
}

function graph(id: string, content: string): ContextEvidenceItem {
  return {
    id,
    kind: "graph",
    sourceKey: `graph:${id}`,
    title: id,
    content,
    score: 0.7,
    utilityScore: 0.7,
    supportScore: 0.7,
    diversityScore: 1,
    freshnessScore: 0.7,
    confidence: 0.7,
    reasons: [],
    result: {
      score: 0.7,
      communityId: id,
      reasons: [],
      neighborhood: [],
      node: {
        id,
        tenantId: "tenant-a",
        kind: "concept",
        label: id,
        slug: id,
        aliases: [],
        summary: content,
        weight: 0.7,
        sourceCount: 1,
        memoryIds: [],
        traceIds: [],
        tags: [],
        metadata: {},
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    },
  };
}
