import { describe, expect, it } from "vitest";
import {
  memoryReconciliationDetectionReason,
  memoryReconciliationResolution,
} from "@/lib/memory/reconciliation";

describe("memory reconciliation policy", () => {
  it("confirms a contradiction by activating the candidate and retiring the old claim", () => {
    expect(memoryReconciliationResolution(
      "contradiction",
      "confirm_candidate",
    )).toEqual({
      candidateStatus: "active",
      existingStatus: "contradicted",
      closeCandidateValidity: false,
      closeExistingValidity: true,
    });
  });

  it("can reject a candidate without changing the existing claim", () => {
    expect(memoryReconciliationResolution(
      "contradiction",
      "keep_existing",
    )).toEqual({
      candidateStatus: "superseded",
      existingStatus: "active",
      closeCandidateValidity: true,
      closeExistingValidity: false,
    });
  });

  it("keeps contradictory claims active only after explicit review", () => {
    expect(memoryReconciliationResolution(
      "contradiction",
      "keep_both",
    )).toEqual({
      candidateStatus: "active",
      existingStatus: "active",
      closeCandidateValidity: false,
      closeExistingValidity: false,
    });
  });

  it("rejects keep-both for a confirmation without an existing claim", () => {
    expect(() => memoryReconciliationResolution(
      "confirmation",
      "keep_both",
    )).toThrow("cannot keep both");
  });

  it("distinguishes explicit conflicts from unverified inference candidates", () => {
    expect(memoryReconciliationDetectionReason({
      assertedBy: "user",
      contradictionOfId: "memory-old",
      source: "correction:actor-a",
      tags: [],
    })).toBe("explicit_contradiction");
    expect(memoryReconciliationDetectionReason({
      assertedBy: "agent",
      source: "assistant-inference",
      tags: ["needs-confirmation"],
    })).toBe("unverified_inference");
  });
});
