import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseActorScope,
  withDatabaseRequestScope,
} from "@/lib/db/client";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import {
  collectCognificationEvidenceRefs,
  renderCognificationCandidateReview,
} from "@/lib/knowledge/cognification-contract";
import {
  getKnowledgeCognition,
  KnowledgeCognitionConflictError,
  KnowledgeCognitionNotFoundError,
  listKnowledgeCognitions,
  markKnowledgeCognitionProjected,
  reviewKnowledgeCognition,
  type KnowledgeCognitionRecord,
} from "@/lib/knowledge/cognification-store";
import {
  buildUserPrivateMemoryAccessBindingV1,
  MEMORY_PURPOSE_IDS,
} from "@/lib/memory/access-binding";
import {
  indexUserPrivateMemoryGraphRecords,
} from "@/lib/memory/graph";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  saveMemory,
  saveMemoryWithCommitStatusInTransaction,
  type CreateMemoryInput,
} from "@/lib/memory/store";
import { memoryTierRetentionExpiresAt } from "@/lib/memory/tier-policy";
import type { MemoryRecord } from "@/lib/memory/types";
import {
  enqueueKnowledgeCognificationPlan,
} from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import {
  getActorOwnedKnowledgeForCognition,
  listActorOwnedKnowledgeDocumentsForCognition,
} from "@/lib/rag/store";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import {
  deriveExecutionScope,
  executionScopeFromSecurityContext,
} from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

const queueSchema = z.object({
  documentId: z.string().trim().min(1).max(320).optional(),
  limit: z.number().int().min(1).max(50).default(12),
}).strict();

