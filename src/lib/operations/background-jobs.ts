import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  CAPTURE_STRUCTURED_EXTRACTOR_CONFIG_SHA256,
  CAPTURE_STRUCTURED_EXTRACTOR_ID,
  CAPTURE_STRUCTURED_EXTRACTOR_VERSION,
  appendCaptureNote,
  captureExtractionReceipt,
  captureExtractionUnitSchema,
  renderCaptureExtractionUnits,
  terminalCaptureExtractionReceipt,
  type CaptureExtractionReceipt,
  type CaptureExtractionUnit,
} from "@/lib/capture/extraction";
import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import {
  CaptureAssetContentNotReadyError,
  getCaptureAsset,
  getCaptureAssetContent,
  resolveCaptureAssetActorForIngestJob,
  updateCaptureAssetStatus,
} from "@/lib/capture/assets";
import {
  CaptureFileError,
  captureTitle,
  extractCaptureFile,
} from "@/lib/capture/files";
import {
  markCaptureRecordingIndexed,
  resolveCaptureRecordingActorForIngestJob,
} from "@/lib/capture/recordings";
import {
  executeCaptureMediaProcessingJob,
  executeCaptureMediaSegmentJob,
  isCaptureMediaDeferredResult,
  renderCaptureMediaKnowledge,
  type CaptureMediaDeferredResult,
} from "@/lib/capture/media-jobs";
import { markCaptureMediaProcessingStatus } from "@/lib/capture/media-store";
import {
  runWithDatabaseActorScope,
  runWithDatabaseTenantScope,
} from "@/lib/db/client";
import { runEvaluationSuite } from "@/lib/evaluations/runner";
import {
  consolidateAgentRunMemory,
} from "@/lib/memory/consolidator";
import { applyRunMemoryFeedback } from "@/lib/memory/store";
import {
  cognifyKnowledgeBatch,
  partitionCognificationBatches,
  resolveCognitionGenerationId,
  type CognificationBatchPlan,
} from "@/lib/knowledge/cognification-runtime";
import {
  getKnowledgeCognition,
  saveKnowledgeCognitionFromBackgroundWorker,
  type KnowledgeCognitionRecord,
} from "@/lib/knowledge/cognification-store";
import type { AgentMode } from "@/lib/orchestration/types";
import { ingestTextDocument } from "@/lib/rag/retriever";
import {
  deleteKnowledgeDocumentsBySourcePrefix,
  getActorOwnedKnowledgeForCognition,
  type ActorOwnedCognitionSource,
} from "@/lib/rag/store";
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
  deferOperationJob,
  enqueueOperationJob,
  failOperationJob,
  getOperationJob,
  heartbeatOperationJob,
  leaseOperationJobs,
  listRunnableBackgroundJobTenantIds,
  updateOperationJobPayload,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  commitAssetObjectJob,
  deleteAssetObjectJob,
} from "@/lib/storage/object-plane";
import { executeAssetObjectMigrationJob } from "@/lib/storage/object-migration";
import {
  CLAIM_EVIDENCE_PURPOSE_ID,
  CONTEXT_COMPILER_V2_PURPOSE_ID,
  KNOWLEDGE_COGNIFY_PURPOSE_ID,
} from "@/lib/sources/purposes";
import {
  sourceContractSha256,
  type SourceItemV1,
} from "@/lib/sources/contracts";
import {
  getCurrentSemanticEnrichment,
  readOwnedSemanticEpisodeSource,
  saveSemanticEnrichmentFromWorker,
} from "@/lib/threads/semantic-summary-store";
import {
  buildSemanticEpisodeEnrichmentPlan,
  enrichConversationEpisode,
  resolveSemanticSummaryGenerationId,
  SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
} from "@/lib/threads/semantic-summaries";
import { executeMarketEventBackfillJob } from "@/lib/market-research/event-jobs";
import { executeMarketEventReplayBackfillJob } from "@/lib/market-research/replay-jobs";
import { executeMarketBacktestJob } from "@/lib/market-research/backtest-jobs";

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
    structuredUnits: z.array(captureExtractionUnitSchema).min(1).max(1_024).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.structuredUnits) return;
    const structuredContent = renderCaptureExtractionUnits(value.structuredUnits);
    if (structuredContent.length > 900_000) {
      context.addIssue({
        code: "custom",
        message: "Structured extraction exceeds the indexing limit.",
        path: ["structuredUnits"],
      });
    }
    if (normalizeQueuedContent(structuredContent) !== normalizeQueuedContent(value.content)) {
      context.addIssue({
        code: "custom",
        message: "Structured extraction must exactly compose the queued content.",
        path: ["structuredUnits"],
      });
    }
  });

export const captureAssetProcessJobRequestSchema = z.object({
  assetId: z.string().trim().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().trim().min(1).max(240).optional(),
  note: z.string().trim().max(20_000).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
}).strict();

const memoryConsolidationJobRequestSchema = z
  .object({
    runId: z.string().min(1).max(200),
    mode: z.enum(["orchestrate", "research", "execute", "learn"]),
    // Optional only so jobs queued by a previous release can still finish.
    actorId: z.string().min(1).max(320).optional(),
  })
  .strict();

export const knowledgeCognifyJobRequestSchema = z.object({
  documentId: z.string().trim().min(1).max(320),
  sourceRevisionId: z.string().trim().min(1).max(320),
  batchIndex: z.number().int().nonnegative().max(10_000),
  // Optional only so jobs queued by the immediately preceding release can
  // finish. Every newly enqueued job is upgraded to the current source plan.
  sourcePlanSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  retentionExpiresAt: z.string().datetime({ offset: true }).nullable().optional(),
  generationId: z.string().regex(/^cognition_generation_[a-f0-9]{48}$/).optional(),
}).strict().superRefine((value, context) => {
  if (
    Boolean(value.sourcePlanSha256) !==
      (value.retentionExpiresAt !== undefined)
  ) {
    context.addIssue({
      code: "custom",
      message: "Cognition plan hash and retention binding must be supplied together.",
      path: ["sourcePlanSha256"],
    });
  }
  if (value.generationId && !value.sourcePlanSha256) {
    context.addIssue({
      code: "custom",
      message: "Cognition generation identity requires a complete source plan binding.",
      path: ["generationId"],
    });
  }
});

export const semanticSummaryEnrichmentRequestSchema = z.object({
  episodeSummaryId: z.string().trim().min(1).max(320),
  episodeSourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
  deterministicSummarySha256: z.string().regex(/^[a-f0-9]{64}$/),
  generationId: z.string().regex(
    /^semantic_summary_generation_[a-f0-9]{48}$/,
  ),
}).strict();

const semanticSummaryEnrichmentJobRequestSchema =
  semanticSummaryEnrichmentRequestSchema.extend({
    threadId: z.string().trim().min(1).max(320),
    projectId: z.string().trim().min(1).max(320).nullable(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/),
    enrichmentId: z.string().regex(
      /^semantic_episode_enrichment_[a-f0-9]{48}$/,
    ),
  }).strict();

