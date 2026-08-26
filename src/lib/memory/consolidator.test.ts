import { describe, expect, it } from "vitest";
import { reconcileConsolidatedMemoryClaims } from "@/lib/memory/consolidator";
import type { MemoryRecord } from "@/lib/memory/types";

const existing: MemoryRecord = {
  id: "existing",
  type: "preference",
  title: "Preferred writing style",
  content: "Use concise prose.\n\nSource run: old\nConfidence: 0.90",
  tags: [],
  scope: "workspace",
  source: "consolidator",
  importance: 0.7,
  confidence: 0.9,
  claimStatus: "active",
  assertedBy: "agent",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("memory claim reconciliation", () => {
  it("deduplicates the same claim across runs", () => {
    const result = reconcileConsolidatedMemoryClaims([{ type: "preference", title: "Preferred writing style", content: "Use concise prose.\nSource run: new\nConfidence: 0.80" }], [existing]);
    expect(result).toEqual([]);
  });

  it("quarantines contradictory claims for review", () => {
    const [result] = reconcileConsolidatedMemoryClaims([{ type: "preference", title: "Preferred writing style", content: "Always use long prose.", confidence: 0.9 }], [existing]);
    expect(result).toMatchObject({ claimStatus: "contradicted", contradictionOfId: "existing", confidence: 0.5 });
    expect(result.tags).toContain("needs-review");
  });

  it("recognizes a renamed version of the same atomic claim", () => {
    const [result] = reconcileConsolidatedMemoryClaims([{
      type: "preference",
      title: "Writing style preference",
      content: "Use expansive prose.",
      confidence: 0.9,
    }], [existing]);
    expect(result).toMatchObject({
      claimStatus: "contradicted",
      contradictionOfId: "existing",
    });
  });
});
