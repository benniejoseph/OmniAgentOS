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
      retired: { documents: 0, memories: 0 },
    };
  });
});

describe("background knowledge ingestion actor scope", () => {
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
