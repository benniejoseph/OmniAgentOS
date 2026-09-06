import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildEntityAccessBinding,
  buildEntityRecord,
} from "@/lib/entities/registry";
import { saveEntityRecord } from "@/lib/entities/store";
import {
  queryTemporalRelationClaims,
  saveTemporalRelationClaimRevision,
} from "@/lib/entities/temporal-claim-store";
import {
  buildTemporalRelationClaim,
  reviseTemporalRelationClaim,
} from "@/lib/entities/temporal-claims";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const t0 = "2026-01-01T00:00:00.000Z";
const t1 = "2026-02-01T00:00:00.000Z";
const t2 = "2026-03-01T00:00:00.000Z";
const t3 = "2026-04-01T00:00:00.000Z";
const temporaryDirectories: string[] = [];
let previousDataDirectory: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeEach(async () => {
  previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
  previousDatabaseUrl = process.env.DATABASE_URL;
  const directory = await mkdtemp(path.join(tmpdir(), "asael-temporal-claims-"));
  temporaryDirectories.push(directory);
  process.env.OMNIAGENT_DATA_DIR = directory;
  delete process.env.DATABASE_URL;
});

afterEach(async () => {
  if (previousDataDirectory === undefined) delete process.env.OMNIAGENT_DATA_DIR;
  else process.env.OMNIAGENT_DATA_DIR = previousDataDirectory;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("temporal entity relation claim store", () => {
  it("queries valid and system time without overwriting prior revisions", async () => {
    const { binding, person, firstOrganization } = await fixture("actor-a");
    const original = buildTemporalRelationClaim({
      claimId: "claim-affiliation",
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: firstOrganization,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-original")],
      validFrom: t0,
      recordedAt: t1,
    });
    const revised = reviseTemporalRelationClaim({
      current: original,
      validTo: t3,
      confidenceBasisPoints: 9_500,
      recordedAt: t2,
    });

    await saveTemporalRelationClaimRevision({
      claim: original,
      executionScope: scope("actor-a", "entity.write.v1"),
    });
    await saveTemporalRelationClaimRevision({
      claim: revised,
      executionScope: scope("actor-a", "entity.write.v1"),
    });

    const beforeCorrection = await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      validAt: "2026-02-15T00:00:00.000Z",
      recordedAt: "2026-02-15T00:00:00.000Z",
    });
    expect(beforeCorrection.map(({ claim }) => claim.revisionId)).toEqual([
      original.revisionId,
    ]);

    const afterCorrection = await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      validAt: t2,
      recordedAt: t2,
    });
    expect(afterCorrection.map(({ claim }) => claim.revisionId)).toEqual([
      revised.revisionId,
    ]);
    expect(await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      validAt: t3,
      recordedAt: t3,
    })).toEqual([]);

    const history = await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      entityId: person.entityId,
      history: true,
    });
    expect(history).toEqual([
      expect.objectContaining({
        claim: expect.objectContaining({ revisionId: revised.revisionId }),
        supersededAt: null,
      }),
      expect.objectContaining({
        claim: expect.objectContaining({ revisionId: original.revisionId }),
        supersededAt: t2,
      }),
    ]);
    const events = await listStreamEvents("entity-relation:claim-affiliation", {
      tenantId: "tenant-a",
      actorId: "actor-a",
    });
    expect(events.map((event) => event.type)).toEqual([
      "entity.relation_claim.recorded",
      "entity.relation_claim.revised",
    ]);
  });

  it("preserves conflicting claims and filters epistemic kinds", async () => {
    const { binding, person, firstOrganization, secondOrganization } =
      await fixture("actor-a");
    const asserted = buildTemporalRelationClaim({
      claimId: "claim-left",
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: firstOrganization,
      epistemicKind: "asserted",
      confidenceBasisPoints: 10_000,
      accessBinding: binding,
      lineage: [lineage("evidence-left")],
      validFrom: t0,
      recordedAt: t1,
    });
    const observed = buildTemporalRelationClaim({
      claimId: "claim-right",
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: secondOrganization,
      epistemicKind: "observed",
      confidenceBasisPoints: 9_000,
      accessBinding: binding,
      lineage: [lineage("evidence-right")],
      validFrom: t0,
      recordedAt: t1,
    });
    for (const claim of [asserted, observed]) {
      await saveTemporalRelationClaimRevision({
        claim,
        executionScope: scope("actor-a", "entity.write.v1"),
      });
    }

    const all = await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      entityId: person.entityId,
      relationTypeId: "affiliated_with",
      validAt: t2,
      recordedAt: t2,
    });
    expect(all).toHaveLength(2);
    expect(new Set(all.map(({ claim }) => claim.target.entityId))).toEqual(
      new Set([firstOrganization.entityId, secondOrganization.entityId]),
    );
    const filtered = await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      epistemicKinds: ["observed"],
      validAt: t2,
      recordedAt: t2,
    });
    expect(filtered.map(({ claim }) => claim.claimId)).toEqual(["claim-right"]);
  });

  it("makes retraction visible in history but absent from current truth", async () => {
    const { binding, person, firstOrganization } = await fixture("actor-a");
    const original = buildTemporalRelationClaim({
      claimId: "claim-retracted",
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: firstOrganization,
      epistemicKind: "inferred",
      confidenceBasisPoints: 7_000,
      accessBinding: binding,
      lineage: [lineage("evidence-retracted")],
      validFrom: t0,
      recordedAt: t1,
    });
    const retracted = reviseTemporalRelationClaim({
      current: original,
      claimState: "retracted",
      recordedAt: t2,
    });
    await saveTemporalRelationClaimRevision({
      claim: original,
      executionScope: scope("actor-a", "entity.write.v1"),
    });
    await saveTemporalRelationClaimRevision({
      claim: retracted,
      executionScope: scope("actor-a", "entity.write.v1"),
    });

    expect(await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      validAt: t2,
      recordedAt: t2,
    })).toEqual([]);
    expect(await queryTemporalRelationClaims({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
      history: true,
    })).toHaveLength(2);
  });

  it("is idempotent and rejects a different actor scope", async () => {
    const { binding, person, firstOrganization } = await fixture("actor-a");
    const claim = buildTemporalRelationClaim({
      claimId: "claim-idempotent",
      relationTypeId: "affiliated_with",
      sourceEntity: person,
      targetEntity: firstOrganization,
      epistemicKind: "computed",
      confidenceBasisPoints: 8_000,
      accessBinding: binding,
      lineage: [lineage("evidence-idempotent")],
      validFrom: t0,
      recordedAt: t1,
    });
    const first = await saveTemporalRelationClaimRevision({
      claim,
      executionScope: scope("actor-a", "entity.write.v1"),
    });
    const second = await saveTemporalRelationClaimRevision({
      claim,
      executionScope: scope("actor-a", "entity.write.v1"),
    });
    expect(second).toEqual(first);
    await expect(saveTemporalRelationClaimRevision({
      claim,
      executionScope: scope("actor-b", "entity.write.v1"),
    })).rejects.toThrow(/scope/i);
  });
});

async function fixture(ownerActorId: string) {
  const binding = accessBinding(ownerActorId);
  const person = entity("entity-person", "person", "Ada", binding);
  const firstOrganization = entity(
    "entity-organization-a",
    "organization",
    "Analytical Society",
    binding,
  );
  const secondOrganization = entity(
    "entity-organization-b",
    "organization",
    "Royal Society",
    binding,
  );
  for (const record of [person, firstOrganization, secondOrganization]) {
    await saveEntityRecord({
      entity: record,
      executionScope: scope(ownerActorId, "entity.write.v1"),
    });
  }
  return { binding, person, firstOrganization, secondOrganization };
}

function accessBinding(ownerActorId: string) {
  return buildEntityAccessBinding({
    tenantId: "tenant-a",
    ownerActorId,
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

function scope(actorId: string, purpose: string) {
  return createExecutionScope({
    tenantId: "tenant-a",
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId: `correlation:${actorId}:${purpose}`,
    purpose,
  });
}

function lineage(referenceId: string) {
  return {
    kind: "evidence_unit" as const,
    referenceId,
    referenceSha256: sourceContractSha256(referenceId),
  };
}
