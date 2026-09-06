import { describe, expect, it } from "vitest";

import { buildGraphRelationshipPaths } from "@/lib/entities/graph-retrieval";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import { buildTemporalRelationClaim } from "@/lib/entities/temporal-claims";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const now = "2026-09-07T00:00:00.000Z";
const memoryA = {
  kind: "memory" as const,
  referenceId: "memory-a",
  referenceSha256: "a".repeat(64),
};
const memoryB = {
  kind: "memory" as const,
  referenceId: "memory-b",
  referenceSha256: "b".repeat(64),
};
const binding = buildEntityAccessBinding({
  tenantId: "tenant-a",
  ownerActorId: "actor-a",
  visibility: "user_private",
  sensitivity: "confidential",
  allowedPurposeIds: ENTITY_PURPOSE_IDS,
  boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
});
const ada = buildEntityRecord({
  entityId: "entity-ada",
  entityTypeId: "person",
  canonicalLabel: "Ada Lovelace",
  accessBinding: binding,
  lineage: [memoryA],
  createdAt: now,
});
const acme = buildEntityRecord({
  entityId: "entity-acme",
  entityTypeId: "organization",
  canonicalLabel: "Acme Labs",
  accessBinding: binding,
  lineage: [memoryA],
  createdAt: now,
});
const phoenix = buildEntityRecord({
  entityId: "entity-phoenix",
  entityTypeId: "project",
  canonicalLabel: "Project Phoenix",
  accessBinding: binding,
  lineage: [memoryB],
  createdAt: now,
});

function relation(
  relationTypeId: "affiliated_with" | "belongs_to",
  sourceEntity: typeof ada | typeof phoenix,
  targetEntity: typeof acme,
  lineage: typeof memoryA | typeof memoryB,
) {
  return {
    claim: buildTemporalRelationClaim({
      relationTypeId,
      sourceEntity,
      targetEntity,
      epistemicKind: "asserted",
      confidenceBasisPoints: 9_500,
      accessBinding: binding,
      lineage: [lineage],
      validFrom: now,
      recordedAt: now,
    }),
    supersededAt: null,
  };
}

function evidence(reference: typeof memoryA | typeof memoryB) {
  return {
    referenceKind: reference.kind,
    referenceId: reference.referenceId,
    referenceSha256: reference.referenceSha256,
    evidence: {
      evidenceId: `memory:${reference.referenceId}`,
      kind: "memory" as const,
      title: `Evidence ${reference.referenceId}`,
      excerpt: "An explicit user assertion.",
      source: "manual",
      observedAt: now,
    },
  };
}

describe("P5.5 graph relationship retrieval", () => {
  it("expands an alias anchor through two authorized, evidenced hops", () => {
    const result = buildGraphRelationshipPaths({
      query: "What project is Countess Ada connected to?",
      accessBinding: binding,
      entities: [ada, acme, phoenix],
      aliases: [buildEntityAlias({
        entity: ada,
        alias: "Countess Ada",
        lineage: memoryA,
        createdAt: now,
      })],
      relations: [
        relation("affiliated_with", ada, acme, memoryA),
        relation("belongs_to", phoenix, acme, memoryB),
      ],
      evidence: [evidence(memoryA), evidence(memoryB)],
      maxHops: 2,
      asOfTime: "2026-09-07T00:00:01.000Z",
    });

    const path = result.paths.find((candidate) =>
      candidate.terminal.entityId === phoenix.entityId
    );
    expect(path).toMatchObject({
      anchor: { entityId: ada.entityId },
      terminal: { entityId: phoenix.entityId },
      hopCount: 2,
    });
    expect(path?.hops.map((hop) => hop.direction)).toEqual([
      "forward",
      "reverse",
    ]);
    expect(path?.hops.every((hop) => hop.evidence.length === 1)).toBe(true);
    expect(path?.explanation).toContain("Ada Lovelace");
    expect(path?.explanation).toContain("Project Phoenix");
    expect(result.receipt).toMatchObject({
      version: "p5.5-graph-retrieval:1",
      anchorCount: 1,
      authorizedRelationCount: 2,
      rejectedRelationCount: 0,
    });
    const { receiptSha256, ...receiptBody } = result.receipt;
    expect(receiptSha256).toBe(sourceContractSha256(receiptBody));
  });

  it("holds a relationship whose exact lineage evidence is unavailable", () => {
    const result = buildGraphRelationshipPaths({
      query: "How is Ada Lovelace affiliated?",
      accessBinding: binding,
      entities: [ada, acme],
      aliases: [],
      relations: [relation("affiliated_with", ada, acme, memoryA)],
      evidence: [],
      asOfTime: "2026-09-07T00:00:01.000Z",
    });

    expect(result.paths).toEqual([]);
    expect(result.receipt).toMatchObject({
      authorizedRelationCount: 0,
      rejectedRelationCount: 1,
    });
  });

  it("does not expose unrelated adjacent nodes when no scoped anchor matches", () => {
    const result = buildGraphRelationshipPaths({
      query: "Tell me about an unrelated person",
      accessBinding: binding,
      entities: [ada, acme],
      aliases: [],
      relations: [relation("affiliated_with", ada, acme, memoryA)],
      evidence: [evidence(memoryA)],
      asOfTime: "2026-09-07T00:00:01.000Z",
    });

    expect(result.paths).toEqual([]);
    expect(result.receipt.anchorCount).toBe(0);
  });
});
