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
    const memoryOwner = "actor-cognition-purge";
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
    await deleteKnowledgeDocumentByIdempotencyKey("direct-delete", { tenantId });
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
    await deleteKnowledgeDocumentsBySourcePrefix("connector:course:", {
      tenantId,
    });
    expect(mocks.purge).toHaveBeenLastCalledWith({
      tenantId,
      documentIds: expect.arrayContaining(
        prefixed.map((item) => item.document.id),
      ),
    });
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
