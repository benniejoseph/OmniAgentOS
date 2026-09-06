import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildEntityAccessBinding,
  buildEntityAlias,
  buildEntityRecord,
} from "@/lib/entities/registry";
import {
  readEntityRegistry,
  resolveAndRecordEntityIdentity,
  retireEntityEvidenceLineage,
  reviewEntityMerge,
  saveEntityAlias,
  saveEntityRecord,
} from "@/lib/entities/store";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { sourceContractSha256 } from "@/lib/sources/contracts";

const recordedAt = "2026-09-06T00:00:00.000Z";
const temporaryDirectories: string[] = [];
let previousDataDirectory: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeEach(async () => {
  previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
  previousDatabaseUrl = process.env.DATABASE_URL;
  const directory = await mkdtemp(path.join(tmpdir(), "asael-entities-"));
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

describe("durable entity registry", () => {
  it("persists scoped entities and aliases before recording exact resolution", async () => {
    const binding = accessBinding("actor-a");
    const entity = buildEntityRecord({
      entityId: "entity-acme",
      entityTypeId: "organization",
      canonicalLabel: "Acme Corporation",
      accessBinding: binding,
      lineage: [lineage("evidence-acme")],
      createdAt: recordedAt,
    });
    const alias = buildEntityAlias({
      entity,
      alias: "Acme",
      lineage: lineage("evidence-acme"),
      createdAt: recordedAt,
    });

    await saveEntityRecord({ entity, executionScope: scope("actor-a", "entity.write.v1") });
    await saveEntityAlias({ entity, alias, executionScope: scope("actor-a", "entity.write.v1") });
    const resolution = await resolveAndRecordEntityIdentity({
      entityTypeId: "organization",
      label: "ACME",
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.resolve.v1"),
      decidedAt: "2026-09-06T00:01:00.000Z",
    });

    expect(resolution).toMatchObject({
      decision: "auto_link",
      selectedEntityId: entity.entityId,
      matchMethod: "exact_alias",
    });
    const snapshot = await readEntityRegistry({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
    });
    expect(snapshot).toMatchObject({
      entities: [expect.objectContaining({ entityId: entity.entityId })],
      aliases: [expect.objectContaining({ aliasId: alias.aliasId })],
      resolutions: [expect.objectContaining({ resolutionId: resolution.resolutionId })],
    });
    const events = await listStreamEvents(`entity:${entity.entityId}`, {
      tenantId: "tenant-a",
      actorId: "actor-a",
    });
    expect(events.map((event) => event.type)).toEqual([
      "entity.created",
      "entity.alias.created",
    ]);
  });

  it("keeps ambiguous merges reviewed, reversible, and audit-visible", async () => {
    const binding = accessBinding("actor-a");
    const target = person("entity-alex-primary", binding);
    const source = person("entity-alex-duplicate", binding);
    await saveEntityRecord({ entity: target, executionScope: scope("actor-a", "entity.write.v1") });
    await saveEntityRecord({ entity: source, executionScope: scope("actor-a", "entity.write.v1") });
    const resolution = await resolveAndRecordEntityIdentity({
      entityTypeId: "person",
      label: "Alex Smith",
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.resolve.v1"),
      decidedAt: "2026-09-06T00:01:00.000Z",
    });
    expect(resolution.decision).toBe("review_required");

    const approval = await reviewEntityMerge({
      resolutionId: resolution.resolutionId,
      sourceEntityId: source.entityId,
      targetEntityId: target.entityId,
      decision: "approved",
      executionScope: scope("actor-a", "entity.review.v1"),
      reviewedAt: "2026-09-06T00:02:00.000Z",
    });
    let snapshot = await readEntityRegistry({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
    });
    expect(snapshot.entities.find((item) => item.entityId === source.entityId)).toMatchObject({
      state: "merged",
      mergedIntoEntityId: target.entityId,
    });

    await reviewEntityMerge({
      resolutionId: resolution.resolutionId,
      sourceEntityId: source.entityId,
      targetEntityId: target.entityId,
      decision: "reversed",
      previousReviewId: approval.reviewId,
      executionScope: scope("actor-a", "entity.review.v1"),
      reviewedAt: "2026-09-06T00:03:00.000Z",
    });
    snapshot = await readEntityRegistry({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
    });
    expect(snapshot.entities.find((item) => item.entityId === source.entityId)).toMatchObject({
      state: "active",
      mergedIntoEntityId: null,
    });
    expect(snapshot.mergeReviews.map((review) => review.decision)).toEqual([
      "approved",
      "reversed",
    ]);
    await expect(reviewEntityMerge({
      resolutionId: resolution.resolutionId,
      sourceEntityId: source.entityId,
      targetEntityId: target.entityId,
      decision: "reversed",
      previousReviewId: approval.reviewId,
      executionScope: scope("actor-a", "entity.review.v1"),
      reviewedAt: "2026-09-06T00:04:00.000Z",
    })).rejects.toThrow();
  });

  it("does not resolve or read another actor's registry", async () => {
    const actorABinding = accessBinding("actor-a");
    const actorBBinding = accessBinding("actor-b");
    const actorBEntity = person("entity-private-b", actorBBinding);
    await saveEntityRecord({
      entity: actorBEntity,
      executionScope: scope("actor-b", "entity.write.v1"),
    });

    const resolution = await resolveAndRecordEntityIdentity({
      entityTypeId: "person",
      label: "Alex Smith",
      accessBinding: actorABinding,
      executionScope: scope("actor-a", "entity.resolve.v1"),
      decidedAt: "2026-09-06T00:01:00.000Z",
    });
    expect(resolution).toMatchObject({
      decision: "create_new",
      candidateEntityIds: [],
    });
    await expect(saveEntityRecord({
      entity: actorBEntity,
      executionScope: scope("actor-a", "entity.write.v1"),
    })).rejects.toThrow("does not match");
    const snapshot = await readEntityRegistry({
      accessBinding: actorABinding,
      executionScope: scope("actor-a", "entity.read.v1"),
    });
    expect(snapshot.entities).toEqual([]);
  });

  it("retires an actor's entity when its final evidence lineage is removed", async () => {
    const binding = accessBinding("actor-a");
    const entity = buildEntityRecord({
      entityId: "entity-evidence-retirement",
      entityTypeId: "product",
      canonicalLabel: "Asael",
      accessBinding: binding,
      lineage: [lineage("evidence-retirement")],
      createdAt: recordedAt,
    });
    await saveEntityRecord({
      entity,
      executionScope: scope("actor-a", "entity.write.v1"),
    });

    await expect(retireEntityEvidenceLineage({
      tenantId: "tenant-a",
      ownerActorId: "actor-a",
      evidenceUnitIds: ["evidence-retirement"],
      executionScope: scope("actor-a", "entity.write.v1"),
      retiredAt: "2026-09-06T00:02:00.000Z",
    })).rejects.toThrow("governed lifecycle scope");
    const retirement = await retireEntityEvidenceLineage({
      tenantId: "tenant-a",
      ownerActorId: "actor-a",
      evidenceUnitIds: ["evidence-retirement"],
      executionScope: scope("actor-a", "entity.source.lifecycle.v1"),
      retiredAt: "2026-09-06T00:02:00.000Z",
    });
    expect(retirement).toMatchObject({
      affectedEntityIds: [entity.entityId],
      retiredEntityIds: [entity.entityId],
    });
    const snapshot = await readEntityRegistry({
      accessBinding: binding,
      executionScope: scope("actor-a", "entity.read.v1"),
    });
    expect(snapshot.entities).toEqual([]);
  });
});

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
    boundAt: recordedAt,
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

function person(
  entityId: string,
  binding: ReturnType<typeof accessBinding>,
) {
  return buildEntityRecord({
    entityId,
    entityTypeId: "person",
    canonicalLabel: "Alex Smith",
    accessBinding: binding,
    lineage: [lineage(`evidence:${entityId}`)],
    createdAt: recordedAt,
  });
}
