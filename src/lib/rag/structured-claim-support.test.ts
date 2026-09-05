import { describe, expect, it } from "vitest";
import { evaluateStructuredClaimSupport } from "@/lib/rag/structured-claim-support";

describe("structured claim support", () => {
  it("does not treat a valid citation ID as support for a different claim", () => {
    expect(evaluateStructuredClaimSupport({
      claims: [{
        id: "claim:revenue",
        proposition: { subject: "revenue", predicate: "growth_percent", object: 10 },
        material: true,
      }],
      evidenceUnits: [{
        id: "evidence:headcount",
        assertions: [{ subject: "headcount", predicate: "growth_percent", object: 10 }],
      }],
      candidateLinks: [{ claimId: "claim:revenue", evidenceId: "evidence:headcount" }],
      authorizedEvidenceIds: ["evidence:headcount"],
    })).toEqual({
      claims: [{
        id: "claim:revenue",
        supportState: "unsupported",
        verified: false,
        evidenceIds: [],
      }],
      materialCoverageBasisPoints: 0,
      unauthorizedEvidenceCount: 0,
    });
  });

  it("requires exact authorized support for every material claim", () => {
    const result = evaluateStructuredClaimSupport({
      claims: [
        {
          id: "claim:day",
          proposition: { subject: "launch", predicate: "scheduled_day", object: "Monday" },
          material: true,
        },
        {
          id: "claim:owner",
          proposition: { subject: "launch", predicate: "owner", object: "Synthetic Owner" },
          material: true,
        },
      ],
      evidenceUnits: [
        {
          id: "evidence:calendar",
          assertions: [{ subject: "launch", predicate: "scheduled_day", object: "Monday" }],
        },
        {
          id: "evidence:assignment",
          assertions: [{ subject: "launch", predicate: "owner", object: "Synthetic Owner" }],
        },
      ],
      candidateLinks: [
        { claimId: "claim:day", evidenceId: "evidence:calendar" },
        { claimId: "claim:owner", evidenceId: "evidence:assignment" },
      ],
      authorizedEvidenceIds: ["evidence:calendar", "evidence:assignment"],
    });

    expect(result.claims).toEqual([
      {
        id: "claim:day",
        supportState: "supported",
        verified: true,
        evidenceIds: ["evidence:calendar"],
      },
      {
        id: "claim:owner",
        supportState: "supported",
        verified: true,
        evidenceIds: ["evidence:assignment"],
      },
    ]);
    expect(result.materialCoverageBasisPoints).toBe(10_000);
  });

  it("excludes linked evidence outside the explicit authorization set", () => {
    expect(evaluateStructuredClaimSupport({
      claims: [{
        id: "claim:day",
        proposition: { subject: "launch", predicate: "scheduled_day", object: "Monday" },
        material: true,
      }],
      evidenceUnits: [{
        id: "evidence:calendar",
        assertions: [{ subject: "launch", predicate: "scheduled_day", object: "Monday" }],
      }],
      candidateLinks: [{ claimId: "claim:day", evidenceId: "evidence:calendar" }],
      authorizedEvidenceIds: [],
    })).toMatchObject({
      claims: [{ supportState: "unsupported", evidenceIds: [] }],
      materialCoverageBasisPoints: 0,
      unauthorizedEvidenceCount: 1,
    });
  });
});
