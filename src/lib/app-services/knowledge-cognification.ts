import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { databaseMemoryAccessScopeFromExecutionScope } from "@/lib/db/memory-access-scope";
import { explicitMemoryEntityProjectionEligible, projectExplicitMemoryEntities } from "@/lib/entities/extraction";
import { KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT, knowledgeCognitionNativeDecisionRequestSchema, type KnowledgeCognitionNativeRecord } from "@/lib/knowledge/cognification-native-contracts";
import { decideNativeKnowledgeCognition, listNativeKnowledgeCognitionReviews, readNativeKnowledgeCognitionDecision, readNativeKnowledgeCognitionReview } from "@/lib/knowledge/cognification-native-store";
import { markKnowledgeCognitionProjected } from "@/lib/knowledge/cognification-store";
import { MEMORY_PURPOSE_IDS } from "@/lib/memory/access-binding";
import { indexUserPrivateMemoryGraphRecords } from "@/lib/memory/graph";
import { NativePrivateActionError, privateActionScopeSchema } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation } from "@/lib/memory/private-action-store";
import { nativeKnowledgeCognificationSchemas as schemas, nativeKnowledgeCognitionDecisionResponseForScopeSchema, validateNativeKnowledgeCognitionAuthority } from "@/lib/mobile/knowledge-cognification-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";

function authority(caller: AppServiceCaller, reviewId?: string) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical) throw new NativePrivateActionError("knowledge_cognition_authority", 403, "Current canonical source owner is required.");
  const scope = privateActionScopeSchema.parse({ tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId });
  if (reviewId) {
    if (!caller.idempotencyKey) throw new NativePrivateActionError("knowledge_cognition_key", 400, "An explicit source-map request key is required.");
    const execution = assertNativePrivateActionMutation({ scope, executionScope: caller.executionScope }, "api.knowledge.cognification.decide", reviewId);
    return { scope, executionScope: deriveExecutionScope(execution, { purpose: "knowledge.cognition.review" }) };
  }
  if (caller.executionScope || caller.idempotencyKey) throw new NativePrivateActionError("knowledge_cognition_authority", 403, "Source-map reading requires a read-only caller.");
  return { scope };
}
function expected(caller: AppServiceCaller, owner: ReturnType<typeof authority>) {
  return { scope: owner.scope, requestActorId: caller.context.actorId, role: caller.context.role, executionScope: caller.executionScope };
}
function publicReview(caller: AppServiceCaller, review: KnowledgeCognitionNativeRecord) {
  return canPerform(caller.context.role, "write.memory") ? review : { ...review, allowedDecisions: [], review: null };
}
export async function listKnowledgeCognitionNativeService(caller: AppServiceCaller, query: unknown) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.knowledge.cognification.native.list")), owner = authority(caller);
  const reviews = (await listNativeKnowledgeCognitionReviews(owner, schemas.NativeKnowledgeCognitionListQuery.parse(query))).map((review) => publicReview(caller, review));
  const result = completeAppServiceCall(authorized, { contract: KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT, scope: owner.scope, reviews }, { resourceCount: reviews.length });
  const wire = schemas.NativeKnowledgeCognitionListResponse.parse({ ...result.data, serviceReceipt: result.receipt }); validateNativeKnowledgeCognitionAuthority(wire, expected(caller, owner));
  return result;
}
export async function readKnowledgeCognitionNativeService(caller: AppServiceCaller, reviewId: string) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.knowledge.cognification.native.read")), owner = authority(caller);
  const current = await readNativeKnowledgeCognitionReview(owner, reviewId);
  if (!current) throw new NativePrivateActionError("knowledge_cognition_not_found", 404, "The exact owned source map is unavailable.");
  const result = completeAppServiceCall(authorized, { contract: KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT, scope: owner.scope, review: publicReview(caller, current) }, { resourceCount: 1 });
  const wire = schemas.NativeKnowledgeCognitionReadResponse.parse({ ...result.data, serviceReceipt: result.receipt }); validateNativeKnowledgeCognitionAuthority(wire, expected(caller, owner));
  return result;
}
export async function readKnowledgeCognitionNativeAcceptanceService(caller: AppServiceCaller, reviewId: string, keySha256: string) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.knowledge.cognification.native.decision.get")), owner = authority(caller);
  const current = await readNativeKnowledgeCognitionDecision(owner, reviewId, keySha256);
  const result = completeAppServiceCall(authorized, { contract: KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT, scope: owner.scope,
    ...current, review: publicReview(caller, current.review) }, { resourceCount: 1 });
  const wire = schemas.NativeKnowledgeCognitionAcceptanceResponse.parse({ ...result.data, serviceReceipt: result.receipt }); validateNativeKnowledgeCognitionAuthority(wire, expected(caller, owner));
  if (wire.acceptance && wire.acceptance.keySha256 !== keySha256) throw new Error("Source-map exact recovery returned a different key.");
  return result;
}
export async function decideKnowledgeCognitionNativeService(caller: AppServiceCaller, reviewId: string, body: unknown) {
  const authorized = authorizeAppServiceCall(caller, getAppServiceOperationContract("app.knowledge.cognification.native.decide"));
  const request = knowledgeCognitionNativeDecisionRequestSchema.parse(body), owner = authority(caller, reviewId);
  const committed = await decideNativeKnowledgeCognition({ authority: owner, reviewId, request, idempotencyKey: caller.idempotencyKey! });
  const { memory, memoryExecutionScope, ...data } = committed;
  if (!data.replayed && memory && memoryExecutionScope) {
    try {
      const accessScope = databaseMemoryAccessScopeFromExecutionScope(memoryExecutionScope, { purposeId: MEMORY_PURPOSE_IDS.correct, auditPurpose: memoryExecutionScope.purpose });
      await indexUserPrivateMemoryGraphRecords([memory], "knowledge.cognition.review.confirm", { tenantId: owner.scope.tenantId, accessScope });
      if (explicitMemoryEntityProjectionEligible(memory)) await projectExplicitMemoryEntities({ memory, executionScope: memoryExecutionScope });
      const projected = await markKnowledgeCognitionProjected({ id: reviewId, tenantId: owner.scope.tenantId, actorId: owner.scope.ownerActorId,
        projectedMemoryId: memory.id, executionScope: owner.executionScope! });
      data.review = { ...data.review, updatedAt: projected.updatedAt, projection: "completed" };
    } catch { data.review = { ...data.review, projection: "unconfirmed" }; }
  }
  const result = completeAppServiceCall(authorized, { contract: KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT, scope: owner.scope, ...data }, { resourceCount: 1 });
  nativeKnowledgeCognitionDecisionResponseForScopeSchema({ ...expected(caller, owner), reviewId, request, idempotencyKey: caller.idempotencyKey! })
    .parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
