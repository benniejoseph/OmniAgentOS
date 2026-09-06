import { describe, expect, it } from "vitest";

import {
  buildRelationProjectionPlan,
  extractExplicitRelationCandidates,
} from "@/lib/entities/relation-projection";
import {
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";

const at = "2026-09-07T00:00:00.000Z";
const evidenceSha = "a".repeat(64);
const accessBinding = buildEntityAccessBinding({
  tenantId: "tenant-p54",
  ownerActorId: "actor-p54",
  visibility: "user_private",
  sensitivity: "confidential",
  allowedPurposeIds: ENTITY_PURPOSE_IDS,
  boundAt: "2026-09-06T00:00:00.000Z",
});
const lineage = {
  kind: "memory" as const,
  referenceId: "memory-p54",
  referenceSha256: evidenceSha,
};
const project = buildEntityRecord({
  entityTypeId: "project",
  canonicalLabel: "Phoenix",
  accessBinding,
  lineage: [lineage],
  createdAt: at,
});
const owner = buildEntityRecord({
  entityTypeId: "person",
  canonicalLabel: "Ada Lovelace",
  accessBinding,
  lineage: [lineage],
  createdAt: at,
});

describe("transactional relation projection planning", () => {
  it("extracts only explicit, typed, ontology-valid relation statements", () => {
    const extracted = extractExplicitRelationCandidates([
      "Ada owns Phoenix.",
      'relation: assigned_to | project: "Phoenix" -> person: "Ada"',
      'relation: assigned_to | work item: "P5.4" -> person: "Ada" | valid-from: not-a-date',
      'relation: belongs_to | project: "Phoenix" -> organization: "Acme" | valid-from: 2025-01-01T00:00:00Z',
    ].join("\n"), { validFrom: at });

    expect(extracted).toMatchObject({ markerCount: 3, rejectedMarkerCount: 2 });
    expect(extracted.candidates).toHaveLength(1);
    expect(extracted.candidates[0]).toMatchObject({
      relationTypeId: "belongs_to",
      source: { entityTypeId: "project", canonicalLabel: "Phoenix" },
      target: { entityTypeId: "organization", canonicalLabel: "Acme" },
      validFrom: "2025-01-01T00:00:00.000Z",
    });
  });

  it("builds the same desired claim set regardless of source and registry order", () => {
    const sources = [source(
      'relation: assigned_to | work item: "Graph projection" -> person: "Countess"',
      "memory-one",
      "b".repeat(64),
    ), source(
      'relation: related_to | project: "Phoenix" -> person: "Ada Lovelace"',
      "memory-two",
      "c".repeat(64),
    )];
    const workItem = buildEntityRecord({
      entityTypeId: "work_item",
      canonicalLabel: "Graph projection",
      accessBinding,
      lineage: [{ ...lineage, referenceId: "memory-one" }],
      createdAt: at,
    });
    const alias = buildEntityAlias({
      entity: owner,
      alias: "Countess",
      lineage,
      createdAt: at,
    });

    const forward = buildRelationProjectionPlan({
      sources,
      entities: [project, owner, workItem],
      aliases: [alias],
    });
    const reverse = buildRelationProjectionPlan({
      sources: [...sources].reverse(),
      entities: [workItem, owner, project],
      aliases: [alias],
    });

    expect(forward.projectionSha256).toBe(reverse.projectionSha256);
    expect(forward.desiredClaims.map((claim) => claim.claimSha256))
      .toEqual(reverse.desiredClaims.map((claim) => claim.claimSha256));
    expect(forward).toMatchObject({
      sourceCount: 2,
      markerCount: 2,
      rejectedMarkerCount: 0,
      unresolvedMarkerCount: 0,
    });
    expect(forward.desiredClaims.map((claim) => claim.relationTypeId))
      .toEqual(["assigned_to", "related_to"]);
  });

  it("holds ambiguous or cross-scope endpoints instead of creating an edge", () => {
    const duplicateOwner = buildEntityRecord({
      entityTypeId: "person",
      canonicalLabel: "Grace Hopper",
      accessBinding,
      lineage: [{ ...lineage, referenceId: "other-memory" }],
      createdAt: "2026-09-07T00:00:01.000Z",
    });
    const collidingAlias = buildEntityAlias({
      entity: duplicateOwner,
      alias: "Ada Lovelace",
      lineage: { ...lineage, referenceId: "other-memory" },
      createdAt: "2026-09-07T00:00:01.000Z",
    });
    const plan = buildRelationProjectionPlan({
      sources: [source(
        'relation: related_to | project: "Phoenix" -> person: "Ada Lovelace"',
      )],
      entities: [project, owner, duplicateOwner],
      aliases: [collidingAlias],
    });

    expect(plan.desiredClaims).toEqual([]);
    expect(plan.unresolvedMarkerCount).toBe(1);
  });

  it("never treats retrieval prose as a relation source", () => {
    const plan = buildRelationProjectionPlan({
      sources: [source("Who is assigned to Project Phoenix?")],
      entities: [project, owner],
    });
    expect(plan).toMatchObject({ markerCount: 0, unresolvedMarkerCount: 0 });
    expect(plan.desiredClaims).toEqual([]);
  });
});

function source(
  content: string,
  sourceId = "memory-p54",
  sourceSha256 = evidenceSha,
) {
  return {
    sourceKind: "memory" as const,
    sourceId,
    sourceSha256,
    content,
    accessBinding,
    epistemicKind: "asserted" as const,
    confidenceBasisPoints: 9_500,
    defaultValidFrom: at,
    defaultValidTo: null,
    recordedAt: at,
  };
}
