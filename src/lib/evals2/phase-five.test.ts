import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PHASE_FIVE_GATE_SUITE_ID,
  runPhaseFiveGate,
} from "@/lib/evals2/phase-five";

const resolutionSuite = JSON.parse(fs.readFileSync(
  path.resolve("evals/p52/entity-resolution.v1.json"),
  "utf8",
)) as Record<string, unknown>;

describe("Phase 5 aggregate production gate", () => {
  it("passes every graph invariant without persistence or effects", async () => {
    const result = await runPhaseFiveGate({
      tenantId: "tenant-phase-five",
      actorId: "actor-phase-five",
      correlationId: "phase-five-correlation",
      entityResolutionSuite: resolutionSuite,
    });

    expect(result.observations).toHaveLength(6);
    expect(result.observations.every((observation) => observation.passed))
      .toBe(true);
    expect(result.report).toMatchObject({
      schemaVersion: 1,
      suiteId: PHASE_FIVE_GATE_SUITE_ID,
      gateCount: 6,
      passedGateCount: 6,
      failedGateIds: [],
      ontologyEntityTypeCount: 17,
      ontologyRelationTypeCount: 13,
      entityResolutionPrecisionBasisPoints: 10_000,
      entityResolutionScopeLeakCount: 0,
      entityResolutionFalseAutoMergeCount: 0,
      temporalCaseCount: 8,
      temporalPassedCaseCount: 8,
      orphanEvidenceCount: 0,
      rebuildParityBasisPoints: 10_000,
      deletionPropagationPassed: true,
      multiHopPathCount: 1,
      unevidencedRelationshipHopCount: 0,
      crossScopeRejectionCount: 1,
      crossScopeLeakCount: 0,
      storagePrimaryAdapterId: "postgres-temporal-graph:1",
      storageShadowState: "matched",
      storageParityBasisPoints: 10_000,
      storageDisposition: "collect_more_telemetry",
      graphDatabasePromotionReady: false,
      effectCount: 0,
      passed: true,
    });
    expect(result.report.suiteSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(result.report)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(result.report)).not.toContain("synthetic-memory-a");
  });

  it("fails closed when the production-like resolution suite regresses", async () => {
    const cases = resolutionSuite.cases as Array<Record<string, unknown>>;
    const regressed = structuredClone(resolutionSuite);
    (regressed.cases as Array<Record<string, unknown>>)[0] = {
      ...cases[0],
      expected: {
        ...(cases[0].expected as Record<string, unknown>),
        decision: "create_new",
        selectedEntityId: null,
        candidateEntityIds: [],
        matchMethod: "none",
      },
    };

    const result = await runPhaseFiveGate({
      tenantId: "tenant-phase-five",
      actorId: "actor-phase-five",
      correlationId: "phase-five-regression",
      entityResolutionSuite: regressed,
    });

    expect(result.report.passed).toBe(false);
    expect(result.report.failedGateIds).toEqual(["p5.2"]);
    expect(result.observations.find(({ gateId }) => gateId === "p5.2"))
      .toMatchObject({ passed: false });
  });
});
