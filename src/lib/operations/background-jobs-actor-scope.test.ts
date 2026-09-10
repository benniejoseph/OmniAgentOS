import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const ingestMocks = vi.hoisted(() => ({
  actorContexts: [] as string[][],
  ingestTextDocument: vi.fn(),
}));

vi.mock("@/lib/rag/retriever", () => ({
  ingestTextDocument: ingestMocks.ingestTextDocument,
}));

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-background-actor-scope-"),
  );
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

beforeEach(() => {
  ingestMocks.actorContexts.length = 0;
  ingestMocks.ingestTextDocument.mockReset().mockImplementation(async () => {
    const { getDatabaseActorContext } = await import("@/lib/db/client");
    ingestMocks.actorContexts.push(getDatabaseActorContext());
    return {
      document: { id: "knowledge-document" },
      chunks: [],
      memories: [],
    };
  });
});

describe("background knowledge ingestion actor scope", () => {
  it("defers capture graph projection through the durable rebuild queue", async () => {
    const assets = await import("@/lib/capture/assets");
    const jobs = await import("@/lib/operations/background-jobs");
    const { createExecutionScope } = await import(
      "@/lib/security/execution-scope"
    );
    const tenantId = "tenant-capture-deferred-graph";
    const actorId = "actor-capture-deferred-graph";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "capture-deferred-graph-test",
      purpose: "capture.asset.ingest.test",
    });
    const stored = await assets.saveCaptureAsset({
      tenantId,
      actorId,
      executionScope,
      filename: "ict-batch.vtt",
      mediaType: "text/vtt",
      bytes: Buffer.from(
        "WEBVTT\n\n00:00.000 --> 00:02.000\nLiquidity rests above old highs.\n",
      ),
      tags: ["ict"],
    });
    const queued = await jobs.enqueueCaptureAssetProcessJob({
      tenantId,
      actorId,
      executionScope,
      idempotencyKey: "capture-deferred-graph-request",
      request: { assetId: stored.id },
    });
    await assets.updateCaptureAssetStatus(stored.id, {
      tenantId,
      actorId,
      executionScope,
    }, {
      status: "queued",
      extractionStatus: "pending",
      ingestJobId: queued.id,
      clearExtractionReceipt: true,
    });

    await expect(jobs.processBackgroundOperationQueue({
      tenantId,
      limit: 1,
    })).resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });

    expect(ingestMocks.ingestTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        deferMemoryGraphIndex: true,
        captureIngestGuard: expect.objectContaining({
          kind: "asset",
          captureId: stored.id,
          ingestJobId: queued.id,
        }),
      }),
    );
  });

  it("re-enters the stored actor scope for the entire knowledge ingest", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    const { createExecutionScope } = await import(
      "@/lib/security/execution-scope"
    );
    const tenantId = "tenant-actor-bound-ingest";
    const actorId = "actor-bound-ingest-owner";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "actor-bound-ingest-test",
      purpose: "knowledge.ingest.test",
    });
    await jobs.enqueueKnowledgeIngestJob({
      tenantId,
      actorId,
      executionScope,
      request: {
        title: "Actor-bound knowledge",
        content: "Canonical source projection must retain its owner scope.",
        sourceType: "manual",
      },
    });

    await expect(jobs.processBackgroundOperationQueue({
      tenantId,
      limit: 1,
    })).resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });

    expect(ingestMocks.actorContexts).toEqual([[actorId]]);
  });

  it("preserves tenant-only execution for actorless system ingestion", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    const tenantId = "tenant-actorless-ingest";
    await jobs.enqueueKnowledgeIngestJob({
      tenantId,
      request: {
        title: "System knowledge",
        content: "Actorless ingestion remains tenant-scoped.",
        sourceType: "api",
      },
    });

    await expect(jobs.processBackgroundOperationQueue({
      tenantId,
      limit: 1,
    })).resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });

    expect(ingestMocks.actorContexts).toEqual([[]]);
  });
});
