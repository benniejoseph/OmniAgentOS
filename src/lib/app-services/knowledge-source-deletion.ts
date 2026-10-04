import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { NativePrivateActionError, privateActionScopeSchema } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation } from "@/lib/memory/private-action-store";
import { nativeKnowledgeSourceDeletionSchemas as schemas, nativeKnowledgeSourceDeletionResponseForScopeSchema, validateNativeKnowledgeSourceDeletionAuthority } from "@/lib/mobile/knowledge-source-deletion-contracts";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { NATIVE_KNOWLEDGE_SOURCE_DELETION_READ_CONTRACT, NATIVE_KNOWLEDGE_SOURCE_PREFIXES, nativeKnowledgeSourceDeletionRequestSchema,
  nativeKnowledgeSourceKindSchema, type NativeKnowledgeSourceKind } from "@/lib/rag/source-deletion-native-contracts";
import { deleteNativeKnowledgeSource, readNativeKnowledgeSourceDeletion, reviewNativeKnowledgeSourceDeletion } from "@/lib/rag/source-deletion-native-store";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";

function authority(caller: AppServiceCaller, kind?: NativeKnowledgeSourceKind) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical) throw new NativePrivateActionError("knowledge_source_authority",403,"Current canonical source owner is required.");
  const scope = privateActionScopeSchema.parse({ tenantId: caller.context.tenantId, ownerActorId: caller.context.actorId, canonicalActorId: canonical.actorId });
  if (kind) {
    if (!caller.idempotencyKey) throw new NativePrivateActionError("knowledge_source_key",400,"An explicit local source deletion key is required.");
    const e = assertNativePrivateActionMutation({ scope, executionScope: caller.executionScope },"api.knowledge.sources.delete",knowledgeDeletionTargetId(NATIVE_KNOWLEDGE_SOURCE_PREFIXES[kind]));
    return { scope, executionScope: deriveExecutionScope(e,{ purpose: "knowledge.delete_source" }) };
  }
  if (caller.idempotencyKey || caller.executionScope) throw new NativePrivateActionError("knowledge_source_read",403,"Source inspection requires a read-only caller.");
  return { scope };
}
function expected(caller: AppServiceCaller, owner: ReturnType<typeof authority>, sourceKind: NativeKnowledgeSourceKind) {
  return { scope: owner.scope, sourceKind, requestActorId: caller.context.actorId, role: caller.context.role, executionScope: caller.executionScope };
}
export async function reviewKnowledgeSourceDeletionNativeService(caller: AppServiceCaller, sourceKind: unknown) {
  const kind = nativeKnowledgeSourceKindSchema.parse(sourceKind), owner = authority(caller);
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.knowledge.sources.native.deletion.review"));
  const current = await reviewNativeKnowledgeSourceDeletion(owner,kind);
  const review = canPerform(caller.context.role,"write.memory") ? current : { ...current, eligible: false, reason: "write_permission_required" as const, pin: null };
  const result = completeAppServiceCall(authorized,{ contract: NATIVE_KNOWLEDGE_SOURCE_DELETION_READ_CONTRACT, scope: owner.scope, sourceKind: kind, review },{ resourceCount: 1 });
  const wire = schemas.NativeKnowledgeSourceDeletionReviewResponse.parse({ ...result.data, serviceReceipt: result.receipt }); validateNativeKnowledgeSourceDeletionAuthority(wire,expected(caller,owner,kind));
  return result;
}
export async function readKnowledgeSourceDeletionNativeService(caller: AppServiceCaller, sourceKind: unknown, keySha256: string) {
  const kind = nativeKnowledgeSourceKindSchema.parse(sourceKind), owner = authority(caller);
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.knowledge.sources.native.deletion.get"));
  const acceptance = await readNativeKnowledgeSourceDeletion(owner,kind,keySha256);
  const result = completeAppServiceCall(authorized,{ contract: NATIVE_KNOWLEDGE_SOURCE_DELETION_READ_CONTRACT, scope: owner.scope, sourceKind: kind, acceptance },{ resourceCount: acceptance ? 1 : 0 });
  const wire = schemas.NativeKnowledgeSourceDeletionReadResponse.parse({ ...result.data, serviceReceipt: result.receipt }); validateNativeKnowledgeSourceDeletionAuthority(wire,expected(caller,owner,kind));
  if (wire.acceptance && wire.acceptance.keySha256 !== keySha256) throw new Error("Source deletion exact recovery returned another key.");
  return result;
}
export async function deleteKnowledgeSourceNativeService(caller: AppServiceCaller, sourceKind: unknown, body: unknown) {
  const kind = nativeKnowledgeSourceKindSchema.parse(sourceKind), owner = authority(caller,kind), request = nativeKnowledgeSourceDeletionRequestSchema.parse(body);
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.knowledge.sources.native.delete"));
  const committed = await deleteNativeKnowledgeSource({ authority: owner, sourceKind: kind, request, idempotencyKey: caller.idempotencyKey! });
  const result = completeAppServiceCall(authorized,{ contract: NATIVE_KNOWLEDGE_SOURCE_DELETION_READ_CONTRACT, scope: owner.scope, sourceKind: kind, ...committed },{ resourceCount: 1 });
  nativeKnowledgeSourceDeletionResponseForScopeSchema({ ...expected(caller,owner,kind), request, idempotencyKey: caller.idempotencyKey! }).parse({ ...result.data, serviceReceipt: result.receipt });
  return result;
}
