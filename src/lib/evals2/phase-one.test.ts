import { describe, expect, it } from "vitest";

import { runPhaseOneGate } from "@/lib/evals2/phase-one";
import {
  MUTATION_EVENT_CONTRACTS,
  type MutationEventContract,
} from "@/lib/events/mutation-registry";

const gateInput = Object.freeze({
  tenantId: "tenant-a",
  actorId: "actor-a",
  correlationId: "p1-phase-gate-a",
});

describe("Phase 1 production gate", () => {
  it("proves all seven Phase 1 rows through their runtime contracts", async () => {
    const result = await runPhaseOneGate(gateInput);

    expect(result.report).toMatchObject({
      schemaVersion: 1,
      suiteId: "p1-production-phase-gate-v1",
      gateCount: 7,
      passedGateCount: 7,
      failedGateIds: [],
      mutationDomainCount: 11,
      eventedMutationDomainCount: 10,
      noMutationSurfaceCount: 1,
      mutationEventTypeCount: 75,
      projectionCount: 10,
      matchedProjectionCount: 10,
      projectionReplayBasisPoints: 10_000,
      outcomeCaseCount: 15,
      outcomePassedCaseCount: 15,
      negativeOutcomeCaseCount: 14,
      falseSuccessCount: 0,
      effectReceiptContractCount: 1,
      claimEvidenceMapCount: 1,
      materialClaimCount: 1,
      unsupportedClaimCount: 1,
      checkpointContractCount: 1,
      forkLineageContractCount: 1,
      effectCount: 0,
      passed: true,
    });
    expect(result.report.suiteSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.observations.map((observation) => observation.gateId)).toEqual([
      "p1.1",
      "p1.2",
      "p1.3",
      "p1.4",
      "p1.5",
      "p1.6",
      "p1.7",
    ]);
    expect(result.observations.every((observation) => observation.passed)).toBe(true);
  });

  it("fails closed when a required atomic writer domain is missing", async () => {
    const mutationContracts = MUTATION_EVENT_CONTRACTS.filter(
      (contract) => contract.domain !== "tools",
    ) as readonly MutationEventContract[];
    const result = await runPhaseOneGate(gateInput, { mutationContracts });

    expect(result.report.passed).toBe(false);
    expect(result.report.failedGateIds).toEqual(["p1.1", "p1.2"]);
    expect(result.report.mutationDomainCount).toBe(10);
  });

  it("returns the same content-free report for the same input", async () => {
    const first = await runPhaseOneGate(gateInput);
    const second = await runPhaseOneGate(gateInput);

    expect(second).toEqual(first);
    expect(JSON.stringify(first)).not.toContain("synthetic launch date");
    expect(JSON.stringify(first)).not.toContain("corrected synthetic fixture");
  });
});
