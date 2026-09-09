import { describe, expect, it } from "vitest";
import { canonicalSourceRevisionAdvanceAllowed } from "@/lib/sources/store";

const current = {
  requestedRevisionId: "source_revision_requested",
  requestedSourceUpdatedAt: "2026-08-28T08:04:54.202Z",
  requestedCapturedAt: "2026-08-28T08:04:54.202Z",
  currentRevisionId: "source_revision_current",
  currentSourceUpdatedAt: "2026-08-28T08:04:54.202Z",
  currentCapturedAt: "2026-08-28T08:04:54.202Z",
  currentHasKnowledgeBinding: true,
} as const;

describe("canonical source revision advancement", () => {
  it("orders revisions by provider observation time, not content-derived ids", () => {
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      requestedSourceUpdatedAt: "2026-08-29T08:04:54.202Z",
    })).toBe(true);
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      requestedSourceUpdatedAt: "2026-08-27T08:04:54.202Z",
    })).toBe(false);
  });

  it("allows an exact retry but protects a bound equal-time revision", () => {
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      requestedRevisionId: current.currentRevisionId,
    })).toBe(true);
    expect(canonicalSourceRevisionAdvanceAllowed(current)).toBe(false);
  });

  it("repairs an orphaned equal-time revision", () => {
    expect(canonicalSourceRevisionAdvanceAllowed({
      ...current,
      currentHasKnowledgeBinding: false,
    })).toBe(true);
  });
});
