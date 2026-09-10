import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText, normalizeTextForChunking } from "@/lib/rag/chunk";
import {
  createKnowledgeDocument,
  getActorOwnedKnowledgeForCognition,
  listActorOwnedKnowledgeDocumentsForCognition,
} from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { CONTEXT_COMPILER_V2_PURPOSE_ID } from "@/lib/sources/purposes";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

const TENANT_ID = "tenant-cognition-eligibility";
const ACTOR_ID = "actor-cognition-eligibility";
const CAPTURED_AT = "2026-09-06T00:00:00.000Z";

describe("actor-owned cognition source eligibility", () => {
  let dataDirectory = "";
  let previousDataDirectory: string | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeEach(async () => {
    previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
    previousDatabaseUrl = process.env.DATABASE_URL;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-cognition-source-"));
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

  it("returns only a complete current private evidence set for its exact actor", async () => {
    const created = await ingestCanonicalDocument({
      externalItemId: "course-transcript",
      providerRevisionId: "revision-1",
      sourceUpdatedAt: "2026-09-06T00:00:00.000Z",
      content: "A displacement becomes useful when liquidity has been swept.",
      retentionExpiresAt: "2026-10-10T00:00:00.000Z",
    });

    await expect(getActorOwnedKnowledgeForCognition({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      documentId: created.document.id,
    })).resolves.toMatchObject({
      document: { id: created.document.id },
      sourceItemId: created.document.sourceItemId,
      sourceRevisionId: created.document.sourceRevisionId,
      retentionExpiresAt: "2026-10-10T00:00:00.000Z",
    });
    await expect(listActorOwnedKnowledgeDocumentsForCognition({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
    })).resolves.toEqual([
      expect.objectContaining({ id: created.document.id }),
    ]);
    await expect(getActorOwnedKnowledgeForCognition({
      tenantId: TENANT_ID,
      actorId: "actor-someone-else",
      documentId: created.document.id,
    })).resolves.toBeNull();
  });

  it("fails closed for superseded revisions and tampered chunk evidence", async () => {
    const oldRevision = await ingestCanonicalDocument({
      externalItemId: "versioned-transcript",
      providerRevisionId: "revision-1",
      sourceUpdatedAt: "2026-09-06T00:00:00.000Z",
      content: "The older transcript says to enter before confirmation.",
    });
    const currentRevision = await ingestCanonicalDocument({
      externalItemId: "versioned-transcript",
      providerRevisionId: "revision-2",
      sourceUpdatedAt: "2026-09-07T00:00:00.000Z",
      content: "The corrected transcript requires confirmation before entry.",
    });

    await expect(getActorOwnedKnowledgeForCognition({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      documentId: oldRevision.document.id,
    })).resolves.toBeNull();
    await expect(listActorOwnedKnowledgeDocumentsForCognition({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
    })).resolves.toEqual([
      expect.objectContaining({ id: currentRevision.document.id }),
    ]);

    const ledgerPath = path.join(dataDirectory, "knowledge.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    const currentChunk = ledger.chunks.find(
      (chunk: { documentId: string }) =>
        chunk.documentId === currentRevision.document.id,
    );
    currentChunk.content = "tampered after canonical evidence was recorded";
    await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");

    await expect(getActorOwnedKnowledgeForCognition({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
      documentId: currentRevision.document.id,
    })).resolves.toBeNull();
    await expect(listActorOwnedKnowledgeDocumentsForCognition({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
    })).resolves.toEqual([]);
  });

  it("rejects expired, non-private, and purpose-incompatible lineages", async () => {
    const expired = await ingestCanonicalDocument({
      externalItemId: "expired-transcript",
      content: "This transcript has passed its retention boundary.",
      retentionExpiresAt: "2026-09-09T00:00:00.000Z",
    });
    const nonPrivate = await ingestCanonicalDocument({
      externalItemId: "agent-private-transcript",
      content: "This source is private to an agent rather than the user.",
      visibility: "agent_private",
    });
    const wrongPurpose = await ingestCanonicalDocument({
      externalItemId: "retrieval-only-transcript",
      content: "This source permits retrieval but not cognition.",
      allowedPurposeIds: [CONTEXT_COMPILER_V2_PURPOSE_ID],
    });

    for (const documentId of [
      expired.document.id,
      nonPrivate.document.id,
      wrongPurpose.document.id,
    ]) {
      await expect(getActorOwnedKnowledgeForCognition({
        tenantId: TENANT_ID,
        actorId: ACTOR_ID,
        documentId,
      })).resolves.toBeNull();
    }
    await expect(listActorOwnedKnowledgeDocumentsForCognition({
      tenantId: TENANT_ID,
      actorId: ACTOR_ID,
    })).resolves.toEqual([]);
  });
});

async function ingestCanonicalDocument(input: {
  externalItemId: string;
  content: string;
  providerRevisionId?: string;
  sourceUpdatedAt?: string;
  retentionExpiresAt?: string | null;
  visibility?: "user_private" | "agent_private";
  allowedPurposeIds?: readonly string[];
}) {
  const chunks = chunkText(input.content);
  const canonicalSourceWrite = buildCanonicalTextSourceWrite({
    lineage: {
      executionScope: createExecutionScope({
        tenantId: TENANT_ID,
        initiatingActorId: ACTOR_ID,
        executingPrincipalType: "user",
        executingPrincipalId: ACTOR_ID,
        correlationId: `ingest-${input.externalItemId}-${input.providerRevisionId || "v1"}`,
        purpose: "knowledge.ingest",
      }),
      connectionId: "first-party-knowledge",
      adapterId: "asael.knowledge",
      externalItemId: input.externalItemId,
      providerRevisionId: input.providerRevisionId,
      sourceKind: "document",
      capturedAt: CAPTURED_AT,
      sourceUpdatedAt: input.sourceUpdatedAt,
      retentionExpiresAt: input.retentionExpiresAt,
      visibility: input.visibility,
      allowedPurposeIds: input.allowedPurposeIds,
    },
    content: input.content,
    normalizedContent: normalizeTextForChunking(input.content),
    chunks,
  });
  return createKnowledgeDocument({
    idempotencyKey: `${input.externalItemId}:${input.providerRevisionId || "v1"}`,
    tenantId: TENANT_ID,
    title: input.externalItemId,
    content: input.content,
    chunks,
    canonicalSourceWrite,
  });
}
