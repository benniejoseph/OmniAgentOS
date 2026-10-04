import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import {
  listMemoryReconciliationService,
  publicMemoryReconciliationReview,
  resolveMemoryReconciliationService,
} from "@/lib/app-services/memory-reconciliation";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { retireEntityMemoryLineage } from "@/lib/entities/store";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { IdempotencyKeyError, idempotencyKeyErrorResponse, requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import {
  indexUserPrivateMemoryGraphRecords,
  queueMemoryGraphRebuild,
} from "@/lib/memory/graph";
import {
  memoryReconciliationDecisionSchema,
  type MemoryReconciliationReview,
} from "@/lib/memory/reconciliation";
import { MemoryReconciliationNativeError, memoryReconciliationNativeRequestSchema } from "@/lib/memory/reconciliation-native-contracts";
import { nativeMemoryReconciliationQuerySchema } from "@/lib/mobile/memory-reconciliation-contracts";
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
    return privateResponse(forbiddenResponse(error));
  }
  const url = new URL(request.url);
  if (context.source === "mobile" || url.searchParams.has("contract")) {
    const params = [...url.searchParams];
    const raw: Record<string, unknown> = Object.fromEntries(params);
    if (typeof raw.limit === "string" && /^[1-9]\d{0,2}$/.test(raw.limit)) raw.limit = Number(raw.limit);
    const query = nativeMemoryReconciliationQuerySchema.safeParse(raw);
    if (new Set(params.map(([key]) => key)).size !== params.length || !query.success) {
      return Response.json({ error: "Invalid native Memory reconciliation query." }, { status: 400, headers: privateNoStoreHeaders });
    }
    try {
      const result = await listMemoryReconciliationService(createAppServiceCaller({ context }), query.data);
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
    } catch (error) { return nativeFailure(error); }
  }
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
    body = await parseJsonBody(request, 4_096);
  } catch (error) {
    const response = jsonBodyErrorResponse(error);
    response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]);
    return response;
  }
  const parsed = resolutionSchema.or(memoryReconciliationNativeRequestSchema).safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid memory reconciliation decision",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }

  if ("contract" in parsed.data) {
    if ([...new URL(request.url).searchParams].length) {
      return Response.json({ error: "Native Memory reconciliation decisions do not accept query parameters." }, { status: 400, headers: privateNoStoreHeaders });
    }
    try { requiredRequestIdempotencyKey(request); }
    catch (error) {
      if (error instanceof IdempotencyKeyError) return idempotencyKeyErrorResponse(error);
      throw error;
    }
  }

  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      nativeMutationCapability: "memory.reconciliation.resolve",
      resourceType: "memory_reconciliation",
      resourceId: parsed.data.reviewId,
      metadata: { decision: parsed.data.decision },
    });
  } catch (error) {
    return privateResponse(forbiddenResponse(error));
  }
  if ("contract" in parsed.data) {
    try {
      const result = await resolveMemoryReconciliationService(
        createRequestMutationAppServiceCaller(request, context, {
          purpose: "api.memory.reconciliation.native.resolve",
          causationId: parsed.data.reviewId,
        }),
        parsed.data,
      );
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, { headers: privateNoStoreHeaders });
    } catch (error) { return nativeFailure(error); }
  }
  if (context.source === "mobile") {
    return Response.json({
      error: "Native Memory reconciliation decisions require the reviewed revision contract.",
      code: "memory_reconciliation_contract_required",
    }, { status: 400, headers: privateNoStoreHeaders });
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

function nativeFailure(error: unknown) {
  return error instanceof MemoryReconciliationNativeError
    ? Response.json({ error: error.message, code: error.code }, { status: error.status, headers: privateNoStoreHeaders })
    : Response.json({ error: "Memory reconciliation is temporarily unavailable.", code: "memory_reconciliation_unavailable" }, { status: 503, headers: privateNoStoreHeaders });
}

function privateResponse(response: Response) {
  response.headers.set("cache-control", privateNoStoreHeaders["cache-control"]);
  return response;
}
