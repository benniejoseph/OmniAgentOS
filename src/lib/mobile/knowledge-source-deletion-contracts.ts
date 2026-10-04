import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { privateActionScopeSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { buildNativeKnowledgeSourceDeletionIntent, NATIVE_KNOWLEDGE_SOURCE_DELETION_READ_CONTRACT, nativeKnowledgeSourceDeletionAcceptanceSchema,
  nativeKnowledgeSourceDeletionRequestSchema, nativeKnowledgeSourceDeletionReviewSchema, nativeKnowledgeSourceKindSchema,
  type NativeKnowledgeSourceDeletionRequest, type NativeKnowledgeSourceKind } from "@/lib/rag/source-deletion-native-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const base = { contract: z.literal(NATIVE_KNOWLEDGE_SOURCE_DELETION_READ_CONTRACT), scope: privateActionScopeSchema, sourceKind: nativeKnowledgeSourceKindSchema };
const issue = (c: z.RefinementCtx, message: string) => c.addIssue({ code: "custom", message });
function receipt(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, c: z.RefinementCtx, op: string, mutation: boolean, count: number) {
  const { serviceReceipt: r, ...body } = value;
  if (r.operation !== `app.knowledge.sources.native.${op}` || r.resourceType !== "knowledge" || r.action !== (mutation ? "write.memory" : "read") ||
    r.accessMode !== (mutation ? "mutation" : "read") || r.eventContract !== (mutation ? "knowledge-source-deletion-native-events.v1" : "read_only:no_domain_mutation") ||
    r.resourceCount !== count || (r.idempotencyKeySha256 !== null) !== mutation || r.outcomeSha256 !== canonicalJsonSha256(body)) issue(c, "Source deletion service receipt does not bind this exact response.");
}
export const nativeKnowledgeSourceDeletionReviewResponseSchema = z.object({ ...base, review: nativeKnowledgeSourceDeletionReviewSchema, serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((v,c) => { receipt(v,c,"deletion.review",false,1); if (v.sourceKind !== v.review.sourceKind) issue(c,"Source deletion review names another source."); });
const exact = { ...base, acceptance: nativeKnowledgeSourceDeletionAcceptanceSchema.nullable(), serviceReceipt: appServiceReceiptSchema };
function accepted(v: z.infer<z.ZodObject<typeof exact>>, c: z.RefinementCtx) {
  if (v.acceptance && (!samePrivateActionValue(v.scope,v.acceptance.scope) || v.sourceKind !== v.acceptance.result.sourceKind)) issue(c,"Source deletion acceptance names another owner or source.");
}
export const nativeKnowledgeSourceDeletionReadResponseSchema = z.object(exact).strict().superRefine((v,c) => { receipt(v,c,"deletion.get",false,v.acceptance ? 1 : 0); accepted(v,c); });
export const nativeKnowledgeSourceDeletionResponseSchema = z.object({ ...exact, acceptance: nativeKnowledgeSourceDeletionAcceptanceSchema, replayed: z.boolean() }).strict()
  .superRefine((v,c) => { receipt(v,c,"delete",true,1); accepted(v,c); if (v.acceptance.keySha256 !== v.serviceReceipt.idempotencyKeySha256) issue(c,"Source deletion receipt names another key."); });
type Expected = { scope: PrivateActionScope; sourceKind: NativeKnowledgeSourceKind; requestActorId: string; role: string; executionScope?: ExecutionScope };
export function validateNativeKnowledgeSourceDeletionAuthority(v: { scope: PrivateActionScope; sourceKind: NativeKnowledgeSourceKind; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, e: Expected) {
  if (!samePrivateActionValue(v.scope,e.scope) || v.sourceKind !== e.sourceKind || v.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: e.scope.tenantId, actorId: e.requestActorId, role: e.role, executionScope: e.executionScope ?? null })) throw new Error("Source deletion response authority mismatch.");
}
export function nativeKnowledgeSourceDeletionResponseForScopeSchema(expected: Expected & { idempotencyKey: string; request: NativeKnowledgeSourceDeletionRequest }) {
  const intent = buildNativeKnowledgeSourceDeletionIntent(expected), r = intent.request.review;
  return nativeKnowledgeSourceDeletionResponseSchema.superRefine((v,c) => {
    try { validateNativeKnowledgeSourceDeletionAuthority(v,expected); } catch { issue(c,"Source deletion belongs to another current authority."); }
    const a = v.acceptance;
    if (a.keySha256 !== intent.keySha256 || a.requestSha256 !== canonicalJsonSha256(intent) || a.reviewSha256 !== r.reviewSha256 || a.result.manifestSha256 !== r.manifestSha256 ||
      a.result.documents !== r.documentCount || a.result.memories !== r.derivedMemoryCount || a.result.retrievalTraces !== r.retrievalTraceCount ||
      a.result.graphNodes !== r.graphNodeCount || a.result.graphEdges !== r.graphEdgeCount) issue(c,"Source deletion differs from the exact reviewed intent.");
  });
}
export const nativeKnowledgeSourceDeletionSchemas = Object.freeze({
  NativeKnowledgeSourceKind: nativeKnowledgeSourceKindSchema,
  NativeKnowledgeSourceDeletionRequest: nativeKnowledgeSourceDeletionRequestSchema,
  NativeKnowledgeSourceDeletionReviewResponse: nativeKnowledgeSourceDeletionReviewResponseSchema,
  NativeKnowledgeSourceDeletionResponse: nativeKnowledgeSourceDeletionResponseSchema,
  NativeKnowledgeSourceDeletionReadResponse: nativeKnowledgeSourceDeletionReadResponseSchema,
  NativeKnowledgeSourceDeletionError: z.object({ error: z.string().min(1).max(4000), code: z.string().min(1).max(200).optional(), message: z.string().max(4000).optional() }).strict(),
});
