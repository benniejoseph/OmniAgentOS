import { z } from "zod";
import { privateActionIdSchema as id, privateActionKeySha256, privateActionScopeSchema, privateActionShaSchema as sha, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { knowledgeCognitionNativeIdSchema } from "@/lib/knowledge/cognification-native-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NATIVE_COGNITION_BUILD_READ_CONTRACT = "asael-knowledge-cognition-build-read:1" as const;
export const NATIVE_COGNITION_BUILD_POLICY_SHA256 = canonicalJsonSha256({ version: 1, source: "exact_owned_current_document", providerAttempts: 1,
  recovery: "get_only", output: "unconfirmed_source_maps", uncertainProviderEffect: "hold", maximumChunks: 2048, maximumCharacters: 1000000 });
const at = z.string().datetime({ offset: true }), count = z.number().int().min(0).max(2048);
const pin = z.object({ documentId: id,sourceItemId: id,sourceRevisionId: id,sourcePolicySha256: sha,retentionExpiresAt: at.nullable(),
  generationId: z.string().regex(/^cognition_generation_[a-f0-9]{48}$/),sourcePlanSha256: sha,batchCount: count.min(1),
  existingReviewCount: count,existingReviewManifestSha256: sha,policySha256: z.literal(NATIVE_COGNITION_BUILD_POLICY_SHA256) }).strict();
export const nativeCognitionBuildPinSchema = pin.extend({ reviewSha256: sha }).strict().superRefine((v,c) => {
  const { reviewSha256,...body } = v;
  if (v.existingReviewCount > v.batchCount || reviewSha256 !== canonicalJsonSha256(body)) c.addIssue({ code: "custom",message: "Build review does not bind its complete source plan." });
});
export const nativeCognitionBuildReviewSchema = z.object({ documentId: id,title: z.string().min(1).max(500),pin: nativeCognitionBuildPinSchema,
  eligible: z.boolean(),reason: z.enum(["model_unavailable","already_completed","already_accepted","legacy_work_unconfirmed","write_permission_required"]).nullable(),
  model: z.object({ provider: z.string().min(1).max(80).nullable(),model: z.string().min(1).max(240).nullable() }).strict() }).strict()
  .refine((v) => v.eligible === (v.reason === null) && v.documentId === v.pin.documentId,"Build eligibility must name the exact reviewed document.");
export const nativeCognitionBuildRequestSchema = z.object({ contract: z.literal("asael-knowledge-cognition-build:1"),review: nativeCognitionBuildPinSchema }).strict();
export const nativeCognitionBuildIntentSchema = z.object({ contract: z.literal("asael-knowledge-cognition-build-intent:1"),scope: privateActionScopeSchema,
  documentId: id,keySha256: sha,request: nativeCognitionBuildRequestSchema }).strict().refine((v) => v.documentId === v.request.review.documentId,"Build intent names another document.");
const acceptance = z.object({ contract: z.literal("asael-knowledge-cognition-build-acceptance:1"),id: z.string().regex(/^cognition-build-acceptance:[a-f0-9]{64}$/),
  scope: privateActionScopeSchema,documentId: id,keySha256: sha,requestSha256: sha,reviewSha256: sha,sourcePlanSha256: sha,
  operationJobId: id,totalBatches: count.min(1),reusedBatches: count,acceptedAt: at }).strict();
export const nativeCognitionBuildAcceptanceSchema = acceptance.extend({ acceptanceSha256: sha }).strict().superRefine((v,c) => {
  const { acceptanceSha256,...body } = v;
  if (v.reusedBatches >= v.totalBatches || v.id !== cognitionBuildAcceptanceId(v.scope,v.keySha256) || acceptanceSha256 !== canonicalJsonSha256(body))
    c.addIssue({ code: "custom",message: "Build acceptance identity or progress is inconsistent." });
});
export const nativeCognitionBuildProcessingSchema = z.object({ phase: z.enum(["queued","processing","completed","reconciliation_required","blocked"]),
  totalBatches: count.min(1),completedBatches: count,reusedBatches: count,reviewIds: z.array(knowledgeCognitionNativeIdSchema).max(2048),
  reason: z.enum(["source_changed","authority_changed","model_changed","provider_effect_unconfirmed","job_unavailable"]).nullable(),
  automaticRetryAllowed: z.literal(false) }).strict().refine((v) => v.completedBatches <= v.totalBatches && v.reusedBatches <= v.completedBatches &&
    v.reviewIds.length === v.completedBatches && new Set(v.reviewIds).size === v.reviewIds.length &&
    (v.phase !== "completed" || v.completedBatches === v.totalBatches && v.reason === null),"Build processing observation is inconsistent.");
export type NativeCognitionBuildRequest = z.infer<typeof nativeCognitionBuildRequestSchema>;
export type NativeCognitionBuildIntent = z.infer<typeof nativeCognitionBuildIntentSchema>;
export type NativeCognitionBuildAcceptance = z.infer<typeof nativeCognitionBuildAcceptanceSchema>;
export type NativeCognitionBuildProcessing = z.infer<typeof nativeCognitionBuildProcessingSchema>;
export function cognitionBuildAcceptanceId(scope: PrivateActionScope,keySha256: string) { return `cognition-build-acceptance:${canonicalJsonSha256({ scope,keySha256 })}`; }
export function buildNativeCognitionBuildIntent(input: { scope: PrivateActionScope; documentId: string; request: NativeCognitionBuildRequest; idempotencyKey: string }) {
  return nativeCognitionBuildIntentSchema.parse({ contract: "asael-knowledge-cognition-build-intent:1",scope: input.scope,documentId: input.documentId,
    keySha256: privateActionKeySha256(input.scope,input.idempotencyKey),request: input.request });
}
export function sealNativeCognitionBuildPin(input: z.input<typeof pin>) { const body = pin.parse(input); return nativeCognitionBuildPinSchema.parse({ ...body,reviewSha256: canonicalJsonSha256(body) }); }
export function sealNativeCognitionBuildAcceptance(input: z.input<typeof acceptance>) { const body = acceptance.parse(input); return nativeCognitionBuildAcceptanceSchema.parse({ ...body,acceptanceSha256: canonicalJsonSha256(body) }); }
