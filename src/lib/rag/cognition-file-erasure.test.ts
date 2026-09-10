import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeTextForChunking } from "@/lib/rag/chunk";
import {
  createKnowledgeDocument,
  deleteKnowledgeDocumentByIdempotencyKey,
  deleteKnowledgeDocumentsBySourcePrefix,
  retireSupersededCaptureKnowledge,
} from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";
import { buildUserPrivateMemoryAccessBindingV1 } from "@/lib/memory/access-binding";
import { saveMemory } from "@/lib/memory/store";
import type { MemoryRecord } from "@/lib/memory/types";
import { readJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { ASAEL_ONTOLOGY_EFFECTIVE_AT } from "@/lib/entities/ontology";
import {
  buildEntityAccessBinding,
  buildEntityRecord,
  ENTITY_PURPOSE_IDS,
} from "@/lib/entities/registry";
import {
  readEntityRegistry,
  saveEntityRecord,
} from "@/lib/entities/store";
import { sourceContractSha256 } from "@/lib/sources/contracts";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";

const mocks = vi.hoisted(() => ({
  purge: vi.fn(async () => 0),
}));

vi.mock("@/lib/knowledge/cognification-store", () => ({
  purgeKnowledgeCognitionsForDocuments: mocks.purge,
}));

describe("file-backed knowledge cognition erasure", () => {
  let dataDirectory = "";
  let previousDataDirectory: string | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeEach(async () => {
    vi.clearAllMocks();
    previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
    previousDatabaseUrl = process.env.DATABASE_URL;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-cognition-purge-"));
    process.env.OMNIAGENT_DATA_DIR = dataDirectory;
    delete process.env.DATABASE_URL;
  });

  afterEach(async () => {
    if (previousDataDirectory === undefined) {
      delete process.env.OMNIAGENT_DATA_DIR;
    } else {
      process.env.OMNIAGENT_DATA_DIR = previousDataDirectory;
    }
    if (previousDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = previousDatabaseUrl;
    }
    await rm(dataDirectory, { recursive: true, force: true });
  });

  it("purges review candidates before direct and prefix document deletion", async () => {
    const tenantId = "tenant-cognition-purge";
    const direct = await createKnowledgeDocument({
      idempotencyKey: "direct-delete",
      tenantId,
      title: "Direct",
      content: "Direct deletion",
      source: "upload:direct",
      chunks: [{ index: 0, content: "Direct deletion" }],
    });
    const cognitionMemoryId = "memory:cognition-review-direct-delete";
    const memoryOwner = "actor:00000000-0000-4000-8000-000000000111";
    await saveMemory({
      id: cognitionMemoryId,
      tenantId,
      title: "Reviewed source map",
      content: "Reviewed cognition derived from the document.",
      type: "knowledge",
      tier: "summary",
      formationReason: "source_cognition",
      formationOrigin: "reviewed_source_cognition",
      tags: ["reviewed"],
      scope: "user",
      source: "cognify-reviewed:cognition-review-direct-delete",
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: [
        `knowledge:${direct.document.id}`,
        "evidence:direct-delete",
        "cognition-review:cognition-review-direct-delete",
      ],
      accessBinding: buildUserPrivateMemoryAccessBindingV1({
        tenantId,
        ownerActorId: memoryOwner,
        originPurpose: "knowledge.cognition.review.confirm",
      }),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cognition-purge-memory",
        purpose: "memory.correct.v1",
      }),
    });
    const entityBinding = buildEntityAccessBinding({
      tenantId,
      ownerActorId: memoryOwner,
      visibility: "user_private",
      sensitivity: "confidential",
      allowedPurposeIds: ENTITY_PURPOSE_IDS,
      boundAt: ASAEL_ONTOLOGY_EFFECTIVE_AT,
    });
    await saveEntityRecord({
      entity: buildEntityRecord({
        entityId: "entity-reviewed-source-map",
        entityTypeId: "product",
        canonicalLabel: "Reviewed source map",
        accessBinding: entityBinding,
        lineage: [{
          kind: "memory",
          referenceId: cognitionMemoryId,
          referenceSha256: sourceContractSha256(cognitionMemoryId),
        }],
        createdAt: "2026-09-10T12:00:00.000Z",
      }),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cognition-purge-entity",
        purpose: "entity.write.v1",
      }),
    });
    await deleteKnowledgeDocumentByIdempotencyKey("direct-delete", {
      tenantId,
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cognition-purge-delete",
        purpose: "knowledge.delete_source",
      }),
    });
    expect(mocks.purge).toHaveBeenCalledWith({
      tenantId,
      documentIds: [direct.document.id],
    });
    const memories = await readJsonFile<MemoryRecord[]>(
      getDataPath("memory.json"),
      [],
    );
    expect(memories.find((memory) => memory.id === cognitionMemoryId))
      .toMatchObject({
        claimStatus: "superseded",
        title: "[retired]",
        content: "",
        evidenceRefs: [],
      });
    await expect(readEntityRegistry({
      accessBinding: entityBinding,
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cognition-purge-entity-read",
        purpose: "entity.read.v1",
      }),
    })).resolves.toMatchObject({ entities: [] });

    const prefixed = await Promise.all(["a", "b"].map((suffix) =>
      createKnowledgeDocument({
        idempotencyKey: `prefix-${suffix}`,
        tenantId,
        title: `Prefix ${suffix}`,
        content: `Prefix deletion ${suffix}`,
        source: `connector:course:${suffix}`,
        chunks: [{ index: 0, content: `Prefix deletion ${suffix}` }],
      })
    ));
    const prefixMemoryId = "memory:cognition-review-prefix-delete";
    await saveMemory({
      id: prefixMemoryId,
      tenantId,
      title: "Reviewed course map",
      content: "Reviewed cognition derived from the course source.",
      type: "knowledge",
      tier: "summary",
      formationReason: "source_cognition",
      formationOrigin: "reviewed_source_cognition",
      tags: ["reviewed"],
      scope: "user",
      source: "cognify-reviewed:cognition-review-prefix-delete",
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: [
        `knowledge:${prefixed[0]!.document.id}`,
        "evidence:prefix-delete",
        "cognition-review:cognition-review-prefix-delete",
      ],
      accessBinding: buildUserPrivateMemoryAccessBindingV1({
        tenantId,
        ownerActorId: memoryOwner,
        originPurpose: "knowledge.cognition.review.confirm",
      }),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cognition-prefix-memory",
        purpose: "memory.correct.v1",
      }),
    });
    await saveEntityRecord({
      entity: buildEntityRecord({
        entityId: "entity-reviewed-course-map",
        entityTypeId: "product",
        canonicalLabel: "Reviewed course map",
        accessBinding: entityBinding,
        lineage: [{
          kind: "memory",
          referenceId: prefixMemoryId,
          referenceSha256: sourceContractSha256(prefixMemoryId),
        }],
        createdAt: "2026-09-10T12:05:00.000Z",
      }),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cognition-prefix-entity",
        purpose: "entity.write.v1",
      }),
    });
    const sourcePrefix = "connector:course:";
    await deleteKnowledgeDocumentsBySourcePrefix("connector:course:", {
      tenantId,
      actorId: memoryOwner,
      mutation: {
        idempotencyKey: "delete-course-source",
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: memoryOwner,
          executingPrincipalType: "user",
          executingPrincipalId: memoryOwner,
          correlationId: "cognition-prefix-delete",
          causationId: knowledgeDeletionTargetId(sourcePrefix),
          purpose: "knowledge.delete_source",
        }),
      },
    });
    expect(mocks.purge).toHaveBeenLastCalledWith({
      tenantId,
      documentIds: expect.arrayContaining(
        prefixed.map((item) => item.document.id),
      ),
    });
    const afterPrefixMemories = await readJsonFile<MemoryRecord[]>(
      getDataPath("memory.json"),
      [],
    );
    expect(afterPrefixMemories.find((memory) => memory.id === prefixMemoryId))
      .toMatchObject({ claimStatus: "superseded", content: "" });
    await expect(readEntityRegistry({
      accessBinding: entityBinding,
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cognition-prefix-entity-read",
        purpose: "entity.read.v1",
      }),
    })).resolves.toMatchObject({ entities: [] });
  });

  it("rejects cross-owner cognition before deleting the source or memory", async () => {
    const tenantId = "tenant-cognition-owner-guard";
    const sourceOwner = "actor:00000000-0000-4000-8000-000000000121";
    const memoryOwner = "actor:00000000-0000-4000-8000-000000000122";
    const document = await createKnowledgeDocument({
      idempotencyKey: "cross-owner-delete",
      tenantId,
      title: "Owner-bound source",
      content: "Owner-bound content",
      source: "upload:owner-bound",
      chunks: [{ index: 0, content: "Owner-bound content" }],
    });
    const memoryId = "memory:cross-owner-cognition";
    await saveMemory({
      id: memoryId,
      tenantId,
      title: "Other owner's cognition",
      content: "Must not be retired by the source owner.",
      type: "knowledge",
      tier: "summary",
      formationReason: "source_cognition",
      formationOrigin: "reviewed_source_cognition",
      tags: ["reviewed"],
      scope: "user",
      source: "cognify-reviewed:cross-owner",
      claimStatus: "active",
      assertedBy: "user",
      evidenceRefs: [
        `knowledge:${document.document.id}`,
        "evidence:cross-owner",
        "cognition-review:cross-owner",
      ],
      accessBinding: buildUserPrivateMemoryAccessBindingV1({
        tenantId,
        ownerActorId: memoryOwner,
        originPurpose: "knowledge.cognition.review.confirm",
      }),
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: memoryOwner,
        executingPrincipalType: "user",
        executingPrincipalId: memoryOwner,
        correlationId: "cross-owner-memory",
        purpose: "memory.correct.v1",
      }),
    });

    await expect(deleteKnowledgeDocumentByIdempotencyKey(
      "cross-owner-delete",
      { tenantId },
    )).rejects.toThrow("actor-bound execution scope");
    await expect(deleteKnowledgeDocumentByIdempotencyKey(
      "cross-owner-delete",
      {
        tenantId,
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: sourceOwner,
          executingPrincipalType: "user",
          executingPrincipalId: sourceOwner,
          correlationId: "cross-owner-delete",
          purpose: "knowledge.delete_source",
        }),
      },
    )).rejects.toThrow("cannot cross actor ownership");

    const memories = await readJsonFile<MemoryRecord[]>(
      getDataPath("memory.json"),
      [],
    );
    expect(memories.find((memory) => memory.id === memoryId)).toMatchObject({
      claimStatus: "active",
      title: "Other owner's cognition",
      evidenceRefs: expect.arrayContaining([`knowledge:${document.document.id}`]),
    });
    expect(mocks.purge).not.toHaveBeenCalled();
  });

  it("purges cognition for superseded Capture revisions but not the current one", async () => {
    const tenantId = "tenant-cognition-capture-purge";
    const actorId = "actor-cognition-capture-purge";
    const guard = {
      kind: "asset" as const,
      captureId: "asset-cognition-purge",
      tenantId,
      actorId,
      ingestJobId: "capture-current-job",
    };
    const source = `capture:asset:${guard.captureId}`;
    const makeWrite = (content: string, revisionId: string, capturedAt: string) =>
      buildCanonicalTextSourceWrite({
        lineage: {
          executionScope: createExecutionScope({
            tenantId,
            initiatingActorId: actorId,
            executingPrincipalType: "system",
            executingPrincipalId: "background-operations-worker",
            correlationId: revisionId,
            purpose: "capture.ingest.source.index",
          }),
          connectionId: "first_party.capture",
          adapterId: "asael.capture",
          externalItemId: `asset:${guard.captureId}`,
          providerRevisionId: revisionId,
          sourceKind: "file",
          capturedAt,
        },
        content,
        normalizedContent: normalizeTextForChunking(content),
        chunks: [{
          index: 0,
          content,
          characterStart: 0,
          characterEnd: content.length,
        }],
      });
    const old = await createKnowledgeDocument({
      idempotencyKey: "capture-old-job",
      tenantId,
      title: "Old Capture",
      content: "Old Capture content",
      source,
      canonicalSourceWrite: makeWrite(
        "Old Capture content",
        "capture-old-job",
        "2026-09-09T08:00:00.000Z",
      ),
      chunks: [{ index: 0, content: "Old Capture content" }],
    });
    const current = await createKnowledgeDocument({
      idempotencyKey: guard.ingestJobId,
      tenantId,
      title: "Current Capture",
      content: "Current Capture content",
      source,
      canonicalSourceWrite: makeWrite(
        "Current Capture content",
        guard.ingestJobId,
        "2026-09-10T08:00:00.000Z",
      ),
      chunks: [{ index: 0, content: "Current Capture content" }],
    });

    await retireSupersededCaptureKnowledge({
      captureIngestGuard: guard,
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: "background-operations-worker",
        correlationId: guard.ingestJobId,
        purpose: "capture.ingest.source.index",
      }),
      keepDocumentId: current.document.id,
    });

    expect(mocks.purge).toHaveBeenCalledWith({
      tenantId,
      documentIds: [old.document.id],
    });
    expect(mocks.purge).not.toHaveBeenCalledWith({
      tenantId,
      documentIds: [current.document.id],
    });
  });
});
