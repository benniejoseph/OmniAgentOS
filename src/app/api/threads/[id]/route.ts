import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { enqueueSemanticSummaryEnrichmentJob } from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import {
  listCurrentSemanticEnrichments,
  SemanticSummaryStaleSourceError,
} from "@/lib/threads/semantic-summary-store";
import {
  resolveSemanticSummaryGenerationId,
  SEMANTIC_EPISODE_ENRICHMENT_TURN_COUNT,
} from "@/lib/threads/semantic-summaries";
import {
  getOwnedThread,
  listConversationSummaries,
  listThreadTurns,
  rebuildConversationSummaryHierarchy,
} from "@/lib/threads/store";
import type { ConversationSummaryRecord } from "@/lib/threads/summaries";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const rebuildSchema = z.object({
  action: z.literal("rebuild_summaries"),
}).strict();

const enqueueSemanticSummariesSchema = z.object({
  action: z.literal("enqueue_semantic_summaries"),
  limit: z.number().int().min(1).max(25).default(8),
}).strict();

const threadActionSchema = z.discriminatedUnion("action", [
  rebuildSchema,
  enqueueSemanticSummariesSchema,
]);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

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

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try { context = await authorizeRequest({ request, action: "read", resourceType: "thread", resourceId: id }); }
  catch (error) { return forbiddenResponse(error); }
  const thread = await getOwnedThread(id, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  if (!thread) {
    return Response.json(
      { error: "Thread not found." },
      { status: 404, headers: { "cache-control": "private, no-store" } },
    );
  }
  return Response.json({
    thread,
    turns: await listThreadTurns(thread.id, {
      tenantId: context.tenantId,
      limit: 40,
    }),
    summaries: (
      await listConversationSummaries(thread.id, {
        tenantId: context.tenantId,
        levels: ["episode"],
        limit: 100,
      })
    ).map(publicConversationSummary),
  }, { headers: { "cache-control": "private, no-store" } });
}

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = threadActionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid thread summary action", details: parsed.error.flatten() },
      { status: 400, headers: { "cache-control": "private, no-store" } },
    );
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "conversation_summary",
      resourceId: id,
      metadata: {
        action: parsed.data.action,
        limit: parsed.data.action === "enqueue_semantic_summaries"
          ? parsed.data.limit
          : null,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const thread = await getOwnedThread(id, {
    tenantId: context.tenantId,
    actorId: context.actorId,
    requestActorBinding: canonicalRequestActorBindingFromSecurityContext(context),
  });
  if (!thread) {
    return Response.json(
      { error: "Thread not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  if (parsed.data.action === "enqueue_semantic_summaries") {
    return enqueueSemanticSummaries({
      context,
      thread,
      limit: parsed.data.limit,
    });
  }
  const summaries = await rebuildConversationSummaryHierarchy(thread.id, {
    tenantId: context.tenantId,
    actorId: thread.actorId,
  });
  return Response.json({
    summaries: summaries.map(publicConversationSummary),
    summaryCount: summaries.length,
  }, { headers: privateNoStoreHeaders });
}

async function enqueueSemanticSummaries(input: {
  context: Awaited<ReturnType<typeof authorizeRequest>>;
  thread: NonNullable<Awaited<ReturnType<typeof getOwnedThread>>>;
  limit: number;
}) {
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    input.context,
  );
  if (!actorBinding) {
    return Response.json({
      error:
        "Semantic summary enrichment requires a canonical signed-in user.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }

  const summaries = await listConversationSummaries(input.thread.id, {
    tenantId: input.context.tenantId,
    levels: ["episode"],
    limit: 500,
  });
  const eligibleEpisodes = summaries
    .filter((summary) => isEligibleSemanticEpisode({
      summary,
      tenantId: input.context.tenantId,
      threadId: input.thread.id,
      projectId: input.thread.projectId || null,
      readableOwnerActorIds: actorBinding.readableOwnerActorIds,
    }));

  if (!eligibleEpisodes.length) {
    return deterministicSummaryResponse({
      semanticStatus: "waiting_for_sealed_episode",
      eligibleEpisodeCount: 0,
      message:
        "Deterministic summaries are active. Semantic enrichment starts after a complete 12-turn episode is available.",
    });
  }

  const generationByActor = new Map<string, string>();
  try {
    for (const actorId of new Set(
      eligibleEpisodes.map((summary) => summary.actorId),
    )) {
      generationByActor.set(actorId, await resolveSemanticSummaryGenerationId({
        tenantId: input.context.tenantId,
        actorId,
      }));
    }
  } catch (error) {
    if (!isSemanticSummaryModelUnconfigured(error)) throw error;
    return deterministicSummaryResponse({
      semanticStatus: "not_configured",
      eligibleEpisodeCount: eligibleEpisodes.length,
      message:
        "Deterministic summaries remain active. Configure the Memory model in Settings to enable optional semantic enrichment.",
    });
  }

  const currentEnrichmentKeys = new Set<string>();
  for (const actorId of generationByActor.keys()) {
    const current = await listCurrentSemanticEnrichments({
      tenantId: input.context.tenantId,
      actorId,
      threadId: input.thread.id,
      limit: 500,
    });
    for (const record of current) {
      currentEnrichmentKeys.add(semanticEpisodeKey({
        episodeSummaryId: record.contract.episodeSummaryId,
        episodeSourceSha256: record.contract.episodeSourceSha256,
        deterministicSummarySha256:
          record.contract.deterministicSummarySha256,
        generationId: record.contract.generationId,
      }));
    }
  }

  const correlationId = `conversation_summary_enrichment_${randomUUID()}`;
  const queued = [];
  let upToDateCount = 0;
  let staleEpisodeCount = 0;
  let skippedEpisodeCount = 0;
  const pendingEpisodes = eligibleEpisodes.filter((episode) => {
    const generationId = generationByActor.get(episode.actorId)!;
    const current = currentEnrichmentKeys.has(semanticEpisodeKey({
      episodeSummaryId: episode.id,
      episodeSourceSha256: episode.sourceSha256,
      deterministicSummarySha256: episode.summarySha256,
      generationId,
    }));
    if (current) upToDateCount += 1;
    return !current;
  });
  for (const episode of pendingEpisodes.slice(0, input.limit)) {
    const generationId = generationByActor.get(episode.actorId)!;
    const request = {
      episodeSummaryId: episode.id,
      episodeSourceSha256: episode.sourceSha256,
      deterministicSummarySha256: episode.summarySha256,
      generationId,
    };
    try {
      const job = await enqueueSemanticSummaryEnrichmentJob({
        tenantId: input.context.tenantId,
        actorId: episode.actorId,
        executionScope: createExecutionScope({
          tenantId: input.context.tenantId,
          initiatingActorId: episode.actorId,
          executingPrincipalType: "user",
          executingPrincipalId: episode.actorId,
          workspaceId: null,
          projectId: episode.projectId || null,
          missionId: null,
          delegationId: null,
          correlationId,
          causationId: episode.id,
          purpose: "conversation.summary.enrich.queue",
        }),
        request,
      });
      if (job) queued.push(publicSemanticSummaryJob(job));
      else staleEpisodeCount += 1;
    } catch (error) {
      if (error instanceof SemanticSummaryStaleSourceError) {
        skippedEpisodeCount += 1;
        continue;
      }
      throw error;
    }
  }

  const activeJobCount = queued.filter((job) =>
    job.status === "queued" || job.status === "running"
  ).length;
  return Response.json({
    deterministicSummariesActive: true,
    semanticEnrichment: {
      status: activeJobCount
        ? "queued"
        : staleEpisodeCount || skippedEpisodeCount
          ? "source_changed"
          : "up_to_date",
      shadowOnly: true,
    },
    jobs: queued,
    eligibleEpisodeCount: eligibleEpisodes.length,
    queuedJobCount: activeJobCount,
    upToDateCount,
    staleEpisodeCount,
    skippedEpisodeCount,
    remainingEpisodeCount: Math.max(0, pendingEpisodes.length - input.limit),
  }, {
    status: activeJobCount ? 202 : 200,
    headers: privateNoStoreHeaders,
  });
}

function deterministicSummaryResponse(input: {
  semanticStatus: "not_configured" | "waiting_for_sealed_episode";
  eligibleEpisodeCount: number;
  message: string;
}) {
  return Response.json({
    deterministicSummariesActive: true,
    semanticEnrichment: {
      status: input.semanticStatus,
      shadowOnly: true,
    },
    jobs: [],
    eligibleEpisodeCount: input.eligibleEpisodeCount,
    queuedJobCount: 0,
    upToDateCount: 0,
    staleEpisodeCount: 0,
    skippedEpisodeCount: 0,
    remainingEpisodeCount: 0,
    message: input.message,
  }, { headers: privateNoStoreHeaders });
}

function isEligibleSemanticEpisode(input: {
  summary: ConversationSummaryRecord;
  tenantId: string;
  threadId: string;
  projectId: string | null;
  readableOwnerActorIds: readonly string[];
}) {
  const summary = input.summary;
  return summary.level === "episode" &&
    summary.tenantId === input.tenantId &&
    summary.threadId === input.threadId &&
    (summary.projectId || null) === input.projectId &&
    input.readableOwnerActorIds.includes(summary.actorId) &&
    summary.rebuildable === true &&
    summary.sourceTurnIds.length === SEMANTIC_EPISODE_ENRICHMENT_TURN_COUNT &&
    summary.childSummaryIds.length === SEMANTIC_EPISODE_ENRICHMENT_TURN_COUNT &&
    new Set(summary.sourceTurnIds).size === summary.sourceTurnIds.length;
}

function semanticEpisodeKey(input: {
  episodeSummaryId: string;
  episodeSourceSha256: string;
  deterministicSummarySha256: string;
  generationId: string;
}) {
  return [
    input.episodeSummaryId,
    input.episodeSourceSha256,
    input.deterministicSummarySha256,
    input.generationId,
  ].join("\u0000");
}

function publicSemanticSummaryJob(
  job: Parameters<typeof projectOperationJobStatus>[0],
) {
  const projected = projectOperationJobStatus(job);
  const stage = typeof projected.progress?.stage === "string"
    ? publicSemanticSummaryStage(projected.progress.stage)
    : "pending";
  const outcome = publicSemanticSummaryOutcome(projected.progress?.outcome);
  return {
    id: projected.id,
    type: projected.type,
    status: projected.status,
    progress: {
      stage,
      shadowOnly: true,
      ...(outcome ? { outcome } : {}),
    },
    attempt: projected.attempt,
    maxAttempts: projected.maxAttempts,
    runAt: projected.runAt,
    createdAt: projected.createdAt,
    updatedAt: projected.updatedAt,
    completedAt: projected.completedAt,
    ...(projected.status === "failed"
      ? { failureCode: "semantic_enrichment_failed" }
      : {}),
    statusUrl: `/api/operations/jobs/${encodeURIComponent(projected.id)}`,
  };
}

function publicSemanticSummaryStage(value: string) {
  const stage = value.trim();
  return PUBLIC_SEMANTIC_SUMMARY_STAGES.has(stage) ? stage : "pending";
}

function publicSemanticSummaryOutcome(value: unknown) {
  return typeof value === "string" &&
      PUBLIC_SEMANTIC_SUMMARY_OUTCOMES.has(value)
    ? value
    : undefined;
}

function isSemanticSummaryModelUnconfigured(error: unknown) {
  return error instanceof Error &&
    error.message === "The semantic summary memory model is not configured.";
}

function publicConversationSummary(summary: ConversationSummaryRecord) {
  const { actorId: _actorId, accessScope, ...publicSummary } = summary;
  void _actorId;
  return {
    ...publicSummary,
    accessScope: {
      schemaVersion: accessScope.schemaVersion,
      visibility: accessScope.visibility,
      threadId: accessScope.threadId,
      projectId: accessScope.projectId,
      purposeIds: accessScope.purposeIds,
      scopeSha256: accessScope.scopeSha256,
    },
  };
}
