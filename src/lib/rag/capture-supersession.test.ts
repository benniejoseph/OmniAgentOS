import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import type { CaptureIngestGuard } from "@/lib/capture/ingest-guard";
import { listMemories, saveMemories } from "@/lib/memory/store";
import { normalizeTextForChunking } from "@/lib/rag/chunk";
import {
  createKnowledgeDocument,
  listKnowledgeDocuments,
  retireSupersededCaptureKnowledge,
} from "@/lib/rag/store";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { buildCanonicalTextSourceWrite } from "@/lib/sources/text-lineage";

describe("Capture knowledge supersession", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(os.tmpdir(), "omni-capture-supersession-"),
    );
  });

  it("keeps the current document and retires older source generations", async () => {
    const guard: CaptureIngestGuard = {
      kind: "asset",
      captureId: "asset-a",
      tenantId: "tenant-a",
      actorId: "owner-a",
      ingestJobId: "job-current",
    };
    const source = "capture:asset:asset-a";
    const canonicalWrite = (input: {
      actorId: string;
      externalItemId: string;
      providerRevisionId: string;
      content: string;
      capturedAt: string;
    }) => buildCanonicalTextSourceWrite({
      lineage: {
        executionScope: createExecutionScope({
          tenantId: guard.tenantId,
          initiatingActorId: input.actorId,
          executingPrincipalType: "system",
          executingPrincipalId: "background-operations-worker",
          correlationId: input.providerRevisionId,
          purpose: "capture.ingest.source.index",
        }),
        connectionId: "first_party.capture",
        adapterId: "asael.capture",
        adapterVersionId: "1",
        externalItemId: input.externalItemId,
        providerRevisionId: input.providerRevisionId,
        sourceKind: "file",
        capturedAt: input.capturedAt,
      },
      content: input.content,
      normalizedContent: normalizeTextForChunking(input.content),
      chunks: [{
        index: 0,
        content: input.content,
        characterStart: 0,
        characterEnd: input.content.length,
      }],
    });
    const oldContent = "Old content";
    const old = await createKnowledgeDocument({
      idempotencyKey: "job-old",
      tenantId: guard.tenantId,
      title: "Old transcript",
      content: oldContent,
      source,
      canonicalSourceWrite: canonicalWrite({
        actorId: guard.actorId,
        externalItemId: `asset:${guard.captureId}`,
        providerRevisionId: "job-old",
        content: oldContent,
        capturedAt: "2026-09-10T09:00:00.000Z",
      }),
      chunks: [{ index: 0, content: oldContent }],
    });
    const currentContent = "Current content";
    const current = await createKnowledgeDocument({
      idempotencyKey: guard.ingestJobId,
      tenantId: guard.tenantId,
      title: "Current transcript",
      content: currentContent,
      source,
      canonicalSourceWrite: canonicalWrite({
        actorId: guard.actorId,
        externalItemId: `asset:${guard.captureId}`,
        providerRevisionId: guard.ingestJobId,
        content: currentContent,
        capturedAt: "2026-09-10T10:00:00.000Z",
      }),
      chunks: [{ index: 0, content: currentContent }],
    });
    const siblingContent = "Sibling content";
    const sibling = await createKnowledgeDocument({
      idempotencyKey: "job-sibling",
      tenantId: guard.tenantId,
      title: "Sibling transcript",
      content: siblingContent,
      source,
      canonicalSourceWrite: canonicalWrite({
        actorId: "owner-b",
        externalItemId: "asset:asset-b",
        providerRevisionId: "job-sibling",
        content: siblingContent,
        capturedAt: "2026-09-10T11:00:00.000Z",
      }),
      chunks: [{ index: 0, content: siblingContent }],
    });
    await saveMemories([
      {
        id: `${old.document.id}_memory_0`,
        tenantId: guard.tenantId,
        type: "knowledge",
        title: "Old transcript",
        content: "Old content",
        source,
        evidenceRefs: [`knowledge:${old.document.id}`],
      },
      {
        id: `${current.document.id}_memory_0`,
        tenantId: guard.tenantId,
        type: "knowledge",
        title: "Current transcript",
        content: "Current content",
        source,
        evidenceRefs: [`knowledge:${current.document.id}`],
      },
      {
        id: `${sibling.document.id}_memory_0`,
        tenantId: guard.tenantId,
        type: "knowledge",
        title: "Sibling transcript",
        content: siblingContent,
        source,
        evidenceRefs: [`knowledge:${sibling.document.id}`],
      },
    ]);

    const retirementScope = createExecutionScope({
      tenantId: guard.tenantId,
      initiatingActorId: guard.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      correlationId: guard.ingestJobId,
      purpose: "capture.ingest.source.index",
    });
    await expect(retireSupersededCaptureKnowledge({
      captureIngestGuard: guard,
      executionScope: retirementScope,
      keepDocumentId: old.document.id,
    })).rejects.toThrow(/canonical source revision/i);

    await expect(retireSupersededCaptureKnowledge({
      captureIngestGuard: guard,
      executionScope: retirementScope,
      keepDocumentId: current.document.id,
    })).resolves.toEqual({ documents: 1, memories: 1 });

    const documents = await listKnowledgeDocuments(10, {
      tenantId: guard.tenantId,
    });
    expect(documents.map((document) => document.id).sort()).toEqual([
      current.document.id,
      sibling.document.id,
    ].sort());
    const memories = await listMemories({
      tenantId: guard.tenantId,
      includeInactive: true,
    });
    expect(memories).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: current.document.id + "_memory_0",
        claimStatus: "active",
      }),
      expect.objectContaining({
        id: old.document.id + "_memory_0",
        claimStatus: "superseded",
        content: "",
      }),
      expect.objectContaining({
        id: sibling.document.id + "_memory_0",
        claimStatus: "active",
      }),
    ]));

    await expect(retireSupersededCaptureKnowledge({
      captureIngestGuard: guard,
      executionScope: retirementScope,
      keepDocumentId: current.document.id,
    })).resolves.toEqual({ documents: 0, memories: 0 });
  });
});