const reviewSchema = z.object({
  id: z.string().trim().min(1).max(320),
  decision: z.enum(["confirm", "dismiss"]),
}).strict();

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "knowledge_cognition",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const limit = boundedLimit(new URL(request.url).searchParams.get("limit"));
  const [pending, confirmed, eligibleDocuments] = await Promise.all([
    listKnowledgeCognitions({
      tenantId: context.tenantId,
      actorId: context.actorId,
      status: "pending_review",
      limit,
    }),
    listKnowledgeCognitions({
      tenantId: context.tenantId,
      actorId: context.actorId,
      status: "confirmed",
      limit,
    }),
    listActorOwnedKnowledgeDocumentsForCognition({
      tenantId: context.tenantId,
      actorId: context.actorId,
      limit,
    }),
  ]);
  const eligibleDocumentIds = new Set(eligibleDocuments.map(({ id }) => id));
  const reviews = [...pending, ...confirmed.filter((item) =>
    !item.projectedMemoryId
  )]
    .filter((item) => eligibleDocumentIds.has(item.candidate.documentId))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, limit)
    .map(publicCognitionRecord);
  return Response.json({ reviews }, { headers: privateNoStoreHeaders });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = queueSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid cognition request",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge_cognition",
      metadata: {
        operation: "queue",
        documentId: parsed.data.documentId || null,
        limit: parsed.data.limit,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  if (!canonicalRequestActorBindingFromSecurityContext(context)) {
    return Response.json({
      error: "Knowledge cognition requires a canonical signed-in user.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }
  const executionScope = executionScopeFromSecurityContext(context, {
    correlationId: request.headers.get("x-request-id")?.trim().slice(0, 200) ||
      `knowledge_cognition_queue_${randomUUID()}`,
    purpose: "knowledge.cognition.queue",
  });
  const documents = parsed.data.documentId
    ? await oneEligibleDocument(
        context.tenantId,
        context.actorId,
        parsed.data.documentId,
      )
    : await listActorOwnedKnowledgeDocumentsForCognition({
        tenantId: context.tenantId,
        actorId: context.actorId,
        limit: parsed.data.limit,
      });
  const jobs = await Promise.all(documents.map(async (document) => {
    if (!document.sourceRevisionId) return null;
    return enqueueKnowledgeCognificationPlan({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      documentId: document.id,
      sourceRevisionId: document.sourceRevisionId,
    });
  }));
  const queued = jobs.filter((job): job is NonNullable<typeof job> =>
    Boolean(job)
  );
  const projectedJobs = queued.map(projectOperationJobStatus);
  const queuedJobCount = projectedJobs.filter((job) =>
    job.status === "queued" || job.status === "running"
  ).length;
  return Response.json({
    jobs: projectedJobs,
    queuedJobCount,
    upToDateCount: projectedJobs.length - queuedJobCount,
    eligibleDocumentCount: documents.length,
  }, {
    status: queuedJobCount ? 202 : 200,
    headers: privateNoStoreHeaders,
  });
}

async function PATCHHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid cognition review decision",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "knowledge_cognition",
      resourceId: parsed.data.id,
      metadata: { decision: parsed.data.decision },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const canonicalActor = canonicalRequestActorBindingFromSecurityContext(
    context,
  );
  if (!canonicalActor) {
    return Response.json({
      error: "Knowledge cognition review requires a canonical signed-in user.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }
  const correlationId = request.headers.get("x-idempotency-key")?.trim()
    .slice(0, 200) || request.headers.get("x-request-id")?.trim().slice(0, 200) ||
    `knowledge_cognition_review_${randomUUID()}`;
  const reviewExecutionScope = executionScopeFromSecurityContext(context, {
    correlationId,
    causationId: parsed.data.id,
    purpose: "knowledge.cognition.review",
  });
  const reviewMetadata = {
    reviewSurface: "memory_intelligence",
    canonicalOwnerActorId: canonicalActor.canonicalActorId,
  } as const;

  try {
    if (parsed.data.decision === "dismiss") {
      const dismissed = await reviewKnowledgeCognition({
        id: parsed.data.id,
        tenantId: context.tenantId,
        actorId: context.actorId,
        decision: "dismiss",
        reviewedBy: context.actorId,
        reviewMetadata,
        executionScope: reviewExecutionScope,
      });
      return Response.json({ review: publicCognitionRecord(dismissed) }, {
        headers: privateNoStoreHeaders,
      });
    }

    const existing = await getKnowledgeCognition(parsed.data.id, {
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    if (!existing) throw new KnowledgeCognitionNotFoundError();
    const source = await getActorOwnedKnowledgeForCognition({
      tenantId: context.tenantId,
      actorId: context.actorId,
      documentId: existing.candidate.documentId,
    });
    if (
      !source ||
      source.sourceRevisionId !== existing.candidate.sourceRevisionId ||
      source.retentionExpiresAt !== existing.candidate.retentionExpiresAt
    ) {
      throw new KnowledgeCognitionConflictError(
        "The source policy changed after this proposal was created. Cognify the current source instead.",
      );
    }
    const requestAccess = requestMemoryAccessFromSecurityContext(context, {
      purposeId: MEMORY_PURPOSE_IDS.correct,
      auditPurpose: "knowledge.cognition.review.confirm",
      correlationId,
    });
    if (!requestAccess) {
      throw new KnowledgeCognitionConflictError(
        "A private memory scope could not be established for this review.",
      );
    }
    const memoryExecutionScope = deriveExecutionScope(
      requestAccess.executionScope,
      {
        causationId: existing.candidate.batchId,
        purpose: "knowledge.cognition.review.confirm",
      },
    );
    const memoryInput = reviewedMemoryInput({
      record: existing,
      title: source.document.title,
      tenantId: context.tenantId,
      canonicalActorId: canonicalActor.canonicalActorId,
      executionScope: memoryExecutionScope,
      databaseAccessScope: requestAccess.databaseAccessScope,
    });
    const confirmed = await confirmAndSaveMemory({
      record: existing,
      memoryInput,
      reviewExecutionScope,
      reviewMetadata,
      sourceActorId: context.actorId,
      canonicalActorId: canonicalActor.canonicalActorId,
    });
    const memory = confirmed.memory;
    await indexUserPrivateMemoryGraphRecords(
      [memory],
      "knowledge.cognition.review.confirm",
      {
        tenantId: context.tenantId,
        accessScope: requestAccess.databaseAccessScope,
      },
    );
    await projectExplicitMemoryEntities({
      memory,
      executionScope: memoryExecutionScope,
    });
    const projected = await markKnowledgeCognitionProjected({
      id: parsed.data.id,
      tenantId: context.tenantId,
      actorId: context.actorId,
      projectedMemoryId: memory.id,
      executionScope: reviewExecutionScope,
    });
    return Response.json({
      review: publicCognitionRecord(projected),
      projection: {
        status: "completed",
        title: memory.title,
        tier: memory.tier,
      },
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    const status = error instanceof KnowledgeCognitionNotFoundError
      ? 404
      : error instanceof KnowledgeCognitionConflictError
        ? 409
        : 500;
    return Response.json({
      error: error instanceof Error
        ? error.message
        : "Knowledge cognition review failed.",
    }, { status, headers: privateNoStoreHeaders });
  }
}

async function confirmAndSaveMemory(input: {
  record: KnowledgeCognitionRecord;
  memoryInput: CreateMemoryInput;
  reviewExecutionScope: ReturnType<typeof executionScopeFromSecurityContext>;
  reviewMetadata: Readonly<Record<string, string>>;
  sourceActorId: string;
  canonicalActorId: string;
}): Promise<{ review: KnowledgeCognitionRecord; memory: MemoryRecord }> {
  if (!hasDatabaseUrl()) {
    const review = await reviewKnowledgeCognition({
      id: input.record.candidate.batchId,
      tenantId: input.record.candidate.tenantId,
      actorId: input.sourceActorId,
      decision: "confirm",
      reviewedBy: input.sourceActorId,
      reviewMetadata: input.reviewMetadata,
      executionScope: input.reviewExecutionScope,
    });
    const memory = await saveMemory(input.memoryInput);
    return { review, memory };
  }
  await ensureDatabaseSchema();
  return runWithDatabaseActorScope(
    input.record.candidate.tenantId,
    [input.sourceActorId, input.canonicalActorId],
    () => getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const review = await reviewKnowledgeCognition({
        id: input.record.candidate.batchId,
        tenantId: input.record.candidate.tenantId,
        actorId: input.sourceActorId,
        decision: "confirm",
        reviewedBy: input.sourceActorId,
        reviewMetadata: input.reviewMetadata,
        executionScope: input.reviewExecutionScope,
        sql,
      });
      const memory = (await saveMemoryWithCommitStatusInTransaction(
        input.memoryInput,
        sql,
      )).record;
      return { review, memory };
    }) as Promise<{ review: KnowledgeCognitionRecord; memory: MemoryRecord }>,
  );
}

function reviewedMemoryInput(input: {
  record: KnowledgeCognitionRecord;
  title: string;
  tenantId: string;
  canonicalActorId: string;
  executionScope: CreateMemoryInput["executionScope"];
  databaseAccessScope: NonNullable<CreateMemoryInput["databaseAccessScope"]>;
}): CreateMemoryInput {
  const candidate = input.record.candidate;
  const tierRetentionExpiresAt = memoryTierRetentionExpiresAt(
    "summary",
    input.record.createdAt,
  );
  const evidenceRefs = [
    `knowledge:${candidate.documentId}`,
    `source-revision:${candidate.sourceRevisionId}`,
    `cognition-review:${candidate.batchId}`,
    `model-usage:${candidate.modelAttribution.usageReceiptId}`,
    ...collectCognificationEvidenceRefs(candidate),
  ];
  return {
    id: `memory:${candidate.batchId}`,
    tenantId: input.tenantId,
    type: "knowledge",
    tier: "summary",
    formationReason: "source_cognition",
    title: `Reviewed source map · ${input.title}`.slice(0, 240),
    content: renderCognificationCandidateReview(candidate).replace(
      "Cognification review candidate — not canonical until confirmed",
      "Reviewed source cognition",
    ),
    tags: ["cognified", "reviewed", "source-map"],
    scope: "user",
    source: `cognify-reviewed:${candidate.batchId}`,
    importance: 0.78,
    confidence: candidate.summary.confidenceBasisPoints / 10_000,
    claimStatus: "active",
    assertedBy: "user",
    evidenceRefs,
    retentionExpiresAt: earliestTimestamp(
      candidate.retentionExpiresAt,
      tierRetentionExpiresAt,
    ),
    accessBinding: buildUserPrivateMemoryAccessBindingV1({
      tenantId: input.tenantId,
      ownerActorId: input.canonicalActorId,
      originPurpose: "knowledge.cognition.review.confirm",
      accessBoundAt: input.record.createdAt,
    }),
    databaseAccessScope: input.databaseAccessScope,
    executionScope: input.executionScope,
    formationOrigin: "reviewed_source_cognition",
  };
}

function earliestTimestamp(
  left: string | null | undefined,
  right: string | null | undefined,
): string | undefined {
  if (!left) return right || undefined;
  if (!right) return left || undefined;
  return Date.parse(left) <= Date.parse(right) ? left : right;
}

async function oneEligibleDocument(
  tenantId: string,
  actorId: string,
  documentId: string,
) {
  const source = await getActorOwnedKnowledgeForCognition({
    tenantId,
    actorId,
    documentId,
  });
  return source ? [source.document] : [];
}

function publicCognitionRecord(record: KnowledgeCognitionRecord) {
  const candidate = record.candidate;
  const publicEvidence = (evidence: readonly { quote: string }[]) =>
    evidence.map(({ quote }) => ({ quote }));
  return {
    status: record.status,
    reviewDecision: record.reviewDecision,
    reviewedAt: record.reviewedAt,
    projected: Boolean(record.projectedMemoryId),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    candidate: {
      batchId: candidate.batchId,
      batchIndex: candidate.batchIndex,
      batchCount: candidate.batchCount,
      summary: {
        text: candidate.summary.text,
        confidenceBasisPoints: candidate.summary.confidenceBasisPoints,
        evidence: publicEvidence(candidate.summary.evidence),
      },
      topics: candidate.topics.map(({ label }) => ({ label })),
      claims: candidate.claims.map(({ statement }) => ({ statement })),
      entities: candidate.entities.map(({ canonicalLabel }) => ({
        canonicalLabel,
      })),
      relations: candidate.relations.map(({ statement }) => ({ statement })),
      modelAttribution: {
        provider: candidate.modelAttribution.provider,
        model: candidate.modelAttribution.model,
      },
    },
  };
}

function boundedLimit(value: string | null) {
  const parsed = Number(value || 40);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, 1), 100) : 40;
}
