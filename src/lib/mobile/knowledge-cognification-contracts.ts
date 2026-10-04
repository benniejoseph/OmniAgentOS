import { z } from "zod";
import { APP_SERVICE_BOUNDARY_VERSION, appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { buildKnowledgeCognitionNativeIntent, KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT, knowledgeCognitionNativeAcceptanceSchema,
  knowledgeCognitionNativeDecisionRequestSchema, knowledgeCognitionNativeRecordSchema, knowledgeCognitionNativeStatusSchema,
  type KnowledgeCognitionNativeRequest } from "@/lib/knowledge/cognification-native-contracts";
import { privateActionScopeSchema, samePrivateActionValue, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const base = { contract: z.literal(KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT), scope: privateActionScopeSchema };
const read = { ...base, review: knowledgeCognitionNativeRecordSchema, serviceReceipt: appServiceReceiptSchema };
const issue = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });
function receipt(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx, operation: string, count: number, mutation = false) {
  const { serviceReceipt: proof, ...body } = value;
  if (proof.operation !== `app.knowledge.cognification.native.${operation}` || proof.resourceType !== "knowledge_cognition" ||
    proof.action !== (mutation ? "write.memory" : "read") || proof.accessMode !== (mutation ? "mutation" : "read") || proof.resourceCount !== count ||
    proof.eventContract !== (mutation ? "knowledge-cognification-native-events.v1" : "read_only:no_domain_mutation") ||
    (proof.idempotencyKeySha256 !== null) !== mutation || proof.outcomeSha256 !== canonicalJsonSha256(body)) issue(context, "Source-map service receipt does not bind this exact response.");
}
export const nativeKnowledgeCognitionListResponseSchema = z.object({ ...base, reviews: z.array(knowledgeCognitionNativeRecordSchema).max(50), serviceReceipt: appServiceReceiptSchema }).strict()
  .superRefine((v, c) => { receipt(v, c, "list", v.reviews.length); if (new Set(v.reviews.map((r) => r.id)).size !== v.reviews.length) issue(c, "Source-map list repeats a candidate."); });
export const nativeKnowledgeCognitionReadResponseSchema = z.object(read).strict().superRefine((v, c) => receipt(v, c, "read", 1));
const exact = { ...read, acceptance: knowledgeCognitionNativeAcceptanceSchema.nullable() };
function bindAcceptance(v: z.infer<z.ZodObject<typeof exact>>, c: z.RefinementCtx) {
  const a = v.acceptance;
  if (a && (!samePrivateActionValue(a.scope, v.scope) || a.resourceId !== v.review.id || a.result.decision !== v.review.decision ||
    a.result.status !== v.review.status || a.acceptedAt !== v.review.reviewedAt)) issue(c, "Source-map observation differs from its accepted decision.");
}
export const nativeKnowledgeCognitionAcceptanceResponseSchema = z.object(exact).strict().superRefine((v, c) => { receipt(v, c, "decision.get", 1); bindAcceptance(v, c); });
export const nativeKnowledgeCognitionDecisionResponseSchema = z.object({ ...exact, acceptance: knowledgeCognitionNativeAcceptanceSchema, replayed: z.boolean() }).strict()
  .superRefine((v, c) => { receipt(v, c, "decide", 1, true); bindAcceptance(v, c);
    if (v.acceptance.keySha256 !== v.serviceReceipt.idempotencyKeySha256) issue(c, "Source-map receipt names a different request key."); });
type Expected = { scope: PrivateActionScope; requestActorId: string; role: string; executionScope?: ExecutionScope };
export function validateNativeKnowledgeCognitionAuthority(value: { scope: PrivateActionScope; serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, expected: Expected) {
  if (!samePrivateActionValue(value.scope, expected.scope) || value.serviceReceipt.authoritySha256 !== canonicalJsonSha256({ boundaryVersion: APP_SERVICE_BOUNDARY_VERSION,
    tenantId: expected.scope.tenantId, actorId: expected.requestActorId, role: expected.role, executionScope: expected.executionScope ?? null })) throw new Error("Source-map response authority mismatch.");
}
export function nativeKnowledgeCognitionDecisionResponseForScopeSchema(expected: Expected & { reviewId: string; request: KnowledgeCognitionNativeRequest; idempotencyKey: string }) {
  const intent = buildKnowledgeCognitionNativeIntent(expected);
  return nativeKnowledgeCognitionDecisionResponseSchema.superRefine((v, c) => {
    try { validateNativeKnowledgeCognitionAuthority(v, expected); } catch { issue(c, "Source-map response belongs to another current authority."); }
    if (v.acceptance.resourceId !== expected.reviewId || v.acceptance.requestSha256 !== canonicalJsonSha256(intent) ||
      v.acceptance.keySha256 !== intent.keySha256 || v.acceptance.reviewSha256 !== expected.request.review.reviewSha256 ||
      v.acceptance.result.decision !== expected.request.decision) issue(c, "Source-map acceptance differs from the frozen request.");
  });
}
export const nativeKnowledgeCognificationSchemas = Object.freeze({
  NativeKnowledgeCognitionListQuery: z.object({ status: knowledgeCognitionNativeStatusSchema.default("pending_review"), limit: z.coerce.number().int().min(1).max(50).default(25) }).strict(),
  NativeKnowledgeCognitionDecisionRequest: knowledgeCognitionNativeDecisionRequestSchema,
  NativeKnowledgeCognitionListResponse: nativeKnowledgeCognitionListResponseSchema,
  NativeKnowledgeCognitionReadResponse: nativeKnowledgeCognitionReadResponseSchema,
  NativeKnowledgeCognitionDecisionResponse: nativeKnowledgeCognitionDecisionResponseSchema,
  NativeKnowledgeCognitionAcceptanceResponse: nativeKnowledgeCognitionAcceptanceResponseSchema,
  NativeKnowledgeCognitionError: z.object({ error: z.string().min(1).max(4000), code: z.string().min(1).max(200).optional(), message: z.string().max(4000).optional() }).strict(),
});
