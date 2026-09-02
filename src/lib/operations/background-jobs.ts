import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import { updateCaptureAssetStatus } from "@/lib/capture/assets";
import { markCaptureRecordingIndexed } from "@/lib/capture/recordings";
import { runWithDatabaseTenantScope } from "@/lib/db/client";
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
  recordRunConsolidation,
} from "@/lib/runs/store";
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
  request,
  idempotencyKey,
}: {
  tenantId: string;
  request: EvaluationJobRequest;
  idempotencyKey?: string;
}) {
  const parsed = evaluationJobRequestSchema.parse(request);
  const requestId = idempotencyKey?.trim().slice(0, 200) || randomUUID();
  const requestHash = backgroundRequestHash(parsed);
  const job = await enqueueOperationJob({
    tenantId,
    type: "evaluation.run",
    dedupeKey: requestDedupeKey("evaluation.run", { requestId }),
    payload: {
      request: parsed,
      requestHash,
      progress: { stage: "queued", completed: 0, total: parsed.caseIds.length },
    },
    maxAttempts: 2,
    priority: 1,
    dedupeMode: "idempotent",
  });
  assertIdempotentRequest(job, requestHash, "evaluation.run");
  return job;
}

export async function enqueueKnowledgeIngestJob({
  tenantId,
  request,
  idempotencyKey,
}: {
  tenantId: string;
  request: KnowledgeIngestJobRequest;
  idempotencyKey?: string;
}) {
  const parsed = knowledgeIngestJobRequestSchema.parse(request);
  const requestId = idempotencyKey?.trim().slice(0, 200) || randomUUID();
  const requestHash = backgroundRequestHash(parsed);
  const job = await enqueueOperationJob({
    tenantId,
    type: "knowledge.ingest",
    dedupeKey: requestDedupeKey("knowledge.ingest", { requestId }),
    payload: {
      request: parsed,
      requestHash,
      progress: { stage: "queued" },
    },
    maxAttempts: 3,
    priority: 1,
    dedupeMode: "idempotent",
  });
  assertIdempotentRequest(job, requestHash, "knowledge.ingest");
  return job;
}

export async function enqueueMemoryConsolidationJob({
  tenantId,
  runId,
  mode,
}: {
  tenantId?: string;
  runId: string;
  mode: AgentMode;
  prompt: string;
  response: string;
}) {
  const request = memoryConsolidationJobRequestSchema.parse({
    runId,
    mode,
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
    const result = await executeBackgroundOperation(job, guard.signal);
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
  const metadata = parsed.data.metadata || {};
  const actorId = typeof metadata.actorId === "string" ? metadata.actorId : undefined;
  if (!actorId) return;
  try {
    if (typeof metadata.captureAssetId === "string") {
      await updateCaptureAssetStatus(metadata.captureAssetId, { tenantId: job.tenantId, actorId }, {
        status: "failed",
        extractionStatus: "completed",
        ingestJobId: job.id,
        error: message,
      });
    }
    if (typeof metadata.captureRecordingId === "string") {
      await markCaptureRecordingIndexed(metadata.captureRecordingId, { tenantId: job.tenantId, actorId }, { error: message });
    }
  } catch {
    // The operation job remains the durable source of failure truth if the
    // convenience status projection cannot be updated.
  }
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
    const { episode, consolidation } = await consolidateAgentRunMemory({
      runId: run.id,
      threadId: run.threadId,
      tenantId: job.tenantId,
      mode: run.mode,
      prompt: run.prompt,
      response: run.response || "",
      abortSignal,
    });
    const learnedCount = 1 + consolidation.saved.length;
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
          ? "memory consolidation failed"
          : "conversation learned",
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
      episodeId: episode.id,
      feedbackAdjusted: feedbackAdjustedMemoryIds.length,
      skipped: consolidation.skipped,
      error: consolidation.error,
    };
  }

  if (job.type === "knowledge.ingest") {
    const parsed = knowledgeIngestJobRequestSchema.parse(request);
    const result = await ingestTextDocument({
      ...parsed,
      tenantId: job.tenantId,
      idempotencyKey: job.id,
      abortSignal,
    });
    const metadata = parsed.metadata || {};
    const actorId = typeof metadata.actorId === "string" ? metadata.actorId : undefined;
    if (actorId) {
      try {
        if (typeof metadata.captureAssetId === "string") {
          await updateCaptureAssetStatus(metadata.captureAssetId, { tenantId: job.tenantId, actorId }, {
            status: "indexed",
            extractionStatus: "completed",
            ingestJobId: job.id,
            knowledgeDocumentId: result.document.id,
          });
        }
        if (typeof metadata.captureRecordingId === "string") {
          await markCaptureRecordingIndexed(metadata.captureRecordingId, { tenantId: job.tenantId, actorId }, {
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
