import { describe, expect, it } from "vitest";

import {
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityRecord,
  resolveEntityIdentity,
} from "@/lib/entities/registry";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const at = "2026-09-06T00:00:00.000Z";
const evidence = {
  kind: "evidence_unit" as const,
  referenceId: "synthetic-entity-resolution",
  referenceSha256: sourceContractSha256("synthetic-entity-resolution"),
};

describe("P5.2 entity-resolution precision gate", () => {
  it("has zero false auto-merges across exact, fuzzy, ambiguous, and cross-scope cases", () => {
    const owner = binding("actor-owner");
    const sibling = binding("actor-sibling");
    const ada = record("entity-ada", "Ada Lovelace", owner);
    const grace = record("entity-grace", "Grace Hopper", owner);
    const siblingAda = record("entity-sibling-ada", "Ada Lovelace", sibling);
    const adaAlias = buildEntityAlias({
      entity: ada,
      alias: "A. Lovelace",
      lineage: evidence,
      createdAt: at,
    });
    const candidates = [
      { entity: ada, aliases: [adaAlias] },
      { entity: grace, aliases: [] },
      { entity: siblingAda, aliases: [] },
    ];
    const cases = [
      { label: "Ada Lovelace", expected: "entity-ada" },
      { label: "A. Lovelace", expected: "entity-ada" },
      { label: "Grace Hopper", expected: "entity-grace" },
      { label: "Ada", expected: null },
      { label: "Grace H.", expected: null },
      { label: "Unknown Person", expected: null },
    ];
    const decisions = cases.map((testCase, index) => ({
      testCase,
      decision: resolveEntityIdentity({
        entityTypeId: "person",
        label: testCase.label,
        accessBinding: owner,
        candidates,
        decidedAt: `2026-09-06T00:0${index}:00.000Z`,
      }),
    }));
    const autoLinks = decisions.filter(({ decision }) =>
      decision.decision === "auto_link"
    );
    const correctAutoLinks = autoLinks.filter(({ decision, testCase }) =>
      decision.selectedEntityId === testCase.expected
    );

    expect(autoLinks).toHaveLength(3);
    expect(correctAutoLinks).toHaveLength(autoLinks.length);
    expect(Math.round(correctAutoLinks.length / autoLinks.length * 10_000)).toBe(10_000);
    expect(decisions.filter(({ testCase, decision }) =>
      testCase.expected === null && decision.decision === "auto_link"
    )).toEqual([]);
    expect(decisions.some(({ decision }) =>
      decision.candidateEntityIds.includes(siblingAda.entityId)
    )).toBe(false);
  });
});

function binding(ownerActorId: string) {
  return buildEntityAccessBinding({
    tenantId: "tenant-benchmark",
    ownerActorId,
    visibility: "user_private",
    sensitivity: "confidential",
    allowedPurposeIds: ["entity.read.v1", "entity.resolve.v1"],
    boundAt: at,
  });
}

function record(
  entityId: string,
  canonicalLabel: string,
  accessBinding: ReturnType<typeof binding>,
) {
  return buildEntityRecord({
    entityId,
    entityTypeId: "person",
    canonicalLabel,
    accessBinding,
    lineage: [evidence],
    createdAt: at,
  });
}
