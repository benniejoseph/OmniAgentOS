import { describe, expect, it } from "vitest";

import {
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityMergeReview,
  buildEntityRecord,
  labelSha256,
  normalizeEntityLabel,
  resolveEntityIdentity,
  transitionEntityRecord,
} from "@/lib/entities/registry";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const recordedAt = "2026-09-06T00:00:00.000Z";
const lineage = {
  kind: "evidence_unit" as const,
  referenceId: "evidence-a",
  referenceSha256: sourceContractSha256("evidence-a"),
};

describe("entity identity registry", () => {
  it("normalizes aliases deterministically without retaining them in decisions", () => {
    expect(normalizeEntityLabel("  ACME—India, Pvt. Ltd. "))
      .toBe("acme india pvt ltd");
    expect(labelSha256("ACME India")).toBe(labelSha256("acme   india"));
  });

  it("auto-links one exact same-scope alias", () => {
    const binding = accessBinding("actor-a");
    const entity = buildEntityRecord({
      entityId: "entity-acme",
      entityTypeId: "organization",
      canonicalLabel: "Acme Corporation",
      accessBinding: binding,
      lineage: [lineage],
      createdAt: recordedAt,
    });
    const alias = buildEntityAlias({
      entity,
      alias: "Acme",
      lineage,
      createdAt: recordedAt,
    });
    const decision = resolveEntityIdentity({
      entityTypeId: "organization",
      label: "ACME",
      accessBinding: binding,
      candidates: [{ entity, aliases: [alias] }],
      decidedAt: recordedAt,
    });

    expect(decision).toMatchObject({
      decision: "auto_link",
      selectedEntityId: entity.entityId,
      matchMethod: "exact_alias",
      scoreBasisPoints: 10_000,
    });
    expect(JSON.stringify(decision)).not.toContain("ACME");
  });

  it("never auto-links cross-actor or fuzzy candidates", () => {
    const actorABinding = accessBinding("actor-a");
    const actorBBinding = accessBinding("actor-b");
    const crossActor = buildEntityRecord({
      entityId: "entity-cross-actor",
      entityTypeId: "person",
      canonicalLabel: "Bennie Joseph",
      accessBinding: actorBBinding,
      lineage: [lineage],
      createdAt: recordedAt,
    });
    const fuzzy = buildEntityRecord({
      entityId: "entity-fuzzy",
      entityTypeId: "person",
      canonicalLabel: "Bennie Richard Joseph",
      accessBinding: actorABinding,
      lineage: [lineage],
      createdAt: recordedAt,
    });
    const decision = resolveEntityIdentity({
      entityTypeId: "person",
      label: "Bennie Joseph",
      accessBinding: actorABinding,
      candidates: [
        { entity: crossActor, aliases: [] },
        { entity: fuzzy, aliases: [] },
      ],
      decidedAt: recordedAt,
    });

    expect(decision).toMatchObject({
      decision: "review_required",
      selectedEntityId: null,
      matchMethod: "fuzzy_candidate",
      candidateEntityIds: [fuzzy.entityId],
    });
    expect(decision.candidateEntityIds).not.toContain(crossActor.entityId);
  });

  it("keeps ambiguous exact matches pending and makes approvals reversible", () => {
    const binding = accessBinding("actor-a");
    const first = entity("entity-first", binding);
    const second = entity("entity-second", binding);
    const resolution = resolveEntityIdentity({
      entityTypeId: "person",
      label: "Alex Smith",
      accessBinding: binding,
      candidates: [
        { entity: first, aliases: [] },
        { entity: second, aliases: [] },
      ],
      decidedAt: recordedAt,
    });
    expect(resolution).toMatchObject({
      decision: "review_required",
      matchMethod: "ambiguous_exact",
      candidateEntityIds: [first.entityId, second.entityId],
    });

    const approval = buildEntityMergeReview({
      resolution,
      sourceEntity: second,
      targetEntity: first,
      reviewerActorId: "actor-a",
      decision: "approved",
      reviewedAt: "2026-09-06T00:01:00.000Z",
    });
    const mergedSecond = transitionEntityRecord({
      entity: second,
      state: "merged",
      mergedIntoEntityId: first.entityId,
      updatedAt: approval.reviewedAt,
    });
    const reversal = buildEntityMergeReview({
      resolution,
      sourceEntity: mergedSecond,
      targetEntity: first,
      reviewerActorId: "actor-a",
      decision: "reversed",
      previousReview: approval,
      reviewedAt: "2026-09-06T00:02:00.000Z",
    });
    expect(reversal).toMatchObject({
      decision: "reversed",
      previousReviewId: approval.reviewId,
    });
    expect(() => buildEntityMergeReview({
      resolution,
      sourceEntity: second,
      targetEntity: first,
      reviewerActorId: "actor-b",
      decision: "approved",
    })).toThrow("scoped candidates");
  });
});

function accessBinding(ownerActorId: string) {
  return buildEntityAccessBinding({
    tenantId: "tenant-a",
    ownerActorId,
    visibility: "user_private",
    sensitivity: "confidential",
    allowedPurposeIds: ["entity.resolve.v1", "entity.read.v1"],
    boundAt: recordedAt,
  });
}

function entity(
  entityId: string,
  binding: ReturnType<typeof accessBinding>,
) {
  return buildEntityRecord({
    entityId,
    entityTypeId: "person",
    canonicalLabel: "Alex Smith",
    accessBinding: binding,
    lineage: [lineage],
    createdAt: recordedAt,
  });
}
