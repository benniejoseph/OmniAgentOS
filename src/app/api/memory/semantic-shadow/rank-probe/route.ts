import { randomUUID } from "node:crypto";

import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  getSemanticMemoryShadowReviewWorkspace,
  saveSemanticMemoryShadowRankProbe,
  SemanticMemoryShadowReviewConflictError,
} from "@/lib/evals2/semantic-memory-shadow-review";
import {
  semanticMemoryShadowRankProbeInputSchema,
  SemanticMemoryShadowRankProbeUnavailableError,
} from "@/lib/evals2/semantic-memory-shadow-rank-probe";
import {
  jsonBodyErrorResponse,
  parseJsonBody,
} from "@/lib/http/body";
import { canonicalRequestActorBindingFromSecurityContext } from
  "@/lib/security/canonical-actor";
import { createExecutionScope } from "@/lib/security/execution-scope";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

async function POSTHandler(request: Request) {
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = semanticMemoryShadowRankProbeInputSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({
      error: "Invalid semantic shadow retrieval probe",
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
      metadata: { operation: "semantic_shadow_rank_probe" },
    });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const actorBinding = canonicalRequestActorBindingFromSecurityContext(
    context,
  );
  if (!actorBinding) {
    return Response.json({
      error: "Semantic retrieval probing requires a canonical signed-in user.",
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
  if (
    !candidate ||
    !actorBinding.readableOwnerActorIds.includes(candidate.scope.ownerActorId)
  ) {
    return Response.json(
      { error: "Semantic shadow review candidate not found." },
      { status: 404, headers: privateNoStoreHeaders },
    );
  }
  const correlationId = request.headers.get("x-idempotency-key")?.trim()
    .slice(0, 200) || `semantic_shadow_rank_probe_${randomUUID()}`;
  try {
    const probe = await saveSemanticMemoryShadowRankProbe({
      tenantId: context.tenantId,
      actorIds: actorBinding.readableOwnerActorIds,
      probe: parsed.data,
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
        purpose: "conversation.summary.semantic_shadow.rank_probe",
      }),
    });
    return Response.json({ probe }, { headers: privateNoStoreHeaders });
  } catch (error) {
    if (
      error instanceof SemanticMemoryShadowReviewConflictError ||
      error instanceof SemanticMemoryShadowRankProbeUnavailableError
    ) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    throw error;
  }
}
