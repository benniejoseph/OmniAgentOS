import {
  projectOperationJobStatus,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";

const ACTOR_OWNED_OPERATION_JOB_TYPES = new Set([
  "asset.object.commit",
  "asset.object.delete",
  "asset.object.backfill",
  "capture.asset.process",
  "capture.media.segment.transcribe",
  "capture.media.recording.process",
  "knowledge.cognify",
  "conversation.summary.enrich",
  "market.events.backfill",
  "market.replays.backfill",
  "market.backtest.run",
]);

const PUBLIC_SEMANTIC_SUMMARY_STAGES = new Set([
  "queued",
  "processing",
  "reading_episode",
  "generating_enrichment",
  "saving_enrichment",
  "completed",
]);

const PUBLIC_SEMANTIC_SUMMARY_OUTCOMES = new Set([
  "enriched",
  "already_current",
  "superseded",
]);

/**
 * Applies the same owner boundary to singular and bulk job reads. Returning
 * null intentionally makes an unauthorized actor-owned job indistinguishable
 * from a missing job.
 */
export function projectReadableOperationJob(
  job: OperationJobRecord,
  readableOwnerActorIds: ReadonlySet<string>,
) {
  const ownerActorId = typeof job.payload.actorId === "string"
    ? job.payload.actorId.trim()
    : "";
  if (
    (ACTOR_OWNED_OPERATION_JOB_TYPES.has(job.type) && !ownerActorId) ||
    (ownerActorId && !readableOwnerActorIds.has(ownerActorId))
  ) {
    return null;
  }

  const projectedJob = projectOperationJobStatus(job);
  return job.type === "conversation.summary.enrich"
    ? projectSemanticSummaryJobStatus(projectedJob)
    : projectedJob;
}

function projectSemanticSummaryJobStatus(
  job: ReturnType<typeof projectOperationJobStatus>,
) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: projectSemanticSummaryProgress(job.progress),
    priority: job.priority,
    attempt: job.attempt,
    maxAttempts: job.maxAttempts,
    runAt: job.runAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt,
    ...(job.status === "failed"
      ? { failureCode: "semantic_enrichment_failed" }
      : {}),
  };
}

function projectSemanticSummaryProgress(
  progress: Record<string, unknown> | undefined,
) {
  const stage = typeof progress?.stage === "string"
    ? publicSemanticSummaryStage(progress.stage)
    : "pending";
  const statementCount = safeCount(progress?.statementCount);
  const sourceTurnCount = safeCount(progress?.sourceTurnCount);
  const outcome = typeof progress?.outcome === "string" &&
      PUBLIC_SEMANTIC_SUMMARY_OUTCOMES.has(progress.outcome)
    ? progress.outcome
    : undefined;
  return {
    stage,
    shadowOnly: true,
    ...(outcome ? { outcome } : {}),
    ...(statementCount === undefined ? {} : { statementCount }),
    ...(sourceTurnCount === undefined ? {} : { sourceTurnCount }),
  };
}

function publicSemanticSummaryStage(value: string) {
  const stage = value.trim();
  return PUBLIC_SEMANTIC_SUMMARY_STAGES.has(stage) ? stage : "pending";
}

function safeCount(value: unknown) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 10_000)
    : undefined;
}