type CurrentKnowledgeCognifyJobRequest = KnowledgeCognifyJobRequest & {
  sourcePlanSha256: string;
  retentionExpiresAt: string | null;
};

export type EvaluationJobRequest = z.infer<
  typeof evaluationJobRequestSchema
>;
export type KnowledgeIngestJobRequest = z.infer<
  typeof knowledgeIngestJobRequestSchema
>;
export type CaptureAssetProcessJobRequest = z.infer<
  typeof captureAssetProcessJobRequestSchema
>;
export type KnowledgeCognifyJobRequest = z.infer<
  typeof knowledgeCognifyJobRequestSchema
>;
export type SemanticSummaryEnrichmentRequest = z.infer<
  typeof semanticSummaryEnrichmentRequestSchema
>;

export class BackgroundJobIdempotencyConflictError extends Error {
  constructor(type: "capture.asset.process" | "knowledge.ingest" | "knowledge.cognify" | "evaluation.run") {
    super(`The idempotency key is already bound to a different ${type} request.`);
    this.name = "BackgroundJobIdempotencyConflictError";
  }
}

export async function enqueueCaptureAssetProcessJob({
  tenantId,
  actorId,
  executionScope,
  request,
  idempotencyKey,
}: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  request: CaptureAssetProcessJobRequest;
  idempotencyKey?: string;
}) {
  const parsed = captureAssetProcessJobRequestSchema.parse(request);
  const usageActorId = normalizeQueuedActorId(actorId);
  if (!usageActorId) {
    throw new Error("Capture asset processing requires an owner actor.");
  }
  const trustedExecutionScope = requireQueuedExecutionScope(
    executionScope,
    tenantId,
    usageActorId,
  );
  const requestId = idempotencyKey?.trim().slice(0, 200) || randomUUID();
  const requestHash = backgroundRequestHash(parsed);
  const job = await enqueueOperationJob({
    tenantId,
    type: "capture.asset.process",
    dedupeKey: requestDedupeKey("capture.asset.process", { requestId }),
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
  if (job.payload.actorId !== usageActorId) {
    throw new BackgroundJobIdempotencyConflictError("capture.asset.process");
  }
  assertIdempotentRequest(job, requestHash, "capture.asset.process");
  return job;
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

export async function enqueueKnowledgeCognifyJob({
  tenantId,
  actorId,
  executionScope,
  request,
}: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  request: KnowledgeCognifyJobRequest;
}) {
  const parsed = knowledgeCognifyJobRequestSchema.parse(request);
  if (!parsed.sourcePlanSha256 || parsed.retentionExpiresAt === undefined) {
    throw new Error(
      "New knowledge cognition jobs require the current source plan binding.",
    );
  }
  return enqueueCurrentKnowledgeCognifyJob({
    tenantId,
    actorId,
    executionScope,
    request: parsed as CurrentKnowledgeCognifyJobRequest,
  });
}

/**
 * Reconciles a complete current source plan and queues only its first batch
 * without a persisted review candidate. This makes an owner retry resume a
 * failed later batch while preserving completed work.
 */
export async function enqueueKnowledgeCognificationPlan({
  tenantId,
  actorId,
  executionScope,
  documentId,
  sourceRevisionId,
}: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  documentId: string;
  sourceRevisionId: string;
}) {
  const usageActorId = normalizeQueuedActorId(actorId);
  if (!usageActorId) {
    throw new Error("Knowledge cognification requires an owner actor.");
  }
  requireQueuedExecutionScope(executionScope, tenantId, usageActorId);
  const source = await getActorOwnedKnowledgeForCognition({
    tenantId,
    actorId: usageActorId,
    documentId,
  });
  if (!source || source.sourceRevisionId !== sourceRevisionId) {
    return null;
  }
  const document = cognitionDocument(source);
  const generationId = await resolveCognitionGenerationId({
    tenantId,
    actorId: usageActorId,
  });
  const batches = partitionCognificationBatches({
    document,
    chunks: cognitionChunks(source),
    generationId,
  });
  const sourcePlanSha256 = cognitionSourcePlanSha256(
    document,
    batches,
    generationId,
  );
  for (const batch of batches) {
    const existing = await getKnowledgeCognition(batch.batchId, {
      tenantId,
      actorId: usageActorId,
    });
    if (existing) continue;
    return enqueueCurrentKnowledgeCognifyJob({
      tenantId,
      actorId: usageActorId,
      executionScope,
      request: {
        documentId: document.id,
        sourceRevisionId: document.sourceRevisionId,
        generationId,
        retentionExpiresAt: document.retentionExpiresAt,
        sourcePlanSha256,
        batchIndex: batch.batchIndex,
      },
    });
  }
  return null;
}

/**
 * Coalesces repeated requests for one deterministic episode identity. A newer
 * source or Settings-backed memory generation replaces a queued request; an
 * active worker finishes its immutable lease and the queue then reruns only
 * the latest request.
 */
export async function enqueueSemanticSummaryEnrichmentJob({
  tenantId,
  actorId,
  executionScope,
  request,
}: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  request: SemanticSummaryEnrichmentRequest;
}) {
  const parsed = semanticSummaryEnrichmentRequestSchema.parse(request);
  const usageActorId = normalizeQueuedActorId(actorId);
  if (!usageActorId) {
    throw new Error("Semantic summary enrichment requires an owner actor.");
  }
  const trustedExecutionScope = requireQueuedExecutionScope(
    executionScope,
    tenantId,
    usageActorId,
  );
  if (
    trustedExecutionScope.executingPrincipalType !== "user" ||
    trustedExecutionScope.executingPrincipalId !== usageActorId ||
    trustedExecutionScope.workspaceId !== null ||
    trustedExecutionScope.missionId !== null ||
    trustedExecutionScope.delegationId !== null ||
    trustedExecutionScope.contextGrantIds.length !== 0 ||
    trustedExecutionScope.capabilityGrantIds.length !== 0 ||
    trustedExecutionScope.purpose !== "conversation.summary.enrich.queue"
  ) {
    throw new Error("Semantic summary enrichment queue scope is invalid.");
  }
  const source = await readOwnedSemanticEpisodeSource({
    tenantId,
    actorId: usageActorId,
    episodeSummaryId: parsed.episodeSummaryId,
  });
  if (!source) return null;
  if (
    source.episode.sourceSha256 !== parsed.episodeSourceSha256 ||
    source.episode.summarySha256 !== parsed.deterministicSummarySha256 ||
    !source.episode.threadId
  ) return null;
  if (
    trustedExecutionScope.projectId !== (source.episode.projectId || null)
  ) {
    throw new Error("Semantic summary enrichment queue project scope is invalid.");
  }

  const currentGenerationId = await resolveSemanticSummaryGenerationId({
    tenantId,
    actorId: usageActorId,
  });
  if (currentGenerationId !== parsed.generationId) return null;
  const plan = buildSemanticEpisodeEnrichmentPlan({
    episode: source.episode,
    turns: source.turns,
    generationId: parsed.generationId,
  });
  const workerScope = deriveExecutionScope(trustedExecutionScope, {
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    workspaceId: null,
    projectId: source.episode.projectId || null,
    missionId: null,
    delegationId: null,
    causationId: source.episode.id,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID,
  });
  const queuedRequest = semanticSummaryEnrichmentJobRequestSchema.parse({
    ...parsed,
    threadId: source.episode.threadId,
    projectId: source.episode.projectId || null,
    sourceSha256: plan.sourceSha256,
    enrichmentId: plan.enrichmentId,
  });
  return enqueueOperationJob({
    tenantId,
    type: "conversation.summary.enrich",
    dedupeKey: semanticSummaryEnrichmentDedupeKey({
      actorId: usageActorId,
      episodeSummaryId: parsed.episodeSummaryId,
    }),
    payload: {
      request: queuedRequest,
      actorId: usageActorId,
      executionScope: workerScope,
      requestHash: backgroundRequestHash({
        ...queuedRequest,
        actorId: usageActorId,
      }),
      progress: { stage: "queued", shadowOnly: true },
    },
    maxAttempts: 3,
    priority: 0,
    dedupeMode: "coalesce",
  });
}

