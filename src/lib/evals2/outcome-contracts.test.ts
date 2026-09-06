import { describe, expect, it } from "vitest";

import { runOutcomeContractGate } from "@/lib/evals2/outcome-contracts";

describe("P1.3 exact outcome-contract production gate", () => {
  it("allows only the exactly verified deterministic direct outcome to succeed", () => {
    const result = runOutcomeContractGate({
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p13-gate-a",
    });

    expect(result.report).toMatchObject({
      schemaVersion: 1,
      suiteId: "p1.3-outcome-contracts-v1",
      caseCount: 15,
      passedCaseCount: 15,
      negativeCaseCount: 14,
      falseSuccessCount: 0,
      verifiedSuccessCount: 1,
      rejectedTamperCount: 2,
      failedCaseIds: [],
      effectCount: 0,
      passed: true,
    });
    expect(result.report.suiteSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      result.observations.filter(
        (observation) => observation.observedOutcome === "succeeded",
      ).map((observation) => observation.caseId),
    ).toEqual(["direct_verified_read"]);
  });

  it("is deterministic for the same scoped release input", () => {
    const input = {
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p13-gate-b",
    };
    expect(runOutcomeContractGate(input)).toEqual(runOutcomeContractGate(input));
  });
});
