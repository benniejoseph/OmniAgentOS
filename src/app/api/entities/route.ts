import { randomUUID } from "node:crypto";
import { z } from "zod";

import { withDatabaseRequestScope } from "@/lib/db/client";
import { requestEntityAccessFromSecurityContext } from "@/lib/entities/request-access";
import { readEntityRegistry, reviewEntityMerge } from "@/lib/entities/store";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const reviewSchema = z.object({
  action: z.literal("review_merge"),
  resolutionId: z.string().trim().min(1).max(240),
  sourceEntityId: z.string().trim().min(1).max(240),
  targetEntityId: z.string().trim().min(1).max(240),
  decision: z.enum(["approved", "rejected", "reversed"]),
  previousReviewId: z.string().trim().min(1).max(240).optional(),
}).strict().superRefine((value, context) => {
  if ((value.decision === "reversed") !== Boolean(value.previousReviewId)) {
    context.addIssue({
      code: "custom",
      path: ["previousReviewId"],
      message: "Only a reversal requires its prior approval ID.",
    });
  }
});

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "entity_registry",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  const access = requestEntityAccessFromSecurityContext(context, {
    purposeId: "entity.read.v1",
    correlationId: `entity_read_${randomUUID()}`,
  });
  if (!access) return unavailableResponse();

  try {
    const registry = await readEntityRegistry(access);
    return Response.json(publicRegistry(registry), {
      headers: privateNoStoreHeaders,
    });
  } catch {
    return Response.json(
      { error: "Entity registry could not be loaded." },
      { status: 500, headers: privateNoStoreHeaders },
    );
  }
}

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "entity_registry",
      metadata: { operation: "review_merge" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }

  let body: unknown;
  try {
    body = await parseJsonBody(request, 16_384);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = reviewSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid entity review", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  const access = requestEntityAccessFromSecurityContext(context, {
    purposeId: "entity.review.v1",
    correlationId: `entity_review_${randomUUID()}`,
  });
  if (!access) return unavailableResponse();

  try {
    const review = await reviewEntityMerge({
      resolutionId: parsed.data.resolutionId,
      sourceEntityId: parsed.data.sourceEntityId,
      targetEntityId: parsed.data.targetEntityId,
      decision: parsed.data.decision,
      previousReviewId: parsed.data.previousReviewId,
      executionScope: access.executionScope,
    });
    return Response.json({ review: publicReview(review) }, {
      headers: privateNoStoreHeaders,
    });
  } catch {
    return Response.json(
      {
        error: "Entity review could not be applied.",
        message: "The candidates may have changed. Reload the registry and review again.",
      },
      { status: 409, headers: privateNoStoreHeaders },
    );
  }
}

function unavailableResponse() {
  return Response.json(
    { error: "The private entity registry is unavailable for this identity." },
    { status: 403, headers: privateNoStoreHeaders },
  );
}

function publicRegistry(registry: Awaited<ReturnType<typeof readEntityRegistry>>) {
  return {
    schemaVersion: 1,
    entities: registry.entities.map((entity) => ({
      entityId: entity.entityId,
      entityTypeId: entity.entityTypeId,
      canonicalLabel: entity.canonicalLabel,
      state: entity.state,
      mergedIntoEntityId: entity.mergedIntoEntityId,
      lineageCount: entity.lineage.length,
      createdAt: entity.createdAt,
      updatedAt: entity.updatedAt,
    })),
    aliases: registry.aliases.map((alias) => ({
      aliasId: alias.aliasId,
      entityId: alias.entityId,
      alias: alias.alias,
      createdAt: alias.createdAt,
    })),
    resolutions: registry.resolutions.map((resolution) => ({
      resolutionId: resolution.resolutionId,
      entityTypeId: resolution.entityTypeId,
      decision: resolution.decision,
      selectedEntityId: resolution.selectedEntityId,
      candidateEntityIds: resolution.candidateEntityIds,
      matchMethod: resolution.matchMethod,
      scoreBasisPoints: resolution.scoreBasisPoints,
      decidedAt: resolution.decidedAt,
    })),
    mergeReviews: registry.mergeReviews.map(publicReview),
  };
}

function publicReview(review: Awaited<ReturnType<typeof reviewEntityMerge>>) {
  return {
    reviewId: review.reviewId,
    resolutionId: review.resolutionId,
    sourceEntityId: review.sourceEntityId,
    targetEntityId: review.targetEntityId,
    decision: review.decision,
    previousReviewId: review.previousReviewId,
    reviewedAt: review.reviewedAt,
  };
}
