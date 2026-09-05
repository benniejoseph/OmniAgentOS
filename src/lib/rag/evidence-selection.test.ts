import { describe, expect, it } from "vitest";
import {
  normalizeExplicitEvidenceIds,
  selectExplicitEvidenceIds,
} from "@/lib/rag/evidence-selection";

describe("explicit evidence selection", () => {
  it("preserves undefined and treats an explicit empty list as authoritative", () => {
    expect(normalizeExplicitEvidenceIds(undefined)).toBeUndefined();
    expect(normalizeExplicitEvidenceIds([])).toEqual([]);
  });

  it("normalizes, deduplicates, validates, and bounds client IDs", () => {
    expect(
      normalizeExplicitEvidenceIds([
        " memory:selected ",
        "memory:selected",
        "knowledge:document",
        "graph:node",
        "unsupported:item",
        "memory:contains whitespace",
      ]),
    ).toEqual(["memory:selected", "knowledge:document", "graph:node"]);

    expect(
      normalizeExplicitEvidenceIds(
        Array.from({ length: 30 }, (_, index) => `memory:${index}`),
      ),
    ).toHaveLength(24);
  });

  it("selects only exact IDs present in server-retrieved candidates", () => {
    expect(
      selectExplicitEvidenceIds({
        explicitEvidenceIds: ["memory:selected", "memory:missing"],
        retrievableEvidenceIds: ["memory:other", "memory:selected"],
      }),
    ).toEqual(["memory:selected"]);
  });
});
