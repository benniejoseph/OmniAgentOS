import { describe, expect, it } from "vitest";

import {
  reconcileRelationProjectionState,
  relationProjectionActiveStateSha256,
} from "@/lib/entities/relation-reconciliation";
import {
  buildEntityAccessBinding,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import {
  buildTemporalRelationClaim,
  reviseTemporalRelationClaim,
} from "@/lib/entities/temporal-claims";

const accessBinding = buildEntityAccessBinding({
  tenantId: "tenant-reconcile",
  ownerActorId: "actor-reconcile",
  visibility: "user_private",
  sensitivity: "confidential",
  allowedPurposeIds: ENTITY_PURPOSE_IDS,
  boundAt: "2026-09-06T00:00:00.000Z",
});
const lineage = {
  kind: "memory" as const,
  referenceId: "memory-reconcile",
  referenceSha256: "a".repeat(64),
};
const project = buildEntityRecord({
  entityTypeId: "project",
  canonicalLabel: "Phoenix",
  accessBinding,
  lineage: [lineage],
  createdAt: "2026-09-07T00:00:00.000Z",
});
const organization = buildEntityRecord({
  entityTypeId: "organization",
  canonicalLabel: "Acme",
  accessBinding,
  lineage: [lineage],
  createdAt: "2026-09-07T00:00:00.000Z",
});
const desired = buildTemporalRelationClaim({
  relationTypeId: "belongs_to",
  sourceEntity: project,
  targetEntity: organization,
  epistemicKind: "asserted",
  confidenceBasisPoints: 9_500,
  accessBinding,
  lineage: [lineage],
  validFrom: "2026-01-01T00:00:00.000Z",
  recordedAt: "2026-09-07T00:00:00.000Z",
});

describe("relation projection reconciliation", () => {
  it("is idempotent and returns a deterministic active-state digest", () => {
    const initial = reconcileRelationProjectionState({
      desiredClaims: [desired],
      currentRecords: [],
      reconciledAt: "2026-09-07T01:00:00.000Z",
    });
    expect(initial).toMatchObject({
      createdCount: 1,
      revisedCount: 0,
      retractedCount: 0,
      unchangedCount: 0,
    });
    const replay = reconcileRelationProjectionState({
      desiredClaims: [desired],
      currentRecords: [{ claim: desired, supersededAt: null }],
      reconciledAt: "2026-09-07T02:00:00.000Z",
    });
    expect(replay.appendedRevisions).toEqual([]);
    expect(replay.unchangedCount).toBe(1);
    expect(replay.stateSha256).toBe(initial.stateSha256);
    expect(replay.stateSha256).toBe(
      relationProjectionActiveStateSha256([desired]),
    );
  });

  it("retracts missing canonical claims and reactivates them as successors", () => {
    const removed = reconcileRelationProjectionState({
      desiredClaims: [],
      currentRecords: [{ claim: desired, supersededAt: null }],
      reconciledAt: "2026-09-07T03:00:00.000Z",
    });
    expect(removed).toMatchObject({ retractedCount: 1, activeClaims: [] });
    const retracted = removed.appendedRevisions[0];
    expect(retracted).toMatchObject({
      previousRevisionId: desired.revisionId,
      claimState: "retracted",
    });

    const restored = reconcileRelationProjectionState({
      desiredClaims: [desired],
      currentRecords: [{ claim: retracted, supersededAt: null }],
      reconciledAt: "2026-09-07T04:00:00.000Z",
    });
    expect(restored).toMatchObject({ revisedCount: 1, retractedCount: 0 });
    expect(restored.appendedRevisions[0]).toMatchObject({
      previousRevisionId: retracted.revisionId,
      claimState: "active",
    });
    expect(restored.stateSha256).toBe(
      relationProjectionActiveStateSha256([desired]),
    );
  });

  it("repairs endpoint revisions and confidence without changing claim identity", () => {
    const revisedProject = buildEntityRecord({
      entityTypeId: "project",
      canonicalLabel: "Phoenix",
      accessBinding,
      lineage: [lineage, {
        kind: "memory",
        referenceId: "memory-later",
        referenceSha256: "b".repeat(64),
      }],
      createdAt: project.createdAt,
    });
    const nextDesired = buildTemporalRelationClaim({
      claimId: desired.claimId,
      relationTypeId: "belongs_to",
      sourceEntity: revisedProject,
      targetEntity: organization,
      epistemicKind: "asserted",
      confidenceBasisPoints: 8_000,
      accessBinding,
      lineage: [lineage],
      validFrom: desired.validFrom,
      recordedAt: "2026-09-07T00:00:00.000Z",
    });
    const repaired = reconcileRelationProjectionState({
      desiredClaims: [nextDesired],
      currentRecords: [{ claim: desired, supersededAt: null }],
      reconciledAt: "2026-09-07T05:00:00.000Z",
    });
    expect(repaired.revisedCount).toBe(1);
    expect(repaired.appendedRevisions[0]).toMatchObject({
      claimId: desired.claimId,
      previousRevisionId: desired.revisionId,
      source: { entitySha256: revisedProject.entitySha256 },
      confidenceBasisPoints: 8_000,
    });
  });

  it("does not retract manually governed non-source claims", () => {
    const manual = buildTemporalRelationClaim({
      relationTypeId: "belongs_to",
      sourceEntity: project,
      targetEntity: organization,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding,
      lineage: [{
        kind: "entity_assertion",
        referenceId: "assertion-one",
        referenceSha256: "c".repeat(64),
      }],
      validFrom: desired.validFrom,
      recordedAt: desired.recordedAt,
    });
    const result = reconcileRelationProjectionState({
      desiredClaims: [],
      currentRecords: [{ claim: manual, supersededAt: null }],
      reconciledAt: "2026-09-07T06:00:00.000Z",
    });
    expect(result.appendedRevisions).toEqual([]);
    expect(result.retractedCount).toBe(0);
  });

  it("advances system time even when a replay timestamp is stale", () => {
    const current = reviseTemporalRelationClaim({
      current: desired,
      confidenceBasisPoints: 9_000,
      recordedAt: "2026-09-07T07:00:00.000Z",
    });
    const result = reconcileRelationProjectionState({
      desiredClaims: [desired],
      currentRecords: [{ claim: current, supersededAt: null }],
      reconciledAt: "2026-09-07T01:00:00.000Z",
    });
    expect(result.appendedRevisions[0].recordedAt)
      .toBe("2026-09-07T07:00:00.001Z");
  });
});
