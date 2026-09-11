import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getOperationJob,
  projectOperationJobStatus,
} from "@/lib/operations/job-queue";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);

const ACTOR_OWNED_OPERATION_JOB_TYPES = new Set([
  "asset.object.commit",
  "asset.object.delete",
  "asset.object.backfill",
  "capture.asset.process",
  "capture.media.segment.transcribe",
  "capture.media.recording.process",
  "knowledge.cognify",
  "conversation.summary.enrich",
]);

const PUBLIC_SEMANTIC_SUMMARY_STAGES = new Set([
  "queued",
  "processing",
  "reading_episode",
  "generating_enrichment",
  "saving_enrichment",
  "completed",
]);

async function GETHandler(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  let securityContext;
  try {
    securityContext = await authorizeRequest({
      request,
      action: "read",
      resourceType: "operation_job",
      resourceId: id,
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const job = await getOperationJob(id, {
    tenantId: securityContext.tenantId,
  });
  if (!job) {
    return Response.json({ error: "Operation job not found." }, { status: 404 });
  }
  const ownerActorId = typeof job.payload.actorId === "string"
    ? job.payload.actorId.trim()
    : "";
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    securityContext,
  );
  const readableOwnerActorIds = new Set([
    securityContext.actorId,
    ...(actorBinding?.readableOwnerActorIds || []),
  ]);
  if (
    (ACTOR_OWNED_OPERATION_JOB_TYPES.has(job.type) && !ownerActorId) ||
    (ownerActorId && !readableOwnerActorIds.has(ownerActorId))
  ) {
    return Response.json(
      { error: "Operation job not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  const projectedJob = projectOperationJobStatus(job);
  return Response.json(
    {
      job: job.type === "conversation.summary.enrich"
        ? projectSemanticSummaryJobStatus(projectedJob)
        : projectedJob,
    },
    { headers: { "cache-control": "private, no-store" } },
  );
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
  return {
    stage,
    shadowOnly: true,
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
