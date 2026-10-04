import { authorizeAppServiceCall, completeAppServiceCall, type AppServiceCaller } from "@/lib/app-services/contracts";
import { getAppServiceOperationContract } from "@/lib/app-services/registry";
import { NATIVE_COGNITION_BUILD_READ_CONTRACT, nativeCognitionBuildRequestSchema } from "@/lib/knowledge/cognification-build-native-contracts";
import { readNativeKnowledgeCognitionBuild, reviewNativeKnowledgeCognitionBuild, submitNativeKnowledgeCognitionBuild } from "@/lib/knowledge/cognification-build-native-store";
import { NativePrivateActionError, privateActionScopeSchema } from "@/lib/memory/private-action-contracts";
import { assertNativePrivateActionMutation } from "@/lib/memory/private-action-store";
import { nativeCognitionBuildResponseForScopeSchema, nativeKnowledgeCognitionBuildSchemas as schemas, validateNativeCognitionBuildAuthority } from "@/lib/mobile/knowledge-cognition-build-contracts";
import { canonicalAuthUserActorFromSecurityContext } from "@/lib/security/canonical-actor";
import { canPerform } from "@/lib/security/context";
import { deriveExecutionScope } from "@/lib/security/execution-scope";
function authority(caller: AppServiceCaller,documentId: string,write = false) {
  const canonical = canonicalAuthUserActorFromSecurityContext(caller.context);
  if (!canonical) throw new NativePrivateActionError("cognition_build_authority",403,"Current canonical source owner is required.");
  const scope = privateActionScopeSchema.parse({ tenantId: caller.context.tenantId,ownerActorId: caller.context.actorId,canonicalActorId: canonical.actorId });
  if (write) { if (!caller.idempotencyKey) throw new NativePrivateActionError("cognition_build_key",400,"An explicit cognition build key is required.");
    const execution = assertNativePrivateActionMutation({ scope,executionScope: caller.executionScope },"api.knowledge.cognification.build",documentId);
    return { scope,executionScope: deriveExecutionScope(execution,{ purpose: "knowledge.cognition.queue" }) }; }
  if (caller.executionScope || caller.idempotencyKey) throw new NativePrivateActionError("cognition_build_read",403,"Build reads require read-only authority.");
  return { scope };
}
const expected = (caller: AppServiceCaller,scope: ReturnType<typeof authority>["scope"],documentId: string) =>
  ({ scope,documentId,requestActorId: caller.context.actorId,role: caller.context.role,executionScope: caller.executionScope });
export async function reviewKnowledgeCognitionBuildService(caller: AppServiceCaller,documentId: string) {
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.knowledge.cognification.native.build.review")),owner = authority(caller,documentId);
  const current = await reviewNativeKnowledgeCognitionBuild(owner,documentId),review = canPerform(caller.context.role,"write.memory") ? current : { ...current,eligible: false,reason: "write_permission_required" as const };
  const result = completeAppServiceCall(authorized,{ contract: NATIVE_COGNITION_BUILD_READ_CONTRACT,scope: owner.scope,documentId,review },{ resourceCount: 1 });
  validateNativeCognitionBuildAuthority(schemas.NativeKnowledgeCognitionBuildReviewResponse.parse({ ...result.data,serviceReceipt: result.receipt }),expected(caller,owner.scope,documentId)); return result;
}
export async function readKnowledgeCognitionBuildService(caller: AppServiceCaller,documentId: string,keySha256: string) {
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.knowledge.cognification.native.build.get")),owner = authority(caller,documentId);
  const current = await readNativeKnowledgeCognitionBuild(owner,documentId,keySha256);
  const result = completeAppServiceCall(authorized,{ contract: NATIVE_COGNITION_BUILD_READ_CONTRACT,scope: owner.scope,documentId,...current },{ resourceCount: current.acceptance ? 1 : 0 });
  const wire = schemas.NativeKnowledgeCognitionBuildReadResponse.parse({ ...result.data,serviceReceipt: result.receipt }); validateNativeCognitionBuildAuthority(wire,expected(caller,owner.scope,documentId));
  if (wire.acceptance && wire.acceptance.keySha256 !== keySha256) throw new Error("Build recovery returned another key."); return result;
}
export async function submitKnowledgeCognitionBuildService(caller: AppServiceCaller,documentId: string,body: unknown) {
  const authorized = authorizeAppServiceCall(caller,getAppServiceOperationContract("app.knowledge.cognification.native.build")),owner = authority(caller,documentId,true),request = nativeCognitionBuildRequestSchema.parse(body);
  const current = await submitNativeKnowledgeCognitionBuild({ authority: owner,documentId,request,idempotencyKey: caller.idempotencyKey! });
  const result = completeAppServiceCall(authorized,{ contract: NATIVE_COGNITION_BUILD_READ_CONTRACT,scope: owner.scope,documentId,...current },{ resourceCount: 1 });
  nativeCognitionBuildResponseForScopeSchema({ ...expected(caller,owner.scope,documentId),request,idempotencyKey: caller.idempotencyKey! }).parse({ ...result.data,serviceReceipt: result.receipt }); return result;
}