async function enqueueCurrentKnowledgeCognifyJob({
  tenantId,
  actorId,
  executionScope,
  request: parsed,
}: {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  request: CurrentKnowledgeCognifyJobRequest;
}) {
  const usageActorId = normalizeQueuedActorId(actorId);
  if (!usageActorId) {
    throw new Error("Knowledge cognification requires an owner actor.");
  }
  const trustedExecutionScope = requireQueuedExecutionScope(
    executionScope,
    tenantId,
    usageActorId,
  );
  const cognitionExecutionScope = deriveExecutionScope(trustedExecutionScope, {
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    causationId: parsed.documentId,
    purpose: KNOWLEDGE_COGNIFY_PURPOSE_ID,
  });
  const requestHash = backgroundRequestHash({
    ...parsed,
    actorId: usageActorId,
  });
  const job = await enqueueOperationJob({
    tenantId,
    type: "knowledge.cognify",
    dedupeKey: requestDedupeKey("knowledge.cognify", {
      ...parsed,
      actorId: usageActorId,
    }),
    payload: {
      request: parsed,
      actorId: usageActorId,
      executionScope: cognitionExecutionScope,
      requestHash,
      progress: { stage: "queued", batchIndex: parsed.batchIndex },
    },
    maxAttempts: 3,
    priority: 0,
    requeueTerminal: false,
    requeueFailed: true,
  });
  if (job.payload.actorId !== usageActorId) {
    throw new BackgroundJobIdempotencyConflictError("knowledge.cognify");
  }
  assertIdempotentRequest(job, requestHash, "knowledge.cognify");
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

type BackgroundDeferredResult = CaptureMediaDeferredResult & {
  waitCount?: number;
};

const CAPTURE_ASSET_OBJECT_MAX_WAIT_COUNT = 40;

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
    if (isCaptureMediaDeferredResult(result)) {
      const waiting = await updateOperationJobPayload(
        job.id,
        leaseOwner,
        {
          progress: {
            stage: "waiting",
            reason: result.reason,
            deferredAt: new Date().toISOString(),
            ...("waitCount" in result && typeof result.waitCount === "number"
              ? { waitCount: result.waitCount }
              : {}),
          },
        },
        { tenantId: job.tenantId },
      );
      assertLeaseMutation(waiting, job.id);
      const deferred = await deferOperationJob(job.id, leaseOwner, {
        tenantId: job.tenantId,
        delaySeconds: result.delaySeconds,
        reason: result.reason,
      });
      assertLeaseMutation(deferred, job.id);
      return {
        id: job.id,
        type: job.type,
        status: "queued",
        resourceId: result.resourceId,
      };
    }
    const semanticOutcome = semanticSummaryTerminalOutcome(job, result);
    const updated = await updateOperationJobPayload(
      job.id,
      leaseOwner,
      {
        progress: {
          stage: "completed",
          completedAt: new Date().toISOString(),
          ...(semanticOutcome ? { outcome: semanticOutcome } : {}),
        },
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
    if (job.type === "capture.asset.process" && failed?.status === "failed") {
      await markCaptureAssetProcessFailureSafely(job, error, message);
    } else if (job.type === "capture.asset.process" && !failed) {
      await cleanCanceledCaptureAssetProcessSafely(job);
    }
    if (
      job.type === "capture.media.recording.process" &&
      failed?.status === "failed"
    ) {
      await markCaptureMediaFailureSafely(job, message);
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
  if (
    job.type === "asset.object.commit" ||
    job.type === "asset.object.delete" ||
    job.type === "asset.object.backfill" ||
    job.type === "capture.asset.process" ||
    job.type === "capture.media.segment.transcribe" ||
    job.type === "capture.media.recording.process" ||
    job.type === "knowledge.cognify" ||
    job.type === "market.events.backfill" ||
    job.type === "market.replays.backfill" ||
    job.type === "market.backtest.run" ||
    job.type === "conversation.summary.enrich"
  ) {
    const actorId = typeof job.payload.actorId === "string"
      ? normalizeQueuedActorId(job.payload.actorId)
      : undefined;
    if (!actorId) {
      throw new Error("Owner-bound background job is missing its actor binding.");
    }
    return runWithDatabaseActorScope(job.tenantId, [actorId], () =>
      executeBackgroundOperation(job, abortSignal)
    );
  }
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

async function cleanCanceledCaptureAssetProcessSafely(
  job: OperationJobRecord,
) {
  try {
    const current = await getOperationJob(job.id, { tenantId: job.tenantId });
    if (current?.status !== "canceled") return;
    const parsed = captureAssetProcessJobRequestSchema.safeParse(
      job.payload.request,
    );
    if (!parsed.success) return;
    await deleteKnowledgeDocumentsBySourcePrefix(
      `capture:asset:${parsed.data.assetId}`,
      { tenantId: job.tenantId },
    );
  } catch {
    // Capture deletion performs the same purge. This closes only the race in
    // which a worker loses its lease after beginning an idempotent ingest.
  }
}

async function markCaptureAssetProcessFailureSafely(
  job: OperationJobRecord,
  error: unknown,
  message: string,
) {
  const parsed = captureAssetProcessJobRequestSchema.safeParse(
    job.payload.request,
  );
  const actorId = normalizeQueuedActorId(
    typeof job.payload.actorId === "string" ? job.payload.actorId : undefined,
  );
  if (!parsed.success || !actorId) return;
  try {
    const asset = await getCaptureAsset(parsed.data.assetId, {
      tenantId: job.tenantId,
      actorId,
    });
    if (!asset || asset.ingestJobId !== job.id) return;
    const captureError = error instanceof CaptureFileError ? error : undefined;
    const captureFailureState = captureError?.status === 415
      ? "unsupported"
      : "failed";
    const status = captureError?.status === 415 ? "unsupported" : "failed";
    const extractionStatus = captureError
      ? captureFailureState
      : asset.extractionStatus;
    await updateCaptureAssetStatus(asset.id, {
      tenantId: job.tenantId,
      actorId,
      executionScope: captureIngestMutationExecutionScope(job, actorId),
    }, {
      status,
      extractionStatus,
      ingestJobId: job.id,
      expectedIngestJobId: job.id,
      error: message,
      ...(captureError ? {
        extractionReceipt: terminalCaptureExtractionReceipt({
          format: captureError.format || asset.extension || "unknown",
          state: captureFailureState,
          warningCode: captureError.code,
        }),
      } : {}),
    });
  } catch {
    // The durable operation job remains the failure source if the asset was
    // deleted, superseded, or temporarily unavailable during projection.
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
        extractionStatus: captureAssetExtractionState(parsed.data),
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

async function markCaptureMediaFailureSafely(
  job: OperationJobRecord,
  message: string,
) {
  const actorId = typeof job.payload.actorId === "string"
    ? normalizeQueuedActorId(job.payload.actorId)
    : undefined;
  const request = objectValue(job.payload.request);
  const processing = objectValue(request?.processing);
  const recordingId = typeof processing?.recordingId === "string"
    ? processing.recordingId
    : undefined;
  if (!actorId || !recordingId) return;
  try {
    const source = parsePersistedExecutionScope(job.payload.executionScope);
    if (!source) return;
    assertExecutionScopeTenant(source, job.tenantId);
    if (source.initiatingActorId !== actorId) return;
    const executionScope = deriveExecutionScope(source, {
      executingPrincipalType: "system",
      executingPrincipalId: "background-operations-worker",
      causationId: job.id,
      purpose: "capture.media.processing.failure",
    });
    await runWithDatabaseActorScope(job.tenantId, [actorId], () =>
      markCaptureMediaProcessingStatus(
        recordingId,
        { tenantId: job.tenantId, actorId, executionScope },
        { operationJobId: job.id, status: "failed", error: message },
      )
    );
  } catch {
    // The operation job remains the durable failure source if the media head
    // projection is stale, deleted, or temporarily unavailable.
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
): Promise<Record<string, unknown> | CaptureMediaDeferredResult> {
  abortSignal.throwIfAborted();
  const request = job.payload.request;
  if (job.type === "capture.media.segment.transcribe") {
    return executeCaptureMediaSegmentJob(job, abortSignal);
  }
  if (job.type === "capture.media.recording.process") {
    return executeCaptureMediaProcessingJob(
      job,
      abortSignal,
      async ({ recording, output, executionScope }) => {
        const evidenceRefs = [...new Set([
          output.mediaRevisionId,
          ...output.summary.citations.map((citation) => citation.turnId),
        ])].slice(0, 100);
        return enqueueKnowledgeIngestJob({
          tenantId: job.tenantId,
          actorId: recording.actorId,
          executionScope,
          idempotencyKey: `capture-media:${output.mediaRevisionId}`,
          request: {
            title: recording.title,
            content: renderCaptureMediaKnowledge(output),
            source: recording.source,
            sourceType: "file",
            tags: [...new Set([
              "capture",
              "recording",
              "conversation",
              "diarized",
              ...recording.tags,
            ])].slice(0, 50),
            metadata: {
              captureRecordingId: recording.id,
              mediaRevisionId: output.mediaRevisionId,
              outputSha256: output.outputSha256,
              durationMs: recording.durationMs,
              segmentCount: recording.segmentCount,
              completedAt: recording.completedAt || output.processedAt,
              structuredSourceKind: "audio",
              extractionState: "completed",
            },
            evidenceRefs,
          },
        });
      },
    );
  }
  if (job.type === "asset.object.commit") {
    const object = await commitAssetObjectJob(job, { signal: abortSignal });
    return {
      objectId: object.id,
      objectVersion: object.objectVersion,
      status: object.status,
      contentSha256: object.contentSha256,
      byteCount: object.byteCount,
    };
  }
  if (job.type === "asset.object.delete") {
    const object = await deleteAssetObjectJob(job);
    return "id" in object
      ? {
          objectId: object.id,
          status: object.status,
          scrubbedAt: object.scrubbedAt,
        }
      : object;
  }
  if (job.type === "asset.object.backfill") {
    return executeAssetObjectMigrationJob(job);
  }
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
        detail: "Extracting verified durable outcomes in the background.",
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
    const savedCount = consolidation.saved.length;
    const feedbackExecutionScope = executionScope
      ? deriveExecutionScope(executionScope, {
          executingPrincipalType: "system",
          executingPrincipalId: "background-operations-worker",
          causationId: job.id,
          purpose: "memory.run_feedback.background",
        })
      : createExecutionScope({
          tenantId: job.tenantId,
          initiatingActorId: null,
          executingPrincipalType: "system",
          executingPrincipalId: "background-operations-worker",
          correlationId: job.id,
          causationId: parsed.runId,
          purpose: "memory.run_feedback.background.legacy",
        });
    const feedbackAdjustedMemoryIds = run.feedback
      ? await applyRunMemoryFeedback(run.id, run.feedback.verdict, {
          tenantId: job.tenantId,
          executionScope: feedbackExecutionScope,
        })
      : [];
    await recordRunConsolidation(parsed.runId, {
      count: savedCount,
      error: consolidation.error,
    }, { tenantId: job.tenantId });
    await appendRunEvent(
      parsed.runId,
      {
        type: "memory",
        title: consolidation.error
          ? "evidence-based memory formation failed"
          : savedCount
            ? "evidence-backed memory formed"
            : "no verified effects to retain",
        count: savedCount,
      },
      { tenantId: job.tenantId },
    );
    if (consolidation.error) {
      throw new Error(consolidation.error);
    }
    return {
      resourceId: parsed.runId,
      saved: savedCount,
      ...(episode ? { episodeId: episode.id } : {}),
      feedbackAdjusted: feedbackAdjustedMemoryIds.length,
      skipped: consolidation.skipped,
      error: consolidation.error,
    };
  }

  if (job.type === "capture.asset.process") {
    return executeCaptureAssetProcessJob(job, abortSignal);
  }

  if (job.type === "knowledge.cognify") {
    return executeKnowledgeCognifyJob(job, abortSignal);
  }

  if (job.type === "conversation.summary.enrich") {
    return executeSemanticSummaryEnrichmentJob(job, abortSignal);
  }

  if (job.type === "market.events.backfill") {
    return executeMarketEventBackfillJob({
      job,
      abortSignal,
      onProgress: async (progress) => {
        const updated = await updateOperationJobPayload(
          job.id,
          job.leaseOwner || "",
          { progress },
          { tenantId: job.tenantId },
        );
        assertLeaseMutation(updated, job.id);
      },
    });
  }

  if (job.type === "market.replays.backfill") {
    return executeMarketEventReplayBackfillJob({
      job,
      abortSignal,
      onProgress: async (progress) => {
        const updated = await updateOperationJobPayload(
          job.id,
          job.leaseOwner || "",
          { progress },
          { tenantId: job.tenantId },
        );
        assertLeaseMutation(updated, job.id);
      },
    });
  }

  if (job.type === "market.backtest.run") {
    return executeMarketBacktestJob({
      job,
      abortSignal,
      onProgress: async (progress) => {
        const updated = await updateOperationJobPayload(
          job.id,
          job.leaseOwner || "",
          { progress },
          { tenantId: job.tenantId },
        );
        assertLeaseMutation(updated, job.id);
      },
    });
  }

  if (job.type === "knowledge.ingest") {
    return executeKnowledgeIngestJobRequest(
      job,
      knowledgeIngestJobRequestSchema.parse(request),
      abortSignal,
    );
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

async function executeSemanticSummaryEnrichmentJob(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
): Promise<Record<string, unknown>> {
  const request = semanticSummaryEnrichmentJobRequestSchema.parse(
    job.payload.request,
  );
  const actorId = normalizeQueuedActorId(
    typeof job.payload.actorId === "string" ? job.payload.actorId : undefined,
  );
  if (!actorId) {
    throw new Error("Semantic summary enrichment job is missing its owner actor.");
  }
  const executionScope = parsePersistedExecutionScope(
    job.payload.executionScope,
  );
  if (
    !executionScope ||
    executionScope.tenantId !== job.tenantId ||
    executionScope.initiatingActorId !== actorId ||
    executionScope.executingPrincipalType !== "system" ||
    executionScope.executingPrincipalId !== "background-operations-worker" ||
    executionScope.workspaceId !== null ||
    executionScope.projectId !== request.projectId ||
    executionScope.missionId !== null ||
    executionScope.delegationId !== null ||
    executionScope.causationId !== request.episodeSummaryId ||
    executionScope.contextGrantIds.length !== 0 ||
    executionScope.capabilityGrantIds.length !== 0 ||
    executionScope.purpose !== SEMANTIC_EPISODE_ENRICHMENT_PURPOSE_ID
  ) {
    throw new Error("Semantic summary enrichment job scope is invalid.");
  }

  await updateBackgroundJobProgress(job, abortSignal, {
    stage: "reading_episode",
    shadowOnly: true,
  });
  const source = await readOwnedSemanticEpisodeSource({
    tenantId: job.tenantId,
    actorId,
    episodeSummaryId: request.episodeSummaryId,
  });
  abortSignal.throwIfAborted();
  if (!source) {
    return semanticSummarySupersededResult(
      request,
      "The actor-owned episode is no longer current.",
    );
  }
  if (
    source.episode.threadId !== request.threadId ||
    (source.episode.projectId || null) !== request.projectId ||
    source.episode.sourceSha256 !== request.episodeSourceSha256 ||
    source.episode.summarySha256 !== request.deterministicSummarySha256
  ) {
    return semanticSummarySupersededResult(
      request,
      "The deterministic episode summary changed after this job was queued.",
    );
  }

  const generationId = await resolveSemanticSummaryGenerationId({
    tenantId: job.tenantId,
    actorId,
  });
  abortSignal.throwIfAborted();
  if (generationId !== request.generationId) {
    return semanticSummarySupersededResult(
      request,
      "The Settings memory model route changed after this job was queued.",
    );
  }
  const plan = buildSemanticEpisodeEnrichmentPlan({
    episode: source.episode,
    turns: source.turns,
    generationId,
  });
  if (
    plan.sourceSha256 !== request.sourceSha256 ||
    plan.enrichmentId !== request.enrichmentId
  ) {
    return semanticSummarySupersededResult(
      request,
      "The exact episode source changed after this job was queued.",
    );
  }

  const current = await getCurrentSemanticEnrichment({
    tenantId: job.tenantId,
    actorId,
    enrichmentId: request.enrichmentId,
  });
  abortSignal.throwIfAborted();
  if (current) {
    if (
      current.contract.enrichmentId !== request.enrichmentId ||
      current.contract.episodeSummaryId !== request.episodeSummaryId ||
      current.contract.generationId !== request.generationId ||
      current.contract.sourceSha256 !== request.sourceSha256 ||
      current.contract.episodeSourceSha256 !== request.episodeSourceSha256 ||
      current.contract.deterministicSummarySha256 !==
        request.deterministicSummarySha256
    ) {
      throw new Error(
        "Current semantic summary enrichment does not match its queued plan.",
      );
    }
    return {
      resourceId: current.contract.enrichmentId,
      enrichmentId: current.contract.enrichmentId,
      episodeSummaryId: current.contract.episodeSummaryId,
      generationId: current.contract.generationId,
      sourceSha256: current.contract.sourceSha256,
      enrichmentSha256: current.contract.enrichmentSha256,
      statementCount: current.contract.statements.length,
      status: "already_current",
      shadowOnly: true,
      rankingEffect: "none",
    };
  }

  await updateBackgroundJobProgress(job, abortSignal, {
    stage: "generating_enrichment",
    shadowOnly: true,
  });
  const generationStartedAt = Date.now();
  const enrichment = await enrichConversationEpisode({
    tenantId: job.tenantId,
    actorId,
    episode: source.episode,
    turns: source.turns,
    generationId,
    executionScope,
    correlationId: executionScope.correlationId,
    causationId: executionScope.causationId || undefined,
    abortSignal,
  });
  const generationLatencyMs = Math.max(0, Date.now() - generationStartedAt);
  abortSignal.throwIfAborted();

  await updateBackgroundJobProgress(job, abortSignal, {
    stage: "saving_enrichment",
    shadowOnly: true,
    generationLatencyMs,
  });
  const saved = await saveSemanticEnrichmentFromWorker(enrichment, {
    executionScope,
  });
  abortSignal.throwIfAborted();
  return {
    resourceId: saved.contract.enrichmentId,
    enrichmentId: saved.contract.enrichmentId,
    episodeSummaryId: saved.contract.episodeSummaryId,
    generationId: saved.contract.generationId,
    sourceSha256: saved.contract.sourceSha256,
    enrichmentSha256: saved.contract.enrichmentSha256,
    statementCount: saved.contract.statements.length,
    generationLatencyMs,
    status: "enriched",
    shadowOnly: true,
    rankingEffect: "none",
  };
}

function semanticSummarySupersededResult(
  request: z.infer<typeof semanticSummaryEnrichmentJobRequestSchema>,
  reason: string,
) {
  return {
    resourceId: request.episodeSummaryId,
    episodeSummaryId: request.episodeSummaryId,
    generationId: request.generationId,
    status: "superseded",
    reason,
    shadowOnly: true,
    rankingEffect: "none",
  };
}

function semanticSummaryTerminalOutcome(
  job: OperationJobRecord,
  result: Record<string, unknown>,
) {
  if (job.type !== "conversation.summary.enrich") return undefined;
  return result.status === "enriched" ||
      result.status === "already_current" ||
      result.status === "superseded"
    ? result.status
    : undefined;
}

async function executeKnowledgeCognifyJob(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
): Promise<Record<string, unknown>> {
  const request = knowledgeCognifyJobRequestSchema.parse(job.payload.request);
  const actorId = normalizeQueuedActorId(
    typeof job.payload.actorId === "string" ? job.payload.actorId : undefined,
  );
  if (!actorId) {
    throw new Error("Knowledge cognification job is missing its owner actor.");
  }
  const executionScope = parsePersistedExecutionScope(
    job.payload.executionScope,
  );
  if (
    !executionScope ||
    executionScope.tenantId !== job.tenantId ||
    executionScope.initiatingActorId !== actorId ||
    executionScope.purpose !== KNOWLEDGE_COGNIFY_PURPOSE_ID
  ) {
    throw new Error("Knowledge cognification job scope is invalid.");
  }

  await updateBackgroundJobProgress(job, abortSignal, {
    stage: "reading_evidence",
    batchIndex: request.batchIndex,
  });
  const source = await getActorOwnedKnowledgeForCognition({
    tenantId: job.tenantId,
    actorId,
    documentId: request.documentId,
  });
  abortSignal.throwIfAborted();
  if (!source || source.sourceRevisionId !== request.sourceRevisionId) {
    return {
      resourceId: request.documentId,
      documentId: request.documentId,
      sourceRevisionId: request.sourceRevisionId,
      status: "superseded",
      reason: "The actor-owned source revision is no longer current or eligible.",
    };
  }

  const document = cognitionDocument(source);
  const chunks = cognitionChunks(source);
  const batches = partitionCognificationBatches({
    document,
    chunks,
    ...(request.generationId
      ? { generationId: request.generationId }
      : {}),
  });
  const sourcePlanSha256 = cognitionSourcePlanSha256(
    document,
    batches,
    request.generationId,
  );
  if (
    (request.sourcePlanSha256 &&
      request.sourcePlanSha256 !== sourcePlanSha256) ||
    (request.retentionExpiresAt !== undefined &&
      request.retentionExpiresAt !== document.retentionExpiresAt)
  ) {
    return {
      resourceId: request.documentId,
      documentId: request.documentId,
      sourceRevisionId: request.sourceRevisionId,
      status: "superseded",
      reason: "The source cognition plan changed after this job was queued.",
    };
  }
  if (!batches[request.batchIndex]) {
    throw new Error("Knowledge cognition batch is outside the current source plan.");
  }

  const batch = batches[request.batchIndex];
  let saved = await getKnowledgeCognition(batch.batchId, {
    tenantId: job.tenantId,
    actorId,
  });
  if (saved) {
    assertPersistedCognitionMatchesPlan(saved, batch, document);
    await updateBackgroundJobProgress(job, abortSignal, {
      stage: "resuming_persisted_review",
      batchIndex: request.batchIndex,
      batchCount: batches.length,
    });
  } else {
    await updateBackgroundJobProgress(job, abortSignal, {
      stage: "extracting_candidates",
      batchIndex: request.batchIndex,
      batchCount: batches.length,
    });
    const candidate = await cognifyKnowledgeBatch({
      tenantId: job.tenantId,
      actorId,
      document,
      chunks,
      batchIndex: request.batchIndex,
      ...(request.generationId
        ? { generationId: request.generationId }
        : {}),
      executionScope,
      abortSignal,
    });
    abortSignal.throwIfAborted();

    await updateBackgroundJobProgress(job, abortSignal, {
      stage: "saving_review",
      batchIndex: request.batchIndex,
      batchCount: batches.length,
    });
    saved = await saveKnowledgeCognitionFromBackgroundWorker(candidate, {
      executionScope,
    });
  }
  const nextBatchIndex = request.batchIndex + 1;
  const nextJob = nextBatchIndex < batches.length
    ? await enqueueKnowledgeCognifyJob({
        tenantId: job.tenantId,
        actorId,
        executionScope,
        request: {
          documentId: request.documentId,
          sourceRevisionId: request.sourceRevisionId,
          ...(request.generationId
            ? { generationId: request.generationId }
            : {}),
          retentionExpiresAt: document.retentionExpiresAt,
          sourcePlanSha256,
          batchIndex: nextBatchIndex,
        },
      })
    : undefined;
  return {
    resourceId: saved.candidate.batchId,
    cognitionId: saved.candidate.batchId,
    documentId: request.documentId,
    sourceRevisionId: request.sourceRevisionId,
    batchIndex: request.batchIndex,
    batchCount: batches.length,
    status: saved.status,
    ...(nextJob ? { nextJobId: nextJob.id } : {}),
  };
}

function cognitionDocument(source: ActorOwnedCognitionSource) {
  return {
    id: source.document.id,
    title: source.document.title,
    sourceItemId: source.sourceItemId,
    sourceRevisionId: source.sourceRevisionId,
    retentionExpiresAt: source.retentionExpiresAt,
  };
}

function cognitionChunks(source: ActorOwnedCognitionSource) {
  return source.chunks.map((chunk) => {
    if (!chunk.evidenceUnitId) {
      throw new Error("Knowledge cognition source is missing canonical evidence.");
    }
    return {
      id: chunk.id,
      index: chunk.chunkIndex,
      content: chunk.content,
      evidenceUnitId: chunk.evidenceUnitId,
    };
  });
}

function cognitionSourcePlanSha256(
  document: ReturnType<typeof cognitionDocument>,
  batches: readonly CognificationBatchPlan[],
  generationId?: string,
) {
  return sourceContractSha256({
    schemaVersion: 1,
    documentId: document.id,
    sourceItemId: document.sourceItemId,
    sourceRevisionId: document.sourceRevisionId,
    ...(generationId ? { generationId } : {}),
    retentionExpiresAt: document.retentionExpiresAt,
    batches: batches.map((batch) => ({
      batchId: batch.batchId,
      batchIndex: batch.batchIndex,
      batchInputSha256: batch.batchInputSha256,
      evidenceUnitIds: [...batch.evidenceUnitIds],
    })),
  });
}

function assertPersistedCognitionMatchesPlan(
  record: KnowledgeCognitionRecord,
  batch: CognificationBatchPlan,
  document: {
    id: string;
    sourceItemId: string;
    sourceRevisionId: string;
    retentionExpiresAt: string | null;
  },
) {
  const candidate = record.candidate;
  if (
    candidate.documentId !== document.id ||
    candidate.sourceItemId !== document.sourceItemId ||
    candidate.sourceRevisionId !== document.sourceRevisionId ||
    candidate.generationId !== batch.generationId ||
    candidate.retentionExpiresAt !== document.retentionExpiresAt ||
    candidate.batchId !== batch.batchId ||
    candidate.batchIndex !== batch.batchIndex ||
    candidate.batchCount !== batch.batchCount ||
    candidate.firstChunkIndex !== batch.firstChunkIndex ||
    candidate.lastChunkIndex !== batch.lastChunkIndex ||
    candidate.chunkCount !== batch.chunkCount ||
    candidate.inputCharacterCount !== batch.inputCharacterCount ||
    candidate.batchInputSha256 !== batch.batchInputSha256 ||
    candidate.evidenceUnitIds.length !== batch.evidenceUnitIds.length ||
    candidate.evidenceUnitIds.some((id, index) =>
      id !== batch.evidenceUnitIds[index]
    )
  ) {
    throw new Error(
      "Persisted knowledge cognition does not match the current source plan.",
    );
  }
}

async function executeCaptureAssetProcessJob(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
): Promise<Record<string, unknown> | BackgroundDeferredResult> {
  const request = captureAssetProcessJobRequestSchema.parse(job.payload.request);
  const actorId = normalizeQueuedActorId(
    typeof job.payload.actorId === "string" ? job.payload.actorId : undefined,
  );
  if (!actorId) {
    throw new Error("Capture asset processing job is missing its owner actor.");
  }
  const sourceExecutionScope = knowledgeIngestSourceExecutionScope(
    job,
    actorId,
    true,
  );
  const asset = await getCaptureAsset(request.assetId, {
    tenantId: job.tenantId,
    actorId,
  });
  if (!asset) {
    throw new Error("Capture asset processing source was not found.");
  }
  if (!asset.ingestJobId && asset.status === "stored") {
    const waitCount = captureAssetObjectWaitCount(job) + 1;
    if (waitCount <= CAPTURE_ASSET_OBJECT_MAX_WAIT_COUNT) {
      return {
        __deferOperation: true,
        delaySeconds: 2,
        reason: "Capture source is still being linked to its processing job.",
        resourceId: request.assetId,
        waitCount,
      };
    }
  }
  if (asset.ingestJobId !== job.id) {
    throw new Error("Capture asset processing job is no longer the active source mutation.");
  }

  await updateBackgroundJobProgress(job, abortSignal, { stage: "reading" });
  let bytes: Uint8Array;
  try {
    ({ bytes } = await getCaptureAssetContent(request.assetId, {
      tenantId: job.tenantId,
      actorId,
    }));
  } catch (error) {
    if (!(error instanceof CaptureAssetContentNotReadyError)) throw error;
    const waitCount = captureAssetObjectWaitCount(job) + 1;
    if (waitCount > CAPTURE_ASSET_OBJECT_MAX_WAIT_COUNT) {
      throw new Error("Captured file content did not become ready for processing.");
    }
    return {
      __deferOperation: true,
      delaySeconds: 15,
      reason: "Private source bytes are still being verified.",
      resourceId: request.assetId,
      waitCount,
    };
  }

  abortSignal.throwIfAborted();
  await updateBackgroundJobProgress(job, abortSignal, { stage: "extracting" });
  let title = request.title || captureTitle(asset.filename);
  let content = "";
  let contentOrigin: "extracted" | "supplied_note" = "extracted";
  let extractionReceipt: CaptureExtractionReceipt | undefined;
  let structuredUnits: CaptureExtractionUnit[] | undefined;
  try {
    const extracted = await extractCaptureFile(
      new File([Uint8Array.from(bytes)], asset.filename, {
        type: asset.mediaType,
      }),
      {
        tenantId: job.tenantId,
        actorId,
        sourceStreamId: `capture-asset:${asset.id}`,
        operation: "ocr",
        purpose: "capture.file.extract.background",
        correlationId: sourceExecutionScope.correlationId,
        causationId: job.id,
        executionScope: sourceExecutionScope,
        credentialSource: "deployment_environment",
      },
    );
    title = request.title || extracted.title;
    const extraction = request.note
      ? appendCaptureNote(extracted.extraction, request.note)
      : extracted.extraction;
    structuredUnits = extraction.units;
    content = renderCaptureExtractionUnits(extraction.units);
    extractionReceipt = captureExtractionReceipt(extraction);
  } catch (error) {
    if (!request.note || !(error instanceof CaptureFileError)) throw error;
    contentOrigin = "supplied_note";
    content = request.note;
    extractionReceipt = terminalCaptureExtractionReceipt({
      format: error.format || asset.extension || "unknown",
      state: error.status === 415 ? "unsupported" : "failed",
      warningCode: error.code,
    });
  }

  await updateCaptureAssetStatus(asset.id, {
    tenantId: job.tenantId,
    actorId,
    executionScope: captureIngestMutationExecutionScope(job, actorId),
  }, {
    status: "queued",
    extractionStatus: extractionReceipt.state,
    ingestJobId: job.id,
    expectedIngestJobId: job.id,
    extractionReceipt,
  });

  const ingestRequest = knowledgeIngestJobRequestSchema.parse({
    title,
    content,
    source: `capture:asset:${asset.id}`,
    sourceType: "file",
    tags: [...new Set([
      "capture",
      "asset",
      ...asset.tags,
      ...(request.tags || []),
    ])].slice(0, 50),
    metadata: {
      captureAssetId: asset.id,
      actorId: asset.actorId,
      filename: asset.filename,
      mediaType: asset.mediaType,
      byteCount: asset.byteCount,
      contentOrigin,
      structuredSourceKind: extractionReceipt?.sourceKind || "file",
      extractionState: extractionReceipt?.state || "completed",
      extractionReceiptSha256: extractionReceipt?.receiptSha256 || "",
    },
    evidenceRefs: [`capture-asset:${asset.id}`],
    ...(structuredUnits ? { structuredUnits } : {}),
  });
  return executeKnowledgeIngestJobRequest(job, ingestRequest, abortSignal, {
    assetExtractionReceipt: extractionReceipt,
  });
}

async function executeKnowledgeIngestJobRequest(
  job: OperationJobRecord,
  parsed: KnowledgeIngestJobRequest,
  abortSignal: AbortSignal,
  options: { assetExtractionReceipt?: CaptureExtractionReceipt } = {},
) {
  const captureTarget = captureIngestTarget(parsed);
  const actorId = await resolveKnowledgeIngestActorId(job, parsed);
  const sourceExecutionScope = knowledgeIngestSourceExecutionScope(
    job,
    actorId,
    Boolean(captureTarget),
  );
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
  const ingestRequest: Parameters<typeof ingestTextDocument>[0] = {
    ...parsed,
    tenantId: job.tenantId,
    idempotencyKey: job.id,
    abortSignal,
    executionScope: sourceExecutionScope,
    onProgress: (progress) =>
      updateBackgroundJobProgress(job, abortSignal, progress),
    ...(actorId ? {
      usageScope: {
        tenantId: job.tenantId,
        actorId,
        sourceStreamId: `operation-job:${job.id}`,
        operation: "embedding" as const,
        purpose: "knowledge.ingest.background",
        correlationId: sourceExecutionScope.correlationId || job.id,
        causationId: sourceExecutionScope.causationId || undefined,
        executionScope: sourceExecutionScope,
        credentialSource: "deployment_environment" as const,
      },
    } : {}),
    ...(actorId
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
              ? captureStructuredSourceKind(parsed)
              : canonicalSourceKind(parsed.sourceType),
            ...(captureTarget ? {
              visibility: "user_private" as const,
              sensitivity: "confidential" as const,
              permissionGrantIds: ["first_party.capture"],
              allowedPurposeIds: [
                CLAIM_EVIDENCE_PURPOSE_ID,
                CONTEXT_COMPILER_V2_PURPOSE_ID,
                KNOWLEDGE_COGNIFY_PURPOSE_ID,
              ].sort(),
              retentionPolicyId: "retention.capture.owner-controlled",
              extractorId: parsed.structuredUnits?.length
                ? CAPTURE_STRUCTURED_EXTRACTOR_ID
                : undefined,
              extractorVersionId: parsed.structuredUnits?.length
                ? CAPTURE_STRUCTURED_EXTRACTOR_VERSION
                : undefined,
              extractorConfigSha256: parsed.structuredUnits?.length
                ? CAPTURE_STRUCTURED_EXTRACTOR_CONFIG_SHA256
                : undefined,
            } : {}),
          },
        }
      : {}),
    captureIngestGuard,
  };
  const result = actorId
    ? await runWithDatabaseActorScope(job.tenantId, [actorId], () =>
        ingestTextDocument(ingestRequest)
      )
    : await ingestTextDocument(ingestRequest);
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
          extractionStatus: captureAssetExtractionState(parsed),
          ingestJobId: job.id,
          expectedIngestJobId: job.id,
          knowledgeDocumentId: result.document.id,
          extractionReceipt: options.assetExtractionReceipt,
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
      if (captureTarget?.assetId) {
        await handleCaptureAssetCompletionProjectionFailure({
          assetId: captureTarget.assetId,
          tenantId: job.tenantId,
          actorId,
          ingestJobId: job.id,
          knowledgeDocumentId: result.document.id,
        });
      }
      // Recording completion remains a convenience projection. Asset
      // completion is stricter because the asset is the durable progress
      // surface used to reconcile an otherwise completed indexing job.
    }
  }
  let cognition: Record<string, unknown> = { status: "not_eligible" };
  if (actorId && result.document.sourceRevisionId) {
    try {
      const cognitionJob = await enqueueKnowledgeCognificationPlan({
        tenantId: job.tenantId,
        actorId,
        executionScope: sourceExecutionScope,
        documentId: result.document.id,
        sourceRevisionId: result.document.sourceRevisionId,
      });
      cognition = {
        status: !cognitionJob || cognitionJob.status === "completed"
          ? "already_processed"
          : "queued",
        ...(cognitionJob ? { jobId: cognitionJob.id } : {}),
      };
    } catch {
      // Source indexing is canonical and must not be rolled back because its
      // optional semantic proposal stage could not be queued.
      cognition = { status: "queue_failed" };
    }
  }
  return {
    resourceId: result.document.id,
    documentId: result.document.id,
    chunkCount: result.chunks.length,
    memoryCount: result.memories.length,
    retiredDocumentCount: result.retired.documents,
    retiredMemoryCount: result.retired.memories,
    cognition,
  };
}

async function handleCaptureAssetCompletionProjectionFailure(input: {
  assetId: string;
  tenantId: string;
  actorId: string;
  ingestJobId: string;
  knowledgeDocumentId: string;
}) {
  let current: Awaited<ReturnType<typeof getCaptureAsset>>;
  try {
    current = await getCaptureAsset(input.assetId, {
      tenantId: input.tenantId,
      actorId: input.actorId,
    });
  } catch {
    throw new Error("Capture asset completion projection could not be finalized.");
  }
  assertCaptureAssetCompletionProjectionFailureIsResolved(
    current,
    input.ingestJobId,
    input.knowledgeDocumentId,
  );
}

export function assertCaptureAssetCompletionProjectionFailureIsResolved(
  current: {
    status?: string;
    ingestJobId?: string;
    knowledgeDocumentId?: string;
  } | null | undefined,
  ingestJobId: string,
  knowledgeDocumentId: string,
) {
  if (!current || current.ingestJobId !== ingestJobId) return;
  if (
    current.status === "indexed" &&
    current.knowledgeDocumentId === knowledgeDocumentId
  ) return;
  throw new Error("Capture asset completion projection could not be finalized.");
}

async function updateBackgroundJobProgress(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
  progress: Record<string, unknown>,
) {
  abortSignal.throwIfAborted();
  const updated = await updateOperationJobPayload(
    job.id,
    job.leaseOwner || "",
    { progress },
    { tenantId: job.tenantId },
  );
  assertLeaseMutation(updated, job.id);
}

function captureAssetObjectWaitCount(job: OperationJobRecord) {
  const progress = objectValue(job.payload.progress);
  const value = Number(progress?.waitCount || 0);
  return Number.isInteger(value) && value >= 0
    ? Math.min(value, CAPTURE_ASSET_OBJECT_MAX_WAIT_COUNT)
    : 0;
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
  type: "capture.asset.process" | "knowledge.ingest" | "knowledge.cognify" | "evaluation.run",
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

function semanticSummaryEnrichmentDedupeKey(input: {
  actorId: string;
  episodeSummaryId: string;
}) {
  return `conversation.summary.enrich:${sourceContractSha256({
    schemaVersion: 1,
    actorId: input.actorId,
    episodeSummaryId: input.episodeSummaryId,
  }).slice(0, 48)}`;
}

function assertIdempotentRequest(
  job: OperationJobRecord,
  requestHash: string,
  type: "capture.asset.process" | "knowledge.ingest" | "knowledge.cognify" | "evaluation.run",
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
  actorId: string | undefined,
  captureSource: boolean,
) {
  const persisted = parsePersistedExecutionScope(job.payload.executionScope);
  if (persisted) {
    assertExecutionScopeTenant(persisted, job.tenantId);
    if (actorId && persisted.initiatingActorId !== actorId) {
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
    initiatingActorId: actorId || null,
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

function captureStructuredSourceKind(
  request: KnowledgeIngestJobRequest,
): SourceItemV1["sourceKind"] {
  const candidate = request.metadata?.structuredSourceKind;
  if (
    typeof candidate === "string" &&
    [
      "document",
      "spreadsheet",
      "presentation",
      "email",
      "calendar_event",
      "image",
      "audio",
      "video",
      "record",
      "file",
      "capture",
    ].includes(candidate)
  ) {
    return candidate as SourceItemV1["sourceKind"];
  }
  return "capture" as const;
}

function captureAssetExtractionState(
  request: KnowledgeIngestJobRequest,
): "completed" | "partial" | "unsupported" | "failed" {
  const state = request.metadata?.extractionState;
  return state === "partial" || state === "unsupported" || state === "failed"
    ? state
    : "completed";
}

function normalizeQueuedContent(value: string) {
  return value
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
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
