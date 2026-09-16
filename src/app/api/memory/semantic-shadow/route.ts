import { randomUUID } from "node:crypto";

import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getSemanticMemoryShadowReviewWorkspace,
  saveSemanticMemoryShadowReview,
  semanticMemoryShadowReviewInputSchema,
  SemanticMemoryShadowReviewConflictError,
  type SemanticMemoryShadowReviewCandidate,
} from "@/lib/evals2/semantic-memory-shadow-review";
import {
  jsonBodyErrorResponse,
  parseBoundedInteger,
  parseJsonBody,
} from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from
  "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function GETHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "read",
      resourceType: "conversation_summary",
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    context,
  );
  if (!actorBinding) {
    return Response.json({
      error: "Semantic shadow review requires a canonical signed-in user.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }
  const url = new URL(request.url);
  const limit = parseBoundedInteger(url.searchParams.get("limit"), 24, {
    max: 100,
  });
  const detailId = url.searchParams.get("id")?.trim().slice(0, 320);
  const workspace = await getSemanticMemoryShadowReviewWorkspace({
    tenantId: context.tenantId,
    actorIds: actorBinding.readableOwnerActorIds,
    limit,
  });
  if (url.searchParams.get("view") === "observation") {
    return Response.json({
      observation: workspace.observation,
      report: workspace.report,
    }, { headers: privateNoStoreHeaders });
  }
  if (detailId && !workspace.candidates.some(({ id }) => id === detailId)) {
    return Response.json(
      { error: "Semantic shadow review candidate not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  return Response.json({
    candidates: workspace.candidates.map((candidate) =>
      publicReviewCandidate(candidate, candidate.id === detailId)
    ),
    report: workspace.report,
    reviewedCaseCount: workspace.observation?.cases.length || 0,
  }, { headers: privateNoStoreHeaders });
}

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = semanticMemoryShadowReviewInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid semantic shadow review",
      details: parsed.error.flatten(),
    }, { status: 400, headers: privateNoStoreHeaders });
  }
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      resourceType: "conversation_summary",
      resourceId: parsed.data.enrichmentId,
      metadata: {
        operation: "semantic_shadow_human_review",
        dimension: parsed.data.dimension,
      },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    context,
  );
  if (!actorBinding) {
    return Response.json({
      error: "Semantic shadow review requires a canonical signed-in user.",
    }, { status: 409, headers: privateNoStoreHeaders });
  }
  const workspace = await getSemanticMemoryShadowReviewWorkspace({
    tenantId: context.tenantId,
    actorIds: actorBinding.readableOwnerActorIds,
    limit: 100,
  });
  const candidate = workspace.candidates.find(({ id }) =>
    id === parsed.data.enrichmentId
  );
  if (!candidate) {
    return Response.json(
      { error: "Semantic shadow review candidate not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  if (!actorBinding.readableOwnerActorIds.includes(
    candidate.scope.ownerActorId,
  )) {
    return Response.json(
      { error: "Semantic shadow review candidate not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  const correlationId = request.headers.get("x-idempotency-key")?.trim()
    .slice(0, 200) || `semantic_shadow_review_${randomUUID()}`;
  try {
    const review = await saveSemanticMemoryShadowReview({
      tenantId: context.tenantId,
      actorIds: actorBinding.readableOwnerActorIds,
      review: parsed.data,
      correlationId,
      executionScope: createExecutionScope({
        tenantId: context.tenantId,
        initiatingActorId: candidate.scope.ownerActorId,
        executingPrincipalType: "user",
        executingPrincipalId: candidate.scope.ownerActorId,
        workspaceId: null,
        projectId: candidate.scope.projectId,
        missionId: null,
        delegationId: null,
        correlationId,
        causationId: candidate.id,
        contextGrantIds: [],
        capabilityGrantIds: [],
        purpose: "conversation.summary.semantic_shadow.review",
      }),
    });
    return Response.json({ review }, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (error instanceof SemanticMemoryShadowReviewConflictError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    throw error;
  }
}

function publicReviewCandidate(
  candidate: SemanticMemoryShadowReviewCandidate,
  includeDetail: boolean,
) {
  return {
    id: candidate.id,
    reviewSourceSha256: candidate.reviewSourceSha256,
    startsAt: candidate.startsAt,
    endsAt: candidate.endsAt,
    model: candidate.model,
    metrics: candidate.metrics,
    reviewable: candidate.reviewable,
    ...(candidate.unavailableReason
      ? { unavailableReason: candidate.unavailableReason }
      : {}),
    ...(candidate.latestReview
      ? { latestReview: candidate.latestReview }
      : {}),
    ...(includeDetail
      ? {
          sourceTurns: candidate.sourceTurns,
          deterministicSummary: candidate.deterministicSummary,
          semanticItems: candidate.semanticItems,
        }
      : {}),
  };
}
