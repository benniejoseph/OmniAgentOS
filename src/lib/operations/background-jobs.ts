import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import {
  resolveCaptureAssetActorForIngestJob,
  updateCaptureAssetStatus,
} from "@/lib/capture/assets";
import {
  markCaptureRecordingIndexed,
  resolveCaptureRecordingActorForIngestJob,
} from "@/lib/capture/recordings";
import {
  runWithDatabaseActorScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { runEvaluationSuite } from "@/lib/evaluations/runner";
import {
  consolidateAgentRunMemory,
} from "@/lib/memory/consolidator";
import { applyRunMemoryFeedback } from "@/lib/memory/store";
import type { AgentMode } from "@/lib/orchestration/types";
import { ingestTextDocument } from "@/lib/rag/retriever";
import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";
import {
  appendRunEvent,
  getAgentRun,
  getAgentRunExecutionScope,
  recordRunConsolidation,
} from "@/lib/runs/store";
import {
  assertExecutionScopeTenant,
  createExecutionScope,
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import {
  BACKGROUND_OPERATION_JOB_TYPES,
  completeOperationJob,
  enqueueOperationJob,
  failOperationJob,
  getOperationJob,
  heartbeatOperationJob,
  leaseOperationJobs,
  listRunnableBackgroundJobTenantIds,
  updateOperationJobPayload,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";

export const evaluationJobRequestSchema = z
  .object({
    suite: z.string().min(1).max(80),
    caseIds: z.array(z.string().min(1).max(120)).max(200),
  })
  .strict();

export const knowledgeIngestJobRequestSchema = z
  .object({
    title: z.string().trim().min(1).max(240),
    content: z.string().min(1).max(900_000),
    source: z.string().max(2_000).optional(),
    sourceType: z.enum(["text", "url", "file", "api", "manual"]).optional(),
    tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    metadata: z.record(
      z.string().max(80),
      z.union([z.string().max(2_000), z.number(), z.boolean(), z.null()]),
    ).optional(),
    evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
  })
  .strict();

const memoryConsolidationJobRequestSchema = z
  .object({
    runId: z.string().min(1).max(200),
    mode: z.enum(["orchestrate", "research", "execute", "learn"]),
    // Optional only so jobs queued by a previous release can still finish.
    actorId: z.string().min(1).max(320).optional(),
  })
  .strict();

export type EvaluationJobRequest = z.infer<
  typeof evaluationJobRequestSchema
>;
export type KnowledgeIngestJobRequest = z.infer<
  typeof knowledgeIngestJobRequestSchema
>;

export class BackgroundJobIdempotencyConflictError extends Error {
  constructor(type: "knowledge.ingest" | "evaluation.run") {
    super(`The idempotency key is already bound to a different ${type} request.`);
    this.name = "BackgroundJobIdempotencyConflictError";
  }
}

const BACKGROUND_JOB_LEASE_SECONDS = Math.max(
  OPERATION_QUEUE_LEASE_SECONDS,
  300,
);

export async function enqueueEvaluationJob({
  tenantId,
  actorId,
  request,
  idempotencyKey,
}: {
  tenantId: string;
  actorId?: string;
  request: EvaluationJobRequest;
  idempotencyKey?: string;
}) {
  const parsed = evaluationJobRequestSchema.parse(request);
  const requestId = idempotencyKey?.trim().slice(0, 200) || randomUUID();
  const requestHash = backgroundRequestHash(parsed);
  const usageActorId = normalizeQueuedActorId(actorId);
  const job = await enqueueOperationJob({
    tenantId,
    type: "evaluation.run",
    dedupeKey: requestDedupeKey("evaluation.run", { requestId }),
    payload: {
      request: parsed,
      actorId: usageActorId,
      requestHash,
      progress: { stage: "queued", completed: 0, total: parsed.caseIds.length },
    },
    maxAttempts: 2,
    priority: 1,
    dedupeMode: "idempotent",
  });
  const existingActorId = typeof job.payload.actorId === "string"
    ? job.payload.actorId.trim()
    : undefined;
  if (existingActorId && usageActorId && existingActorId !== usageActorId) {
    throw new BackgroundJobIdempotencyConflictError("evaluation.run");
  }
  assertIdempotentRequest(job, requestHash, "evaluation.run");
  return job;
}

export async function enqueueKnowledgeIngestJob({
  tenantId,
  actorId,
  executionScope,
  request,
  idempotencyKey,
}: {
  tenantId: string;
  actorId?: string;
  executionScope?: ExecutionScope;
  request: KnowledgeIngestJobRequest;
  idempotencyKey?: string;
}) {
  const parsed = knowledgeIngestJobRequestSchema.parse(request);
  const requestId = idempotencyKey?.trim().slice(0, 200) || randomUUID();
  const usageActorId = normalizeQueuedActorId(actorId);
  const trustedExecutionScope = executionScope
    ? requireQueuedExecutionScope(executionScope, tenantId, usageActorId)
    : undefined;
  // Keep the document-only hash so an idempotency key created by an older
  // release remains replay-compatible. Actor attribution is trusted metadata,
  // not part of the document mutation contract.
  const requestHash = backgroundRequestHash(parsed);
  const job = await enqueueOperationJob({
    tenantId,
    type: "knowledge.ingest",
    dedupeKey: requestDedupeKey("knowledge.ingest", { requestId }),
    payload: {
      request: parsed,
      actorId: usageActorId,
      executionScope: trustedExecutionScope,
      requestHash,
      progress: { stage: "queued" },
    },
    maxAttempts: 3,
    priority: 1,
    dedupeMode: "idempotent",
  });
  const existingActorId = typeof job.payload.actorId === "string"
    ? job.payload.actorId.trim()
    : undefined;
  if (existingActorId && usageActorId && existingActorId !== usageActorId) {
    throw new BackgroundJobIdempotencyConflictError("knowledge.ingest");
  }
  assertIdempotentRequest(job, requestHash, "knowledge.ingest");
  return job;
}

export async function enqueueMemoryConsolidationJob({
  tenantId,
  runId,
  mode,
  actorId,
}: {
  tenantId?: string;
  runId: string;
  mode: AgentMode;
  actorId?: string;
  prompt: string;
  response: string;
}) {
  const request = memoryConsolidationJobRequestSchema.parse({
    runId,
    mode,
    actorId: actorId?.trim() || undefined,
  });
  return enqueueOperationJob({
    tenantId,
    type: "memory.consolidate",
    dedupeKey: `memory.consolidate:${runId}`,
    payload: {
      request,
      progress: { stage: "queued" },
    },
    maxAttempts: 3,
    priority: 2,
    dedupeMode: "idempotent",
  });
}

export async function processBackgroundOperationQueue({
  tenantId,
  limit = 3,
  timeBudgetMs = 240_000,
}: {
  tenantId: string;
  limit?: number;
  timeBudgetMs?: number;
}) {
  return runWithDatabaseTenantScope(tenantId, () =>
    processBackgroundOperationQueueInScope({
      tenantId,
      limit,
      timeBudgetMs,
    }),
  );
}

async function processBackgroundOperationQueueInScope({
  tenantId,
  limit = 3,
  timeBudgetMs = 240_000,
}: {
  tenantId: string;
  limit?: number;
  timeBudgetMs?: number;
}) {
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 3);
  const boundedBudgetMs = Math.min(
    Math.max(Math.round(timeBudgetMs), 1_000),
    240_000,
  );
  const startedAt = Date.now();
  const results: BackgroundJobResult[] = [];

  while (
    results.length < boundedLimit &&
    Date.now() - startedAt < boundedBudgetMs
  ) {
    const [job] = await leaseOperationJobs({
      tenantId,
      types: BACKGROUND_OPERATION_JOB_TYPES,
      limit: 1,
      leaseSeconds: BACKGROUND_JOB_LEASE_SECONDS,
    });
    if (!job) {
      break;
    }
    const remainingMs = Math.max(
      1_000,
      boundedBudgetMs - (Date.now() - startedAt),
    );
    results.push(await processBackgroundOperationJob(job, remainingMs));
  }

  return summarizeBackgroundResults(results);
}

export async function processAllTenantBackgroundOperationQueues({
  limit = 3,
  timeBudgetMs = 240_000,
}: {
  limit?: number;
  timeBudgetMs?: number;
} = {}) {
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 3);
  const startedAt = Date.now();
  const tenantIds = await listRunnableBackgroundJobTenantIds(boundedLimit);
  const results: BackgroundJobResult[] = [];

  for (const tenantId of tenantIds) {
    const remaining = timeBudgetMs - (Date.now() - startedAt);
    if (results.length >= boundedLimit || remaining < 1_000) {
      break;
    }
    const tenantResult = await processBackgroundOperationQueue({
      tenantId,
      limit: 1,
      timeBudgetMs: remaining,
    });
    results.push(...tenantResult.jobs);
  }

  return {
    tenantIds,
    ...summarizeBackgroundResults(results),
  };
}

type BackgroundJobResult = {
  id: string;
  type: OperationJobRecord["type"];
  status: "completed" | "failed" | "queued" | "stale";
  resourceId?: string;
  error?: string;
};

async function processBackgroundOperationJob(
  job: OperationJobRecord,
  maxRuntimeMs: number,
): Promise<BackgroundJobResult> {
  const leaseOwner = job.leaseOwner;
  if (!leaseOwner) {
    return {
      id: job.id,
      type: job.type,
      status: "failed",
      error: "Background job lease owner is missing.",
    };
  }

  const guard = startBackgroundJobGuard(
    job,
    leaseOwner,
    Math.max(1_000, maxRuntimeMs - 500),
  );
  try {
    const started = await updateOperationJobPayload(
      job.id,
      leaseOwner,
      { progress: { stage: "processing", startedAt: new Date().toISOString() } },
      { tenantId: job.tenantId },
    );
    assertLeaseMutation(started, job.id);
    const result = await executeBackgroundOperationInAccessScope(
      job,
      guard.signal,
    );
    guard.assertActive();
    const updated = await updateOperationJobPayload(
      job.id,
      leaseOwner,
      {
        progress: { stage: "completed", completedAt: new Date().toISOString() },
        result,
      },
      { tenantId: job.tenantId },
    );
    assertLeaseMutation(updated, job.id);
    const completed = await completeOperationJob(
      job.id,
      leaseOwner,
      job.tenantId,
    );
    assertLeaseMutation(completed, job.id);
    return {
      id: job.id,
      type: job.type,
      status: "completed",
      resourceId:
        typeof result.resourceId === "string" ? result.resourceId : undefined,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Background operation failed.";
    const failed = await failOperationJob(
      job.id,
      message,
      leaseOwner,
      job.tenantId,
    );
    if (job.type === "knowledge.ingest" && failed?.status === "failed") {
      await markCaptureIngestFailureSafely(job, message);
    } else if (job.type === "knowledge.ingest" && !failed) {
      await cleanCanceledCaptureIngestSafely(job);
    }
    return {
      id: job.id,
      type: job.type,
      status:
        failed?.status === "queued"
          ? "queued"
          : failed?.status === "failed"
            ? "failed"
            : "stale",
      error: message,
    };
  } finally {
    guard.stop();
  }
}

function executeBackgroundOperationInAccessScope(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
) {
  if (job.type !== "memory.consolidate") {
    return executeBackgroundOperation(job, abortSignal);
  }
  const parsed = memoryConsolidationJobRequestSchema.parse(job.payload.request);
  if (!parsed.actorId) {
    throw new Error("Memory consolidation job is missing its owner actor binding.");
  }
  return runWithDatabaseActorScope(job.tenantId, [parsed.actorId], () =>
    executeBackgroundOperation(job, abortSignal)
  );
}

async function cleanCanceledCaptureIngestSafely(job: OperationJobRecord) {
  try {
    const current = await getOperationJob(job.id, { tenantId: job.tenantId });
    if (current?.status !== "canceled") return;
    const parsed = knowledgeIngestJobRequestSchema.safeParse(job.payload.request);
    if (!parsed.success || !parsed.data.source?.startsWith("capture:")) return;
    const metadata = parsed.data.metadata || {};
    if (typeof metadata.captureAssetId !== "string" && typeof metadata.captureRecordingId !== "string") return;
    await deleteKnowledgeDocumentsBySourcePrefix(parsed.data.source, { tenantId: job.tenantId });
  } catch {
    // The delete route performs the same purge. This is a best-effort race
    // guard for a worker that finished after its lease was canceled.
  }
}

async function markCaptureIngestFailureSafely(job: OperationJobRecord, message: string) {
  const parsed = knowledgeIngestJobRequestSchema.safeParse(job.payload.request);
  if (!parsed.success) return;
  const target = captureIngestTarget(parsed.data);
  if (!target) return;
  const actorId = await resolveKnowledgeIngestActorId(job, parsed.data);
  if (!actorId) return;
  try {
    const executionScope = captureIngestMutationExecutionScope(job, actorId);
    if (target.assetId) {
      await updateCaptureAssetStatus(target.assetId, {
        tenantId: job.tenantId,
        actorId,
        executionScope,
      }, {
        status: "failed",
        extractionStatus: "completed",
        ingestJobId: job.id,
        error: message,
      });
    }
    if (target.recordingId) {
      await markCaptureRecordingIndexed(target.recordingId, {
        tenantId: job.tenantId,
        actorId,
        executionScope,
      }, { error: message });
    }
  } catch {
    // The operation job remains the durable source of failure truth if the
    // convenience status projection cannot be updated.
  }
}

async function resolveKnowledgeIngestActorId(
  job: OperationJobRecord,
  request: KnowledgeIngestJobRequest,
) {
  const queuedActorId = typeof job.payload.actorId === "string"
    ? normalizeQueuedActorId(job.payload.actorId) || ""
    : "";
  if (queuedActorId) return queuedActorId;

  const metadata = request.metadata || {};
  try {
    if (
      typeof metadata.captureAssetId === "string" &&
      request.source === `capture:asset:${metadata.captureAssetId}`
    ) {
      return resolveCaptureAssetActorForIngestJob(metadata.captureAssetId, {
        tenantId: job.tenantId,
        ingestJobId: job.id,
      });
    }
    if (
      typeof metadata.captureRecordingId === "string" &&
      request.source === `capture:recording:${metadata.captureRecordingId}`
    ) {
      return resolveCaptureRecordingActorForIngestJob(metadata.captureRecordingId, {
        tenantId: job.tenantId,
        ingestJobId: job.id,
      });
    }
  } catch {
    // Projection recovery is best effort; document ingestion remains canonical.
  }
  return undefined;
}

async function executeBackgroundOperation(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
) {
  abortSignal.throwIfAborted();
  const request = job.payload.request;
  if (job.type === "memory.consolidate") {
    const parsed = memoryConsolidationJobRequestSchema.parse(request);
    const run = await getAgentRun(parsed.runId, { tenantId: job.tenantId });
    if (!run) {
      throw new Error("Agent run for memory consolidation was not found.");
    }
    abortSignal.throwIfAborted();
    await appendRunEvent(
      parsed.runId,
      {
        type: "status",
        label: "consolidating memory",
        detail: "Extracting durable learnings in the background.",
      },
      { tenantId: job.tenantId },
    );
    const executionScope = await getAgentRunExecutionScope(parsed.runId, {
      tenantId: job.tenantId,
    });
    const actorId = parsed.actorId || executionScope?.initiatingActorId || undefined;
    if (
      parsed.actorId &&
      executionScope?.initiatingActorId &&
      parsed.actorId !== executionScope.initiatingActorId
    ) {
      throw new Error("Memory consolidation actor does not match its run scope.");
    }
    const { episode, consolidation } = await consolidateAgentRunMemory({
      runId: run.id,
      threadId: run.threadId,
      tenantId: job.tenantId,
      actorId,
      executionScope,
      mode: run.mode,
      prompt: run.prompt,
      response: run.response || "",
      abortSignal,
    });
    const learnedCount = consolidation.saved.length;
    const feedbackAdjustedMemoryIds = run.feedback
      ? await applyRunMemoryFeedback(run.id, run.feedback.verdict, {
          tenantId: job.tenantId,
        })
      : [];
    await recordRunConsolidation(parsed.runId, {
      count: learnedCount,
      error: consolidation.error,
    }, { tenantId: job.tenantId });
    await appendRunEvent(
      parsed.runId,
      {
        type: "memory",
        title: consolidation.error
          ? "evidence-based memory formation failed"
          : learnedCount
            ? "evidence-backed memory formed"
            : "no verified effects to learn",
        count: learnedCount,
      },
      { tenantId: job.tenantId },
    );
    if (consolidation.error) {
      throw new Error(consolidation.error);
    }
    return {
      resourceId: parsed.runId,
      saved: learnedCount,
      ...(episode ? { episodeId: episode.id } : {}),
      feedbackAdjusted: feedbackAdjustedMemoryIds.length,
      skipped: consolidation.skipped,
      error: consolidation.error,
    };
  }

  if (job.type === "knowledge.ingest") {
    const parsed = knowledgeIngestJobRequestSchema.parse(request);
    const captureTarget = captureIngestTarget(parsed);
    const actorId = await resolveKnowledgeIngestActorId(job, parsed);
    const sourceExecutionScope = actorId
      ? knowledgeIngestSourceExecutionScope(job, actorId, Boolean(captureTarget))
      : undefined;
    const captureExecutionScope = actorId && captureTarget
      ? captureIngestMutationExecutionScope(job, actorId)
      : undefined;
    const captureIngestGuard = actorId && captureTarget
      ? {
          tenantId: job.tenantId,
          actorId,
          ingestJobId: job.id,
          ...(captureTarget.assetId
            ? { kind: "asset" as const, captureId: captureTarget.assetId }
            : {
                kind: "recording" as const,
                captureId: captureTarget.recordingId as string,
              }),
        }
      : undefined;
    const result = await ingestTextDocument({
      ...parsed,
      tenantId: job.tenantId,
      idempotencyKey: job.id,
      abortSignal,
      ...(actorId ? {
        usageScope: {
          tenantId: job.tenantId,
          actorId,
          sourceStreamId: `operation-job:${job.id}`,
          operation: "embedding" as const,
          purpose: "knowledge.ingest.background",
          correlationId: sourceExecutionScope?.correlationId || job.id,
          causationId: sourceExecutionScope?.causationId || undefined,
          executionScope: sourceExecutionScope,
          credentialSource: "deployment_environment" as const,
        },
      } : {}),
      ...(sourceExecutionScope && actorId
        ? {
            sourceLineage: {
              executionScope: sourceExecutionScope,
              connectionId: captureTarget
                ? "first_party.capture"
                : "first_party.ingest_api",
              adapterId: captureTarget
                ? "asael.capture"
                : "asael.ingest_api",
              adapterVersionId: "1",
              externalItemId:
                (captureTarget?.assetId
                  ? `asset:${captureTarget.assetId}`
                  : captureTarget?.recordingId
                    ? `recording:${captureTarget.recordingId}`
                    : `job:${job.id}`),
              providerRevisionId: job.id,
              capturedAt: job.createdAt,
              sourceKind: captureTarget
                ? "capture" as const
                : canonicalSourceKind(parsed.sourceType),
            },
          }
        : {}),
      captureIngestGuard,
    });
    if (actorId && captureExecutionScope) {
      try {
        const executionScope = captureExecutionScope;
        if (captureTarget?.assetId) {
          await updateCaptureAssetStatus(captureTarget.assetId, {
            tenantId: job.tenantId,
            actorId,
            executionScope,
          }, {
            status: "indexed",
            extractionStatus: "completed",
            ingestJobId: job.id,
            knowledgeDocumentId: result.document.id,
          });
        }
        if (captureTarget?.recordingId) {
          await markCaptureRecordingIndexed(captureTarget.recordingId, {
            tenantId: job.tenantId,
            actorId,
            executionScope,
          }, {
            knowledgeDocumentId: result.document.id,
          });
        }
      } catch {
        // Indexing is the source of truth; a deleted or temporarily unavailable
        // Capture projection must not turn a completed ingest into a retry.
      }
    }
    return {
      resourceId: result.document.id,
      documentId: result.document.id,
      chunkCount: result.chunks.length,
      memoryCount: result.memories.length,
    };
  }

  if (job.type === "evaluation.run") {
    const parsed = evaluationJobRequestSchema.parse(request);
    const detail = await runEvaluationSuite({
      ...parsed,
      tenantId: job.tenantId,
      actorId: typeof job.payload.actorId === "string"
        ? job.payload.actorId
        : undefined,
      runId: `evaluation_job_${job.id}`,
      abortSignal,
      onProgress: async (progress) => {
        abortSignal.throwIfAborted();
        const updated = await updateOperationJobPayload(
          job.id,
          job.leaseOwner || "",
          { progress: { stage: "processing", ...progress } },
          { tenantId: job.tenantId },
        );
        assertLeaseMutation(updated, job.id);
      },
    });
    if (!detail) {
      throw new Error("Evaluation run detail unavailable.");
    }
    return {
      resourceId: detail.run.id,
      evaluationRunId: detail.run.id,
      status: detail.run.status,
      summary: detail.run.summary,
    };
  }

  throw new Error(`Unsupported background operation type: ${job.type}`);
}

function startBackgroundJobGuard(
  job: OperationJobRecord,
  leaseOwner: string,
  maxRuntimeMs: number,
) {
  const controller = new AbortController();
  let heartbeatRunning = false;
  const abort = (error: Error) => {
    if (!controller.signal.aborted) {
      controller.abort(error);
    }
  };
  const heartbeat = setInterval(() => {
    if (heartbeatRunning) {
      return;
    }
    heartbeatRunning = true;
    void heartbeatOperationJob(job.id, leaseOwner, {
      tenantId: job.tenantId,
      leaseSeconds: BACKGROUND_JOB_LEASE_SECONDS,
    })
      .then((renewed) => {
        if (!renewed) {
          abort(new Error(`Background job ${job.id} lost its lease.`));
        }
      })
      .catch((error: unknown) => {
        abort(
          new Error(
            `Background job ${job.id} heartbeat failed: ${
              error instanceof Error ? error.message : "unknown error"
            }`,
          ),
        );
      })
      .finally(() => {
        heartbeatRunning = false;
      });
  }, 30_000);
  const timeout = setTimeout(() => {
    abort(
      new Error(
        `Background job ${job.id} exceeded its ${maxRuntimeMs}ms execution budget.`,
      ),
    );
  }, maxRuntimeMs);
  heartbeat.unref?.();
  timeout.unref?.();
  return {
    signal: controller.signal,
    assertActive() {
      controller.signal.throwIfAborted();
    },
    stop() {
      clearInterval(heartbeat);
      clearTimeout(timeout);
    },
  };
}

function assertLeaseMutation(
  record: OperationJobRecord | null,
  jobId: string,
): asserts record is OperationJobRecord {
  if (!record) {
    throw new Error(`Background job ${jobId} lost its lease.`);
  }
}

function summarizeBackgroundResults(results: BackgroundJobResult[]) {
  return {
    leased: results.length,
    completed: results.filter((result) => result.status === "completed").length,
    failed: results.filter((result) => result.status === "failed").length,
    deferred: results.filter((result) => result.status === "queued").length,
    stale: results.filter((result) => result.status === "stale").length,
    jobs: results,
  };
}

function requestDedupeKey(
  type: "knowledge.ingest" | "evaluation.run",
  request: Record<string, unknown>,
) {
  const digest = createHash("sha256")
    .update(stableStringify(request))
    .digest("hex")
    .slice(0, 40);
  return `${type}:${digest}`;
}

function backgroundRequestHash(request: Record<string, unknown>) {
  return createHash("sha256")
    .update(stableStringify(request))
    .digest("hex");
}

function assertIdempotentRequest(
  job: OperationJobRecord,
  requestHash: string,
  type: "knowledge.ingest" | "evaluation.run",
) {
  if (
    typeof job.payload.requestHash === "string" &&
    job.payload.requestHash !== requestHash
  ) {
    throw new BackgroundJobIdempotencyConflictError(type);
  }
}

function normalizeQueuedActorId(value: string | undefined) {
  const actorId = value?.trim();
  if (!actorId) return undefined;
  if (actorId.length > 256) {
    throw new Error("Background job actor identity exceeds 256 characters.");
  }
  return actorId;
}

function requireQueuedExecutionScope(
  value: ExecutionScope,
  tenantId: string,
  actorId: string | undefined,
) {
  const executionScope = parsePersistedExecutionScope(value);
  if (!executionScope) {
    throw new Error("Background knowledge ingestion requires a valid execution scope.");
  }
  assertExecutionScopeTenant(executionScope, tenantId.trim());
  if (actorId && executionScope.initiatingActorId !== actorId) {
    throw new Error("Background knowledge ingestion scope does not match its actor.");
  }
  if (!executionScope.executingPrincipalId) {
    throw new Error("Background knowledge ingestion scope requires an executing principal.");
  }
  return executionScope;
}

function captureIngestMutationExecutionScope(
  job: OperationJobRecord,
  actorId: string,
) {
  const persisted = parsePersistedExecutionScope(job.payload.executionScope);
  if (persisted) {
    assertExecutionScopeTenant(persisted, job.tenantId);
    if (persisted.initiatingActorId !== actorId) {
      throw new Error("Capture ingest job scope does not match its stored owner.");
    }
    return deriveExecutionScope(persisted, {
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      causationId: job.id,
      purpose: "capture.ingest.projection.update",
    });
  }

  // Explicit compatibility authority for jobs created before execution scopes
  // were persisted. The actor has already been recovered from the trusted job
  // payload or from a capture record bound to this exact ingest job ID.
  return createExecutionScope({
    tenantId: job.tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    correlationId: job.id,
    causationId: job.id,
    purpose: "capture.ingest.projection.update.legacy",
  });
}

function knowledgeIngestSourceExecutionScope(
  job: OperationJobRecord,
  actorId: string,
  captureSource: boolean,
) {
  const persisted = parsePersistedExecutionScope(job.payload.executionScope);
  if (persisted) {
    assertExecutionScopeTenant(persisted, job.tenantId);
    if (persisted.initiatingActorId !== actorId) {
      throw new Error("Knowledge ingest job scope does not match its stored owner.");
    }
    return deriveExecutionScope(persisted, {
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      causationId: job.id,
      purpose: captureSource
        ? "capture.ingest.source.index"
        : persisted.purpose,
    });
  }

  return createExecutionScope({
    tenantId: job.tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    correlationId: job.id,
    causationId: job.id,
    purpose: captureSource
      ? "capture.ingest.source.index.legacy"
      : "knowledge.ingest.background.legacy",
  });
}

function captureIngestTarget(request: KnowledgeIngestJobRequest) {
  const metadata = request.metadata || {};
  if (
    typeof metadata.captureAssetId === "string" &&
    request.source === `capture:asset:${metadata.captureAssetId}`
  ) {
    return { assetId: metadata.captureAssetId, recordingId: undefined };
  }
  if (
    typeof metadata.captureRecordingId === "string" &&
    request.source === `capture:recording:${metadata.captureRecordingId}`
  ) {
    return { assetId: undefined, recordingId: metadata.captureRecordingId };
  }
  return undefined;
}

function canonicalSourceKind(
  sourceType: KnowledgeIngestJobRequest["sourceType"],
) {
  if (sourceType === "url") return "webpage" as const;
  if (sourceType === "file") return "file" as const;
  if (sourceType === "api") return "record" as const;
  return "document" as const;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
