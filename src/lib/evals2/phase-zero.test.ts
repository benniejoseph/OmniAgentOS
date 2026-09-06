import { describe, expect, it } from "vitest";

import p05Suite from "../../../evals/p05/suite.v1.json";
import {
  LOOP_V2_CAPABILITY_ID,
  LOOP_V2_CONFIGURATION_SHA256,
  LOOP_V2_CONTRACT_VERSION_ID,
  LOOP_V2_ENGINE_VERSION_ID,
} from "@/lib/orchestration/loop-v2";
import { runPhaseZeroGate } from "@/lib/evals2/phase-zero";
import type { TenantCapabilityRollout } from "@/lib/rollouts/tenant-capability-rollouts";

describe("Phase 0 production gate", () => {
  it("proves all six Phase 0 rows through the current runtime contracts", () => {
    const result = runPhaseZeroGate({
      p05Suite,
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p0-phase-gate-a",
      currentRollout: activeRollout(),
    });

    expect(result.report).toMatchObject({
      schemaVersion: 1,
      suiteId: "p0-production-phase-gate-v1",
      gateCount: 6,
      passedGateCount: 6,
      failedGateIds: [],
      scopeBoundaryCount: 10,
      scopedBoundaryCount: 10,
      runContractCount: 6,
      currentRolloutGeneration: 7,
      currentRolloutStatus: "active",
      canonicalStatusCount: 9,
      observedCanonicalStatusCount: 9,
      baselineCaseCount: 16,
      baselinePassedCaseCount: 16,
      baselineScoreBasisPoints: 10_000,
      acceptedArchitectureDecisionCount: 7,
      unresolvedArchitectureDecisionCount: 0,
      effectCount: 0,
      passed: true,
    });
    expect(result.report.suiteSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.observations.map((observation) => observation.gateId)).toEqual([
      "p0.1",
      "p0.2",
      "p0.3",
      "p0.4",
      "p0.5",
      "p0.6",
    ]);
    expect(result.observations.every((observation) => observation.passed)).toBe(true);
  });

  it("fails closed when the production rollout pin is absent", () => {
    const result = runPhaseZeroGate({
      p05Suite,
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p0-phase-gate-b",
      currentRollout: null,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.failedGateIds).toEqual(["p0.3"]);
  });

  it("fails closed when a required architecture decision is unresolved", () => {
    const result = runPhaseZeroGate({
      p05Suite,
      tenantId: "tenant-a",
      actorId: "actor-a",
      correlationId: "p0-phase-gate-c",
      currentRollout: activeRollout(),
    }, {
      decisions: [
        { id: "ADR-005", topic: "canonical_truth", status: "proposed" },
      ],
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.failedGateIds).toEqual(["p0.6"]);
    expect(result.report.unresolvedArchitectureDecisionCount).toBe(1);
  });
});

function activeRollout(): TenantCapabilityRollout {
  return {
    schemaVersion: 1,
    tenantId: "tenant-a",
    capabilityId: LOOP_V2_CAPABILITY_ID,
    rolloutGeneration: 7,
    engineVersion: LOOP_V2_ENGINE_VERSION_ID,
    contractVersionId: LOOP_V2_CONTRACT_VERSION_ID,
    configurationSha256: LOOP_V2_CONFIGURATION_SHA256,
    mode: "canary",
    status: "active",
    lifecycleRevision: 1,
    createdByActorId: "actor-a",
    activatedByActorId: "actor-a",
    activatedAt: "2026-09-06T00:00:01.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:01.000Z",
  };
}

