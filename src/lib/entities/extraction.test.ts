import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ENTITY_EXTRACTOR_VERSION_ID,
  extractEntitiesFromExplicitMemory,
} from "@/lib/entities/extraction";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import { buildEntityAccessBinding } from "@/lib/entities/registry";
import { readEntityRegistry } from "@/lib/entities/store";
import { listStreamEvents } from "@/lib/events/store";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { formExplicitUserAssertionMemory } from "@/lib/memory/evidence-formation";
import type { MemoryRecord } from "@/lib/memory/types";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type { SecurityContext } from "@/lib/security/types";

const ownerActorId = "actor:a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6";
const context: SecurityContext = {
  tenantId: "tenant-entity-extraction",
  actorId: "owner@example.test",
  role: "admin",
  source: "session",
  auth: {
    userId: "a30f9e6c-51f4-4c3c-a0c0-7c62242f1db6",
    email: "owner@example.test",
    sessionId: "session-entity-extraction",
    tenantName: "Entity extraction test",
  },
};
const temporaryDirectories: string[] = [];
let previousDataDirectory: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeEach(async () => {
  previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
  previousDatabaseUrl = process.env.DATABASE_URL;
  const directory = await mkdtemp(path.join(tmpdir(), "asael-extraction-"));
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

describe("canonical explicit-memory entity extraction", () => {
  it("extracts only explicit typed markers with representative precision and recall", () => {
    const memory = explicitMemory([
      "person: Ada Lovelace",
      "organization: Analytical Engine Society",
      "project: Phoenix",
      "work item called \"Ship Release 1\"",
      "meeting named “Launch Review”",
      "product: Asael",
    ].join("; "));
    const extraction = extractEntitiesFromExplicitMemory(memory);
    const expected = new Set([
      "person:Ada Lovelace",
      "organization:Analytical Engine Society",
      "project:Phoenix",
      "work_item:Ship Release 1",
      "meeting:Launch Review",
      "product:Asael",
    ]);
    const observed = new Set(extraction.candidates.map((candidate) =>
      `${candidate.entityTypeId}:${candidate.canonicalLabel}`
    ));
    const truePositives = [...observed].filter((entry) => expected.has(entry)).length;
    const precision = truePositives / observed.size;
    const recall = truePositives / expected.size;

    expect(observed).toEqual(expected);
    expect(precision).toBe(1);
    expect(recall).toBe(1);
    expect(extraction.extractorVersionId).toBe(ENTITY_EXTRACTOR_VERSION_ID);
    expect(Object.isFrozen(extraction)).toBe(true);
    expect(Object.isFrozen(extraction.candidates)).toBe(true);
  });

  it("does not infer entities from ordinary capitalization", () => {
    const extraction = extractEntitiesFromExplicitMemory(explicitMemory(
      "Ada Lovelace discussed Project Phoenix with Acme Corporation.",
    ));
    expect(extraction.candidates).toEqual([]);
  });

  it("projects new entities once and keeps retry decisions idempotent", async () => {
    const input = {
      context,
      requestId: "remember-entities",
      threadId: "thread-entities",
      turnId: "turn-entities",
      message:
        "Remember that organization: Acme Corporation; project: Phoenix; person named \"Ada Lovelace\"",
    };
    const memory = await formExplicitUserAssertionMemory(input);
    await formExplicitUserAssertionMemory(input);

    const binding = buildEntityAccessBinding({
      tenantId: context.tenantId,
      ownerActorId,
      visibility: "user_private",
      sensitivity: "confidential",
      allowedPurposeIds: [
        "entity.read.v1",
        "entity.resolve.v1",
        "entity.review.v1",
        "entity.write.v1",
      ],
      boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
    });
    const registry = await readEntityRegistry({
      accessBinding: binding,
      executionScope: createExecutionScope({
        tenantId: context.tenantId,
        initiatingActorId: ownerActorId,
        executingPrincipalType: "user",
        executingPrincipalId: ownerActorId,
        correlationId: "read-projected-entities",
        purpose: "entity.read.v1",
      }),
    });

    expect(registry.entities.map((entity) => [
      entity.entityTypeId,
      entity.canonicalLabel,
    ])).toEqual([
      ["organization", "Acme Corporation"],
      ["project", "Phoenix"],
      ["person", "Ada Lovelace"],
    ]);
    expect(registry.resolutions).toHaveLength(3);
    expect(registry.resolutions.every((resolution) =>
      resolution.decision === "create_new"
    )).toBe(true);
    const events = await listStreamEvents(`memory:${memory!.id}`, {
      tenantId: context.tenantId,
      actorId: ownerActorId,
    });
    expect(events.filter((event) =>
      event.type === "entity.extraction.projected"
    )).toHaveLength(1);
    expect(events.find((event) =>
      event.type === "entity.extraction.projected"
    )?.payload).toMatchObject({
      candidateCount: 3,
      createdCount: 3,
      linkedCount: 0,
      reviewRequiredCount: 0,
    });
  });
});

function explicitMemory(content: string): MemoryRecord {
  return {
    id: "user_assertion_entity_fixture",
    tenantId: context.tenantId,
    type: "fact",
    title: "Explicit entity fixture",
    content,
    tags: ["explicit-memory", "user-assertion"],
    scope: "user",
    source: "user-assertion",
    importance: 0.9,
    confidence: 1,
    claimStatus: "active",
    assertedBy: "user",
    evidenceRefs: ["request:entity-fixture"],
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    accessBinding: buildUserPrivateMemoryAccessBindingV1({
      tenantId: context.tenantId,
      ownerActorId,
      originPurpose: "memory.user_assertion",
      accessBoundAt: "2026-09-06T00:00:00.000Z",
    }),
  };
}
