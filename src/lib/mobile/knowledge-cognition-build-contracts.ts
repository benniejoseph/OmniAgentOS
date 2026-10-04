import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { buildNativeCognitionBuildIntent, NATIVE_COGNITION_BUILD_READ_CONTRACT, nativeCognitionBuildAcceptanceSchema, nativeCognitionBuildProcessingSchema,
  nativeCognitionBuildRequestSchema, nativeCognitionBuildReviewSchema, type NativeCognitionBuildRequest } from "@/lib/knowledge/cognification-build-native-contracts";
import { privateActionIdSchema, privateActionScopeSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
const issue = (c: z.RefinementCtx,message: string) => c.addIssue({ code: "custom",message });
const base = { contract: z.literal(NATIVE_COGNITION_BUILD_READ_CONTRACT),scope: privateActionScopeSchema,documentId: privateActionIdSchema };
function receipt(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> },c: z.RefinementCtx,op: string,mutation: boolean,count: number) {
  const { serviceReceipt: r,...body } = value;
  if (r.operation !== `app.knowledge.cognification.native.${op}` || r.action !== (mutation ? "write.memory" : "read") || r.resourceType !== "knowledge_cognition" ||
    r.accessMode !== (mutation ? "mutation" : "read") || r.eventContract !== (mutation ? "knowledge-cognification-build-native-events.v1" : "read_only:no_domain_mutation") ||
    r.resourceCount !== count || (r.idempotencyKeySha256 !== null) !== mutation || r.outcomeSha256 !== canonicalJsonSha256(body)) issue(c,"Build service receipt does not bind this exact response.");
}
export const nativeKnowledgeCognitionBuildReviewResponseSchema = z.object({ ...base,review: nativeCognitionBuildReviewSchema,serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((v,c) => { receipt(v,c,"build.review",false,1); if (v.review.documentId !== v.documentId) issue(c,"Build review names another document."); });
const result = { ...base,acceptance: nativeCognitionBuildAcceptanceSchema.nullable(),processing: nativeCognitionBuildProcessingSchema.nullable(),serviceReceipt: appServiceReceiptSchema };
function accepted(v: z.infer<z.ZodObject<typeof result>>,c: z.RefinementCtx) {
  if (Boolean(v.acceptance) !== Boolean(v.processing) || v.acceptance && (!samePrivateActionValue(v.acceptance.scope,v.scope) || v.acceptance.documentId !== v.documentId ||
    v.processing?.totalBatches !== v.acceptance.totalBatches || (v.processing?.reusedBatches ?? 0) > v.acceptance.reusedBatches)) issue(c,"Build observation names another acceptance or owner.");
}
export const nativeKnowledgeCognitionBuildReadResponseSchema = z.object(result).strict().superRefine((v,c) => { receipt(v,c,"build.get",false,v.acceptance ? 1 : 0); accepted(v,c); });
export const nativeKnowledgeCognitionBuildResponseSchema = z.object({ ...result,acceptance: nativeCognitionBuildAcceptanceSchema,processing: nativeCognitionBuildProcessingSchema,replayed: z.boolean() }).strict()
  .superRefine((v,c) => { receipt(v,c,"build",true,1); accepted(v,c); if (v.serviceReceipt.idempotencyKeySha256 !== v.acceptance.keySha256) issue(c,"Build receipt names another key."); });
type Expected = { scope: PrivateActionScope;documentId: string;requestActorId: string;role: string;executionScope?: ExecutionScope };
export function validateNativeCognitionBuildAuthority(v: { scope: PrivateActionScope;documentId: string;serviceReceipt: z.infer<typeof appServiceReceiptSchema> },e: Expected) {
  if (!samePrivateActionValue(v.scope,e.scope) || v.documentId !== e.documentId || v.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: e.scope.tenantId,actorId: e.requestActorId,role: e.role,executionScope: e.executionScope ?? null })) throw new Error("Build response belongs to another current authority.");
}
export function nativeCognitionBuildResponseForScopeSchema(expected: Expected & { request: NativeCognitionBuildRequest;idempotencyKey: string }) {
  const intent = buildNativeCognitionBuildIntent(expected),pin = intent.request.review;
  return nativeKnowledgeCognitionBuildResponseSchema.superRefine((v,c) => {
    try { validateNativeCognitionBuildAuthority(v,expected); } catch { issue(c,"Build response authority changed."); }
    const a = v.acceptance;
    if (a.keySha256 !== intent.keySha256 || a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== pin.reviewSha256 ||
      a.sourcePlanSha256 !== pin.sourcePlanSha256 || a.totalBatches !== pin.batchCount || a.reusedBatches !== pin.existingReviewCount) issue(c,"Build acceptance differs from the exact reviewed intent.");
  });
}
export const nativeKnowledgeCognitionBuildSchemas = Object.freeze({ NativeKnowledgeCognitionBuildRequest: nativeCognitionBuildRequestSchema,
  NativeKnowledgeCognitionBuildReviewResponse: nativeKnowledgeCognitionBuildReviewResponseSchema,NativeKnowledgeCognitionBuildResponse: nativeKnowledgeCognitionBuildResponseSchema,
  NativeKnowledgeCognitionBuildReadResponse: nativeKnowledgeCognitionBuildReadResponseSchema,
  NativeKnowledgeCognitionBuildError: z.object({ error: z.string().min(1).max(4000),code: z.string().min(1).max(200).optional(),message: z.string().max(4000).optional() }).strict() });
