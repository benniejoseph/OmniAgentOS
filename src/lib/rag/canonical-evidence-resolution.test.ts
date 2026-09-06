import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chunkText, normalizeTextForChunking } from "@/lib/rag/chunk";
import {
  createKnowledgeDocument,
  getCanonicalKnowledgeEvidenceByChunkIds,
} from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

describe("canonical knowledge evidence resolution", () => {
  let dataDirectory = "";
  let previousDataDirectory: string | undefined;
  let previousDatabaseUrl: string | undefined;

  beforeEach(async () => {
    previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
    previousDatabaseUrl = process.env.DATABASE_URL;
    dataDirectory = await mkdtemp(path.join(tmpdir(), "asael-claim-evidence-"));
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

  it("returns only an exact tenant-scoped chunk and immutable evidence binding", async () => {
    const content = "The launch date is 12 October 2026.";
    const chunks = chunkText(content);
    const canonicalSourceWrite = buildCanonicalTextSourceWrite({
      lineage: {
        executionScope: createExecutionScope({
          tenantId: "tenant-evidence-a",
          initiatingActorId: "actor-evidence-a",
          executingPrincipalType: "user",
          executingPrincipalId: "actor-evidence-a",
          correlationId: "ingest-evidence-a",
          purpose: "knowledge.ingest",
        }),
        connectionId: "first-party-knowledge",
        adapterId: "asael.knowledge",
        externalItemId: "launch-plan",
        sourceKind: "document",
        capturedAt: "2026-09-06T00:00:00.000Z",
      },
      content,
      normalizedContent: normalizeTextForChunking(content),
      chunks,
    });
    const created = await createKnowledgeDocument({
      tenantId: "tenant-evidence-a",
      title: "Launch plan",
      content,
      chunks,
      canonicalSourceWrite,
    });
    const chunkId = created.chunks[0].id;

    const resolved = await getCanonicalKnowledgeEvidenceByChunkIds(
      [chunkId, "missing"],
      { tenantId: "tenant-evidence-a" },
    );
    expect(resolved).toHaveLength(1);
    expect(resolved[0].chunk.id).toBe(chunkId);
    expect(resolved[0].evidenceUnit.evidenceUnitId).toBe(
      created.chunks[0].evidenceUnitId,
    );
    expect(resolved[0].sourceState).toMatchObject({
      currentRevisionId: created.chunks[0].sourceRevisionId,
      operation: "upsert",
      isCurrent: true,
    });
    await expect(
      getCanonicalKnowledgeEvidenceByChunkIds([chunkId], {
        tenantId: "tenant-evidence-b",
      }),
    ).resolves.toEqual([]);

    const ledgerPath = path.join(dataDirectory, "knowledge.json");
    const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
    ledger.chunks[0].content = "tampered";
    await writeFile(ledgerPath, JSON.stringify(ledger), "utf8");
    await expect(
      getCanonicalKnowledgeEvidenceByChunkIds([chunkId], {
        tenantId: "tenant-evidence-a",
      }),
    ).rejects.toThrow("does not match");
  });
});
