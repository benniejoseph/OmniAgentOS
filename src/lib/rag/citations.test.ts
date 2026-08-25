import { describe, expect, it } from "vitest";
import { verifyResponseCitations } from "@/lib/rag/citations";
import type { ContextEvidenceItem } from "@/lib/rag/types";

const evidence = [{ id: "memory-1", kind: "memory", sourceKey: "memory-1", title: "Preference",
  content: "Concise plans.", score: 0.9, utilityScore: 0.9, supportScore: 0.9,
  diversityScore: 1, freshnessScore: 1, confidence: 0.8, reasons: [], result: {} }] as unknown as ContextEvidenceItem[];

describe("verifyResponseCitations", () => {
  it("accepts exact evidence identifiers", () => {
    expect(verifyResponseCitations("Use a concise plan [memory:memory-1].", evidence).status).toBe("verified");
  });
  it("detects missing and fabricated citations", () => {
    expect(verifyResponseCitations("Use a concise plan.", evidence).status).toBe("missing");
    expect(verifyResponseCitations("Claim [memory:not-real].", evidence)).toMatchObject({ status: "invalid", invalidIds: ["memory:not-real"] });
  });
  it("does not require citations without retrieved evidence", () => {
    expect(verifyResponseCitations("Hello.", []).status).toBe("not_required");
  });
});
