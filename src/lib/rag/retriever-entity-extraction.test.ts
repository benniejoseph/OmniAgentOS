import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import { readEntityRegistry } from "@/lib/entities/store";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

vi.mock("@/lib/openai/client", () => ({
  embedTexts: vi.fn(async (texts: readonly string[]) =>
    texts.map(() => [0.1, 0.2])
  ),
}));

const tenantId = "tenant-source-entity-integration";
const actorId = "actor-source-entity-integration";
const temporaryDirectories: string[] = [];
let previousDataDirectory: string | undefined;
let previousDatabaseUrl: string | undefined;

beforeEach(async () => {
  previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
  previousDatabaseUrl = process.env.DATABASE_URL;
  const directory = await mkdtemp(path.join(tmpdir(), "asael-source-entity-"));
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

describe("knowledge ingestion entity projection", () => {
  it("projects explicit markers from canonical private evidence", async () => {
    const sourceScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "source-entity-ingestion",
      contextGrantIds: ["connection-source-entity"],
      purpose: "knowledge.ingest.test",
    });
    const knowledge = await ingestTextDocument({
      idempotencyKey: "source-entity-document",
      tenantId,
      title: "Entity source",
      content: "organization: Acme Corporation; product named \"Asael\"",
      source: "google:drive:source-entity-test",
      sourceLineage: {
        executionScope: sourceScope,
        connectionId: "connection-source-entity",
        adapterId: "source-entity-test-adapter",
        externalItemId: "source-entity-fixture",
        sourceKind: "document",
        capturedAt: "2026-09-06T00:00:00.000Z",
      },
    });

    expect(knowledge.chunks[0].evidenceUnitId).toEqual(expect.any(String));
    const registry = await readEntityRegistry({
      accessBinding: buildEntityAccessBinding({
        tenantId,
        ownerActorId: actorId,
        visibility: "user_private",
        sensitivity: "confidential",
        allowedPurposeIds: ENTITY_PURPOSE_IDS,
        boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
      }),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "user",
        executingPrincipalId: actorId,
        correlationId: "read-source-entity-ingestion",
        purpose: "entity.read.v1",
      }),
    });
    expect(registry.entities.map((entity) => [
      entity.entityTypeId,
      entity.canonicalLabel,
      entity.lineage[0].kind,
      entity.lineage[0].referenceId,
    ])).toEqual([
      [
        "organization",
        "Acme Corporation",
        "evidence_unit",
        knowledge.chunks[0].evidenceUnitId,
      ],
      [
        "product",
        "Asael",
        "evidence_unit",
        knowledge.chunks[0].evidenceUnitId,
      ],
    ]);

    const sourcePrefix = "google:drive:";
    await expect(deleteKnowledgeDocumentsBySourcePrefix(sourcePrefix, {
      tenantId,
      actorId,
      mutation: {
        idempotencyKey: "delete-source-entity-document",
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          correlationId: "delete-source-entity-ingestion",
          causationId: knowledgeDeletionTargetId(sourcePrefix),
          purpose: "knowledge.delete_source",
        }),
      },
    })).resolves.toMatchObject({ documents: 1 });
    const afterDeletion = await readEntityRegistry({
      accessBinding: buildEntityAccessBinding({
        tenantId,
        ownerActorId: actorId,
        visibility: "user_private",
        sensitivity: "confidential",
        allowedPurposeIds: ENTITY_PURPOSE_IDS,
        boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
      }),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "user",
        executingPrincipalId: actorId,
        correlationId: "read-source-entity-after-delete",
        purpose: "entity.read.v1",
      }),
    });
    expect(afterDeletion.entities).toEqual([]);
  });
});
