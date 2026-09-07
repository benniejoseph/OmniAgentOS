import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { MemoryOverviewPanel } from "@/components/memory-workspace";
import type { ReadableMemoryOverview } from "@/lib/memory/readable-overview";

describe("P11.6 readable Memory workspace", () => {
  it("renders safe history and explicit disclosure controls", () => {
    const markup = renderToStaticMarkup(createElement(MemoryOverviewPanel, {
      overview,
      onSelectMemory: vi.fn(),
      onShowEntities: vi.fn(),
      onShowReviews: vi.fn(),
      onShowRelationships: vi.fn(),
    }));

    expect(markup).toContain("What Asael believes");
    expect(markup).toContain("Claim bodies and named relationships stay out");
    expect(markup).toContain("Memory timeline");
    expect(markup).toContain("Permanent barriers");
    expect(markup).toContain("Progressive disclosure is active");
    expect(markup).not.toContain("PRIVATE CLAIM CONTENT");
    expect(markup).not.toContain("PRIVATE ENTITY LABEL");
  });
});

const overview: ReadableMemoryOverview = {
  version: "p11.6-readable-memory:1",
  generatedAt: "2026-09-07T12:00:00.000Z",
  state: "ready",
  disclosure: {
    aggregate: "metadata_only",
    claimContent: "explicit_selection",
    entityLabels: "explicit_reveal",
    relationshipPaths: "explicit_query",
    visualAggregation: "content_excluded",
  },
  summary: {
    claims: 1,
    active: 1,
    needsReview: 0,
    archived: 0,
    people: 1,
    projects: 1,
    scopes: 1,
    recentUses: 1,
    deletionBarriers: 1,
  },
  claims: [{
    id: "memory-one",
    title: "Readable claim title",
    type: "fact",
    tier: "semantic",
    state: "active",
    confidence: .9,
    assertedBy: "user",
    provenance: "Explicitly provided by the user.",
    sourceKind: "direct",
    scope: {
      visibility: "user private",
      boundary: "personal",
      sensitivity: "confidential",
    },
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:00.000Z",
    validFrom: null,
    validTo: null,
    lastUsedAt: "2026-09-07T11:00:00.000Z",
    useCount: 1,
    recentUseCount: 1,
    hasConflict: false,
    detailDisclosure: "explicit_selection",
  }],
  timeline: [{
    id: "use-one",
    kind: "claim_used",
    occurredAt: "2026-09-07T11:00:00.000Z",
    label: "A claim was used in context",
    memoryId: "memory-one",
    count: 1,
    contentDisclosure: "withheld",
  }],
  scopes: [{ boundary: "personal", count: 1 }],
  entities: {
    state: "available",
    people: 1,
    projects: 1,
    labelsIncluded: false,
  },
  conflicts: { pending: 0, resolved: 0, detailsIncluded: false },
  deletion: {
    barriers: 1,
    latestAt: "2026-09-06T10:00:00.000Z",
    descendantsBlocked: 0,
    tracesInvalidated: 1,
    graphProjectionsInvalidated: 2,
    receiptIdentifiersIncluded: false,
  },
};
