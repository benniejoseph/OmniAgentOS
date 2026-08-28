import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-background-jobs-"),
  );
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

describe("background operation jobs", () => {
  it("queues ingestion idempotently and exposes progress without request content", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    const queue = await import("@/lib/operations/job-queue");
    const request = {
      title: "Release policy",
      content: "Use staged releases with explicit rollback criteria.",
      sourceType: "manual" as const,
      tags: ["release"],
    };

    const first = await jobs.enqueueKnowledgeIngestJob({
      tenantId: "tenant-ingest",
      idempotencyKey: "ingest-request-1",
      request,
    });
    const second = await jobs.enqueueKnowledgeIngestJob({
      tenantId: "tenant-ingest",
      idempotencyKey: "ingest-request-1",
      request,
    });

    expect(second.id).toBe(first.id);
    expect(queue.projectOperationJobStatus(first)).not.toHaveProperty(
      "request",
    );
    expect(JSON.stringify(queue.projectOperationJobStatus(first))).not.toContain(
      request.content,
    );

    await expect(
      jobs.processBackgroundOperationQueue({
        tenantId: "tenant-ingest",
        limit: 1,
      }),
    ).resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });

    const completed = await queue.getOperationJob(first.id, {
      tenantId: "tenant-ingest",
    });
    expect(queue.projectOperationJobStatus(completed!)).toMatchObject({
      status: "completed",
      result: {
        chunkCount: 1,
        memoryCount: 1,
      },
    });
    expect(completed?.payload.request).toBeUndefined();
  });

  it("rejects an idempotency key reused for different ingestion content", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    await jobs.enqueueKnowledgeIngestJob({
      tenantId: "tenant-ingest-conflict",
      idempotencyKey: "same-request",
      request: {
        title: "First",
        content: "First ingestion request.",
      },
    });

    await expect(
      jobs.enqueueKnowledgeIngestJob({
        tenantId: "tenant-ingest-conflict",
        idempotencyKey: "same-request",
        request: {
          title: "Second",
          content: "A different ingestion request.",
        },
      }),
    ).rejects.toThrow("idempotency key is already bound");
  });

  it("processes runnable background work for each discovered tenant", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    const queue = await import("@/lib/operations/job-queue");
    const first = await jobs.enqueueKnowledgeIngestJob({
      tenantId: "tenant-background-a",
      request: {
        title: "Tenant A document",
        content: "Tenant A background queue content.",
      },
    });
    const second = await jobs.enqueueKnowledgeIngestJob({
      tenantId: "tenant-background-b",
      request: {
        title: "Tenant B document",
        content: "Tenant B background queue content.",
      },
    });

    await expect(
      jobs.processAllTenantBackgroundOperationQueues({ limit: 2 }),
    ).resolves.toMatchObject({ leased: 2, completed: 2, failed: 0 });
    await expect(
      queue.getOperationJob(first.id, { tenantId: "tenant-background-a" }),
    ).resolves.toMatchObject({ status: "completed" });
    await expect(
      queue.getOperationJob(second.id, { tenantId: "tenant-background-b" }),
    ).resolves.toMatchObject({ status: "completed" });
  });

  it("queues memory consolidation without storing conversation content", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    await expect(
      jobs.enqueueMemoryConsolidationJob({
        tenantId: "tenant-memory",
        runId: "short-run",
        mode: "orchestrate",
        prompt: "hello",
        response: "short",
      }),
    ).resolves.toMatchObject({
      type: "memory.consolidate",
      status: "queued",
      dedupeKey: "memory.consolidate:short-run",
    });

    const queued = await jobs.enqueueMemoryConsolidationJob({
        tenantId: "tenant-memory",
        runId: "durable-run",
        mode: "research",
        prompt: "Document the durable release process",
        response: "A".repeat(300),
      });
    expect(queued).toMatchObject({
      type: "memory.consolidate",
      status: "queued",
      dedupeKey: "memory.consolidate:durable-run",
    });
    expect(JSON.stringify(queued?.payload)).not.toContain("durable release");
    expect(JSON.stringify(queued?.payload)).not.toContain("AAAA");
  });

  it("reports retryable background failures as deferred work", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    const queue = await import("@/lib/operations/job-queue");
    const queued = await jobs.enqueueMemoryConsolidationJob({
      tenantId: "tenant-memory-retry",
      runId: "missing-run",
      mode: "research",
      prompt: "Document the durable retry behavior",
      response: "A".repeat(300),
    });

    await expect(
      jobs.processBackgroundOperationQueue({
        tenantId: "tenant-memory-retry",
        limit: 1,
      }),
    ).resolves.toMatchObject({
      leased: 1,
      completed: 0,
      failed: 0,
      deferred: 1,
    });
    await expect(
      queue.getOperationJob(queued!.id, {
        tenantId: "tenant-memory-retry",
      }),
    ).resolves.toMatchObject({ status: "queued", attempt: 1 });
  });

  it("deduplicates evaluation retries but permits explicit reruns", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    const request = {
      suite: "operator-check",
      caseIds: ["system.readiness"],
    };
    const first = await jobs.enqueueEvaluationJob({
      tenantId: "tenant-evaluation",
      request,
      idempotencyKey: "request-1",
    });
    const retry = await jobs.enqueueEvaluationJob({
      tenantId: "tenant-evaluation",
      request,
      idempotencyKey: "request-1",
    });
    const rerun = await jobs.enqueueEvaluationJob({
      tenantId: "tenant-evaluation",
      request,
      idempotencyKey: "request-2",
    });

    expect(retry.id).toBe(first.id);
    expect(rerun.id).not.toBe(first.id);
  });
});
