import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-background-jobs-"),
  );
  delete process.env.DATABASE_URL;
  delete process.env.OPENAI_API_KEY;
});

describe("background operation jobs", () => {
  it("processes a stored transcript into cited knowledge and a cognition plan", async () => {
    const assets = await import("@/lib/capture/assets");
    const jobs = await import("@/lib/operations/background-jobs");
    const queue = await import("@/lib/operations/job-queue");
    const { createExecutionScope } = await import("@/lib/security/execution-scope");
    const tenantId = "tenant-capture-asset-process";
    const actorId = "owner-capture-asset-process";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "capture-asset-process-test",
      purpose: "capture.asset.ingest.test",
    });
    const stored = await assets.saveCaptureAsset({
      tenantId,
      actorId,
      executionScope,
      filename: "ict-liquidity.vtt",
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
      idempotencyKey: "capture-asset-process-request",
      request: {
        assetId: stored.id,
        title: "ICT liquidity lesson",
        tags: ["liquidity"],
      },
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

    expect(queue.projectOperationJobStatus(queued)).not.toHaveProperty("request");
    await expect(jobs.processBackgroundOperationQueue({
      tenantId,
      limit: 1,
    })).resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });

    const completed = await queue.getOperationJob(queued.id, { tenantId });
    expect(queue.projectOperationJobStatus(completed!)).toMatchObject({
      type: "capture.asset.process",
      status: "completed",
      progress: { stage: "completed" },
      result: { chunkCount: 1, memoryCount: 0 },
    });
    expect(completed?.payload.request).toBeUndefined();
    await expect(assets.getCaptureAsset(stored.id, {
      tenantId,
      actorId,
    })).resolves.toMatchObject({
      status: "indexed",
      extractionStatus: "completed",
      ingestJobId: queued.id,
      knowledgeDocumentId: expect.any(String),
      extractionReceipt: {
        state: "completed",
        sourceKind: "video",
        unitCount: 1,
      },
    });
  });

  it("requeues an ingest when its active asset completion projection fails", async () => {
    const assets = await import("@/lib/capture/assets");
    const jobs = await import("@/lib/operations/background-jobs");
    const queue = await import("@/lib/operations/job-queue");
    const { createExecutionScope } = await import("@/lib/security/execution-scope");
    const tenantId = "tenant-capture-projection-retry";
    const actorId = "owner-capture-projection-retry";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "capture-projection-retry-test",
      purpose: "capture.asset.ingest.test",
    });
    const stored = await assets.saveCaptureAsset({
      tenantId,
      actorId,
      executionScope,
      filename: "projection-retry.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("A private transcript must never appear in diagnostics."),
    });
    const queued = await jobs.enqueueCaptureAssetProcessJob({
      tenantId,
      actorId,
      executionScope,
      idempotencyKey: "capture-projection-retry-request",
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
    const updateCaptureAssetStatus = assets.updateCaptureAssetStatus;
    const updateSpy = vi.spyOn(assets, "updateCaptureAssetStatus")
      .mockImplementation(async (id, owner, input) => {
        if (input.status === "indexed") {
          throw new Error("A private transcript must never appear in diagnostics.");
        }
        return updateCaptureAssetStatus(id, owner, input);
      });

    try {
      await expect(jobs.processBackgroundOperationQueue({
        tenantId,
        limit: 1,
      })).resolves.toMatchObject({
        leased: 1,
        completed: 0,
        failed: 0,
        deferred: 1,
      });
    } finally {
      updateSpy.mockRestore();
    }

    const deferred = await queue.getOperationJob(queued.id, { tenantId });
    expect(deferred).toMatchObject({
      status: "queued",
      attempt: 1,
      lastError: "Capture asset completion projection could not be finalized.",
    });
    expect(deferred?.lastError).not.toContain("private transcript");
    await expect(assets.getCaptureAsset(stored.id, {
      tenantId,
      actorId,
    })).resolves.toMatchObject({
      status: "queued",
      ingestJobId: queued.id,
    });
  });

  it("accepts exact structured units and rejects units that do not compose the content", async () => {
    const { finalizeCaptureExtraction, renderCaptureExtractionUnits } = await import("@/lib/capture/extraction");
    const { knowledgeIngestJobRequestSchema } = await import("@/lib/operations/background-jobs");
    const extraction = finalizeCaptureExtraction({
      sourceKind: "presentation",
      format: "pptx",
      units: [{
        label: "Slide 1",
        content: "Quarterly result",
        locator: {
          kind: "slide",
          slideNumber: 1,
          slideCount: 1,
          elementKeySha256: null,
        },
      }],
    });
    const content = renderCaptureExtractionUnits(extraction.units);

    expect(knowledgeIngestJobRequestSchema.parse({
      title: "Review",
      content,
      structuredUnits: extraction.units,
    }).structuredUnits).toHaveLength(1);
    expect(() => knowledgeIngestJobRequestSchema.parse({
      title: "Review",
      content: "Different content",
      structuredUnits: extraction.units,
    })).toThrow(/exactly compose/i);
  });

  it("suppresses a final asset projection failure only after confirming it is resolved", async () => {
    const { assertCaptureAssetCompletionProjectionFailureIsResolved } = await import(
      "@/lib/operations/background-jobs"
    );

    expect(() =>
      assertCaptureAssetCompletionProjectionFailureIsResolved(
        null,
        "job-a",
        "knowledge-a",
      )
    ).not.toThrow();
    expect(() =>
      assertCaptureAssetCompletionProjectionFailureIsResolved(
        { ingestJobId: "job-new" },
        "job-a",
        "knowledge-a",
      )
    ).not.toThrow();
    expect(() =>
      assertCaptureAssetCompletionProjectionFailureIsResolved(
        {
          status: "indexed",
          ingestJobId: "job-a",
          knowledgeDocumentId: "knowledge-a",
        },
        "job-a",
        "knowledge-a",
      )
    ).not.toThrow();

    let failure: unknown;
    try {
      assertCaptureAssetCompletionProjectionFailureIsResolved(
        {
          status: "queued",
          ingestJobId: "job-a",
          knowledgeDocumentId: "knowledge-a",
        },
        "job-a",
        "knowledge-a",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Capture asset completion projection could not be finalized.",
    );
    expect((failure as Error).message).not.toContain("transcript");
  });

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

  it("queues source cognition by exact owner, revision, and batch", async () => {
    const jobs = await import("@/lib/operations/background-jobs");
    const { createExecutionScope } = await import(
      "@/lib/security/execution-scope"
    );
    const tenantId = "tenant-cognition-queue";
    const actorId = "owner-cognition-queue";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "cognition-queue-test",
      purpose: "knowledge.cognition.request",
    });
    const request = {
      documentId: "knowledge-cognition-document",
      sourceRevisionId: "source-cognition-revision",
      retentionExpiresAt: "2026-10-10T00:00:00.000Z",
      sourcePlanSha256: "a".repeat(64),
      batchIndex: 0,
    };

    const first = await jobs.enqueueKnowledgeCognifyJob({
      tenantId,
      actorId,
      executionScope,
      request,
    });
    const repeated = await jobs.enqueueKnowledgeCognifyJob({
      tenantId,
      actorId,
      executionScope,
      request,
    });

    expect(repeated.id).toBe(first.id);
    expect(first).toMatchObject({
      type: "knowledge.cognify",
      status: "queued",
      payload: {
        actorId,
        request,
        executionScope: {
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "system",
          purpose: "agent.knowledge.cognify.v1",
        },
      },
    });
  });

  it("resumes a persisted cognition batch without invoking the model again", async () => {
    const assets = await import("@/lib/capture/assets");
    const jobs = await import("@/lib/operations/background-jobs");
    const queue = await import("@/lib/operations/job-queue");
    const rag = await import("@/lib/rag/store");
    const runtime = await import("@/lib/knowledge/cognification-runtime");
    const contract = await import("@/lib/knowledge/cognification-contract");
    const cognitionStore = await import("@/lib/knowledge/cognification-store");
    const { createExecutionScope, parsePersistedExecutionScope } = await import(
      "@/lib/security/execution-scope"
    );
    const { contentSha256Hex } = await import("@/lib/sources/text-lineage");
    const tenantId = "tenant-cognition-resume";
    const actorId = "owner-cognition-resume";
    const userScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "cognition-resume-capture",
      purpose: "capture.asset.ingest.test",
    });
    const stored = await assets.saveCaptureAsset({
      tenantId,
      actorId,
      executionScope: userScope,
      filename: "cognition-resume.txt",
      mediaType: "text/plain",
      bytes: Buffer.from("Liquidity rests above old highs."),
    });
    const assetJob = await jobs.enqueueCaptureAssetProcessJob({
      tenantId,
      actorId,
      executionScope: userScope,
      idempotencyKey: "cognition-resume-asset",
      request: { assetId: stored.id, title: "Liquidity lesson" },
    });
    await assets.updateCaptureAssetStatus(stored.id, {
      tenantId,
      actorId,
      executionScope: userScope,
    }, {
      status: "queued",
      extractionStatus: "pending",
      ingestJobId: assetJob.id,
      clearExtractionReceipt: true,
    });
    await expect(jobs.processBackgroundOperationQueue({ tenantId, limit: 1 }))
      .resolves.toMatchObject({ completed: 1, failed: 0 });

    const completedAsset = await assets.getCaptureAsset(stored.id, {
      tenantId,
      actorId,
    });
    const source = await rag.getActorOwnedKnowledgeForCognition({
      tenantId,
      actorId,
      documentId: completedAsset!.knowledgeDocumentId!,
    });
    expect(source).not.toBeNull();
    const document = {
      id: source!.document.id,
      title: source!.document.title,
      sourceItemId: source!.sourceItemId,
      sourceRevisionId: source!.sourceRevisionId,
      retentionExpiresAt: source!.retentionExpiresAt,
    };
    const chunks = source!.chunks.map((chunk) => ({
      id: chunk.id,
      index: chunk.chunkIndex,
      content: chunk.content,
      evidenceUnitId: chunk.evidenceUnitId!,
    }));
    const cognitionJob = (await queue.listOperationJobs(5, {
      tenantId,
      type: "knowledge.cognify",
    }))[0];
    const cognitionRequest = jobs.knowledgeCognifyJobRequestSchema.parse(
      cognitionJob.payload.request,
    );
    expect(cognitionRequest.generationId).toBeDefined();
    const plan = runtime.partitionCognificationBatches({
      document,
      chunks,
      generationId: cognitionRequest.generationId,
    })[0];
    const quote = chunks[0].content;
    const evidence = [{
      evidenceUnitId: chunks[0].evidenceUnitId,
      chunkId: chunks[0].id,
      chunkIndex: 0,
      quote,
      quoteSha256: contentSha256Hex(quote),
      coordinateSpace: "evidence_content" as const,
      offsetUnit: "utf16_code_unit" as const,
      startOffset: 0,
      endOffsetExclusive: quote.length,
    }];
    const summaryBody = {
      text: "A reviewed source-map proposal about liquidity.",
      confidenceBasisPoints: 9_000,
      evidence,
    };
    const candidate = contract.buildCognificationCandidateBatchV1({
      batchId: plan.batchId,
      tenantId,
      ownerActorId: actorId,
      documentId: document.id,
      sourceItemId: document.sourceItemId,
      sourceRevisionId: document.sourceRevisionId,
      generationId: cognitionRequest.generationId,
      retentionExpiresAt: document.retentionExpiresAt,
      batchIndex: plan.batchIndex,
      batchCount: plan.batchCount,
      firstChunkIndex: plan.firstChunkIndex,
      lastChunkIndex: plan.lastChunkIndex,
      chunkCount: plan.chunkCount,
      inputCharacterCount: plan.inputCharacterCount,
      batchInputSha256: plan.batchInputSha256,
      evidenceUnitIds: [...plan.evidenceUnitIds],
      ontologyVersionId: "asael-ontology:1",
      topics: [],
      claims: [],
      entities: [],
      relations: [],
      summary: {
        candidateId: contract.deriveCognificationCandidateId(
          "summary",
          summaryBody,
        ),
        ...summaryBody,
      },
      modelAttribution: {
        provider: "openai",
        model: "configured-memory-model",
        routingSource: "tenant_assignment",
        assignmentScope: "memory",
        assignmentId: "assignment-memory",
        assignmentRevision: 1,
        assignmentConfigurationSha256: "a".repeat(64),
        credentialSource: "tenant_vault",
        usageReceiptRecorded: true,
        usageReceiptId: "usage-cognition-resume",
      },
    });
    const workerScope = parsePersistedExecutionScope(
      cognitionJob.payload.executionScope,
    );
    expect(workerScope).not.toBeNull();
    await cognitionStore.saveKnowledgeCognitionFromBackgroundWorker(candidate, {
      executionScope: workerScope!,
    });
    const modelSpy = vi.spyOn(runtime, "cognifyKnowledgeBatch");
    await expect(jobs.processBackgroundOperationQueue({ tenantId, limit: 1 }))
      .resolves.toMatchObject({ completed: 1, failed: 0 });
    expect(modelSpy).not.toHaveBeenCalled();
    expect(queue.projectOperationJobStatus(
      (await queue.getOperationJob(cognitionJob.id, { tenantId }))!,
    )).toMatchObject({
        status: "completed",
        result: { cognitionId: candidate.batchId },
      });
    modelSpy.mockRestore();
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
    // Discovery spans every tenant and serves the oldest runnable work first,
    // so this test uses its own ledger instead of work left by earlier tests.
    const previousDataDirectory = process.env.OMNIAGENT_DATA_DIR;
    onTestFinished(() => {
      process.env.OMNIAGENT_DATA_DIR = previousDataDirectory;
    });
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "omni-background-dispatch-"),
    );
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
    ).resolves.toMatchObject({
      tenantIds: ["tenant-background-a", "tenant-background-b"],
      leased: 2,
      completed: 2,
      failed: 0,
    });
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
