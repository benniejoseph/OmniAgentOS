import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { retireEntityMemoryLineage } from "@/lib/entities/store";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  indexUserPrivateMemoryGraphRecords,
  queueMemoryGraphRebuild,
} from "@/lib/memory/graph";
import {
  memoryReconciliationDecisionSchema,
  type MemoryReconciliationReview,
} from "@/lib/memory/reconciliation";
import { requestMemoryAccessFromSecurityContext } from "@/lib/memory/request-access";
import {
  listMemoryReconciliationReviews,
  MemoryReconciliationConflictError,
  resolveMemoryReconciliationReview,
} from "@/lib/memory/store";
import {
  deriveExecutionScope,
  executionScopeFromSecurityContext,
} from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);

const resolutionSchema = z.object({
  reviewId: z.string().trim().min(1).max(200),
  decision: memoryReconciliationDecisionSchema,
}).strict();

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "memory_reconciliation",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const url = new URL(request.url);
  const requestedStatus = url.searchParams.get("status");
  const status = requestedStatus === "pending" || requestedStatus === "resolved"
    ? requestedStatus
    : "all";
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 100, {
    max: 200,
  });
  const requestAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.read,
    auditPurpose: "api.memory.reconciliation.read",
    correlationId: `memory_reconciliation_read_${randomUUID()}`,
  });
  const legacy = await listMemoryReconciliationReviews({
    tenantId: context.tenantId,
    status,
    limit,
  });
  const privateReviews = requestAccess
    ? await listMemoryReconciliationReviews({
        tenantId: context.tenantId,
        status,
        limit,
        accessScope: requestAccess.databaseAccessScope,
      })
    : [];
  return Response.json({
    reviews: mergeReviews(legacy, privateReviews, limit)
      .map(publicMemoryReconciliationReview),
  }, { headers: privateNoStoreHeaders });
}

async function PATCHHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = resolutionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory reconciliation decision",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "memory_reconciliation",
      resourceId: parsed.data.reviewId,
      metadata: { decision: parsed.data.decision },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const correlationId = request.headers.get("x-idempotency-key")?.trim()
    .slice(0, 200) || request.headers.get("x-request-id")?.trim().slice(0, 200) ||
    `memory_reconciliation_${randomUUID()}`;
  const requestAccess = requestMemoryAccessFromSecurityContext(context, {
    purposeId: MEMORY_PURPOSE_IDS.correct,
    auditPurpose: "api.memory.reconciliation.resolve",
    correlationId,
  });
  let review: MemoryReconciliationReview | null = null;
  let usedPrivateScope = false;
  try {
    if (requestAccess) {
      review = await resolveMemoryReconciliationReview(
        parsed.data.reviewId,
        parsed.data.decision,
        {
          tenantId: context.tenantId,
          actorId: requestAccess.actorBinding.canonicalActorId,
          accessScope: requestAccess.databaseAccessScope,
          executionScope: requestAccess.executionScope,
        },
      );
      usedPrivateScope = Boolean(review);
    }
    if (!review) {
      review = await resolveMemoryReconciliationReview(
        parsed.data.reviewId,
        parsed.data.decision,
        {
          tenantId: context.tenantId,
          actorId: context.actorId,
          executionScope: executionScopeFromSecurityContext(context, {
            correlationId,
            purpose: "api.memory.reconciliation.resolve",
          }),
        },
      );
    }
  } catch (error) {
    if (error instanceof MemoryReconciliationConflictError) {
      return Response.json({ error: error.message }, {
        status: 409,
        headers: privateNoStoreHeaders,
      });
    }
    throw error;
  }
  if (!review) {
    return Response.json({ error: "Memory reconciliation review not found." }, {
      status: 404,
      headers: privateNoStoreHeaders,
    });
  }

  if (review.candidate.claimStatus === "active") {
    if (usedPrivateScope && requestAccess) {
      await indexUserPrivateMemoryGraphRecords(
        [review.candidate],
        "memory.reconciliation.resolve",
        {
          tenantId: context.tenantId,
          accessScope: requestAccess.databaseAccessScope,
        },
      );
      await projectExplicitMemoryEntities({
        memory: review.candidate,
        executionScope: requestAccess.executionScope,
      });
      if (
        review.decision === "confirm_candidate" &&
        review.existing?.claimStatus === "contradicted"
      ) {
        await retireEntityMemoryLineage({
          tenantId: context.tenantId,
          ownerActorId: requestAccess.actorBinding.canonicalActorId,
          memoryIds: [review.existing.id],
          executionScope: deriveExecutionScope(requestAccess.executionScope, {
            purpose: "memory.reconciliation.resolve.v1",
          }),
        });
      }
    } else {
      await queueMemoryGraphRebuild({ tenantId: context.tenantId });
    }
  }

  return Response.json({
    review: publicMemoryReconciliationReview(review),
  }, { headers: privateNoStoreHeaders });
}

function mergeReviews(
  ...input: [MemoryReconciliationReview[], MemoryReconciliationReview[], number]
) {
  const [legacy, privateReviews, limit] = input;
  const merged = new Map<string, MemoryReconciliationReview>();
  for (const review of [...legacy, ...privateReviews]) merged.set(review.id, review);
  return [...merged.values()]
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "pending" ? -1 : 1;
      return right.updatedAt.localeCompare(left.updatedAt);
    })
    .slice(0, limit);
}

function publicMemoryReconciliationReview(review: MemoryReconciliationReview) {
  const {
    ownerActorId: _ownerActorId,
    resolvedBy: _resolvedBy,
    candidate,
    existing,
    ...publicReview
  } = review;
  void _ownerActorId;
  void _resolvedBy;
  return {
    ...publicReview,
    candidate: publicMemory(candidate),
    ...(existing ? { existing: publicMemory(existing) } : {}),
  };
}

function publicMemory<T extends { embedding?: number[] }>(memory: T) {
  const result = { ...memory };
  delete result.embedding;
  return result;
}
