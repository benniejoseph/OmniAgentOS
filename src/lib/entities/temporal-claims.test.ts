import { describe, expect, it } from "vitest";

import {
  buildEntityAccessBinding,
  buildEntityRecord,
} from "@/lib/entities/registry";
import {
  buildTemporalRelationClaim,
  parseTemporalRelationClaimRevision,
  relationClaimIsVisibleAt,
  reviseTemporalRelationClaim,
} from "@/lib/entities/temporal-claims";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-02-01T00:00:00.000Z";
const t2 = "2026-03-01T00:00:00.000Z";

describe("bitemporal entity relation claims", () => {
  it.each(["asserted", "observed", "inferred", "computed"] as const)(
    "keeps %s relations epistemically distinct",
    (epistemicKind) => {
      const { person, project, binding } = fixture();
      const claim = buildTemporalRelationClaim({
        claimId: `claim-${epistemicKind}`,
        relationTypeId: "affiliated_with",
        sourceEntity: person,
        targetEntity: project,
        epistemicKind,
        confidenceBasisPoints: 8_000,
        accessBinding: binding,
        lineage: [lineage(`evidence-${epistemicKind}`)],
        validFrom: t0,
        recordedAt: t1,
      });

      expect(parseTemporalRelationClaimRevision(claim)).toMatchObject({
        epistemicKind,
        validFrom: t0,
        validTo: null,
        recordedAt: t1,
      });
    },
  );

  it("enforces ontology endpoint types and canonicalizes symmetric edges", () => {
    const { person, organization, project, binding } = fixture();
    expect(() => buildTemporalRelationClaim({
      relationTypeId: "assigned_to",
      sourceEntity: person,
      targetEntity: project,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-invalid")],
      validFrom: t0,
      recordedAt: t1,
    })).toThrow(/source type/i);

    const symmetric = buildTemporalRelationClaim({
      relationTypeId: "related_to",
      sourceEntity: organization,
      targetEntity: person,
      epistemicKind: "observed",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-symmetric")],
      validFrom: t0,
      recordedAt: t1,
    });
    expect(symmetric.source.entityId < symmetric.target.entityId).toBe(true);
  });

  it("uses half-open valid and system intervals across revisions", () => {
    const { person, project, binding } = fixture();
    const original = buildTemporalRelationClaim({
      claimId: "claim-affiliation",
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: project,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-affiliation")],
      validFrom: t0,
      recordedAt: t1,
    });
    const revision = reviseTemporalRelationClaim({
      current: original,
      validTo: t2,
      recordedAt: t2,
    });
    const originalRecord = { claim: original, supersededAt: t2 };
    const revisedRecord = { claim: revision, supersededAt: null };

    expect(relationClaimIsVisibleAt(originalRecord, {
      validAt: t1,
      recordedAt: "2026-02-15T00:00:00.000Z",
    })).toBe(true);
    expect(relationClaimIsVisibleAt(originalRecord, {
      validAt: t1,
      recordedAt: t2,
    })).toBe(false);
    expect(relationClaimIsVisibleAt(revisedRecord, {
      validAt: t2,
      recordedAt: t2,
    })).toBe(false);
    expect(revision).toMatchObject({
      claimId: original.claimId,
      previousRevisionId: original.revisionId,
      validTo: t2,
    });
  });

  it("preserves separately evidenced conflicting dated facts", () => {
    const { person, project, organization, binding } = fixture();
    const left = buildTemporalRelationClaim({
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: project,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-left")],
      validFrom: t0,
      recordedAt: t1,
    });
    const right = buildTemporalRelationClaim({
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: organization,
      epistemicKind: "observed",
      confidenceBasisPoints: 9_000,
      accessBinding: binding,
      lineage: [lineage("evidence-right")],
      validFrom: t0,
      recordedAt: t1,
    });

    expect(left.claimId).not.toBe(right.claimId);
    expect(left.target.entityId).not.toBe(right.target.entityId);
  });

  it("rejects tampering and non-empty interval violations", () => {
    const { person, project, binding } = fixture();
    expect(() => buildTemporalRelationClaim({
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: project,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-time")],
      validFrom: t2,
      validTo: t1,
      recordedAt: t1,
    })).toThrow(/non-empty interval/i);

    const claim = buildTemporalRelationClaim({
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: project,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-tamper")],
      validFrom: t0,
      recordedAt: t1,
    });
    expect(() => parseTemporalRelationClaimRevision({
      ...claim,
      confidenceBasisPoints: 1,
    })).toThrow(/digest/i);
  });
});

function fixture() {
  const binding = buildEntityAccessBinding({
    tenantId: "tenant-a",
    ownerActorId: "actor-a",
    visibility: "user_private",
    sensitivity: "confidential",
    allowedPurposeIds: [
      "entity.read.v1",
      "entity.resolve.v1",
      "entity.review.v1",
      "entity.write.v1",
    ],
    boundAt: t0,
  });
  return {
    binding,
    person: entity("entity-person", "person", "Ada", binding),
    organization: entity(
      "entity-organization",
      "organization",
      "Analytical Society",
      binding,
    ),
    project: entity("entity-project", "organization", "Engine", binding),
  };
}

function entity(
  entityId: string,
  entityTypeId: "person" | "organization",
  canonicalLabel: string,
  accessBinding: ReturnType<typeof buildEntityAccessBinding>,
) {
  return buildEntityRecord({
    entityId,
    entityTypeId,
    canonicalLabel,
    accessBinding,
    lineage: [lineage(`entity-${entityId}`)],
    createdAt: t0,
  });
}

function lineage(referenceId: string) {
  return {
    kind: "evidence_unit" as const,
    referenceId,
    referenceSha256: sourceContractSha256(referenceId),
  };
}
