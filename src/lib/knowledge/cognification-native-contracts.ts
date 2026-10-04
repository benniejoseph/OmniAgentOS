import { z } from "zod";
import { privateActionAcceptanceId, privateActionIdSchema as id, privateActionKeySha256, privateActionScopeSchema,
  privateActionShaSchema as sha, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const KNOWLEDGE_COGNITION_NATIVE_READ_CONTRACT = "asael-knowledge-cognition-read:1" as const;
export const KNOWLEDGE_COGNITION_NATIVE_POLICY_SHA256 = canonicalJsonSha256({ version: 1, operation: "knowledge.cognition.decide",
  scope: "current-owner-private", review: "exact-source-policy-and-candidate", formation: "reviewed_source_cognition", projections: "new-commit-only" });
export const knowledgeCognitionNativeIdSchema = z.string().regex(/^cognition_batch_[a-f0-9]{48}$/);
const at = z.string().datetime({ offset: true });
export const knowledgeCognitionNativeStatusSchema = z.enum(["pending_review", "confirmed", "dismissed"]);
const pin = z.object({ candidateId: knowledgeCognitionNativeIdSchema, candidateSha256: sha, documentId: id, sourceItemId: id,
  sourceRevisionId: id, sourcePolicySha256: sha, retentionExpiresAt: at.nullable(), reviewStateSha256: sha,
  policySha256: z.literal(KNOWLEDGE_COGNITION_NATIVE_POLICY_SHA256) }).strict();
export const knowledgeCognitionNativeReviewPinSchema = pin.extend({ reviewSha256: sha }).strict().superRefine((value, context) => {
  const { reviewSha256, ...body } = value;
  if (reviewSha256 !== canonicalJsonSha256(body)) context.addIssue({ code: "custom", message: "Source map review digest is inconsistent." });
});
export const knowledgeCognitionNativeDecisionRequestSchema = z.object({ contract: z.literal("asael-knowledge-cognition-decision:1"),
  decision: z.enum(["confirm", "dismiss"]), review: knowledgeCognitionNativeReviewPinSchema }).strict();
export const knowledgeCognitionNativeIntentSchema = z.object({ contract: z.literal("asael-private-memory-action-intent:1"),
  operation: z.literal("knowledge.cognition.decide"), scope: privateActionScopeSchema, resourceId: knowledgeCognitionNativeIdSchema,
  keySha256: sha, request: knowledgeCognitionNativeDecisionRequestSchema }).strict().refine((v) => v.resourceId === v.request.review.candidateId,
  "Source map intent must name its reviewed candidate.");
const acceptance = z.object({ contract: z.literal("asael-knowledge-cognition-acceptance:1"),
  id: z.string().regex(/^private-action-acceptance:[a-f0-9]{64}$/), operation: z.literal("knowledge.cognition.decide"), scope: privateActionScopeSchema,
  resourceId: knowledgeCognitionNativeIdSchema, keySha256: sha, requestSha256: sha, reviewSha256: sha, acceptedAt: at,
  result: z.object({ decision: z.enum(["confirm", "dismiss"]), status: z.enum(["confirmed", "dismissed"]),
    memoryId: id.nullable(), memoryTargetRevision: z.literal(1).nullable() }).strict() }).strict();
export const knowledgeCognitionNativeAcceptanceSchema = acceptance.extend({ acceptanceSha256: sha }).strict().superRefine((v, context) => {
  const { acceptanceSha256, ...body } = v, confirm = v.result.decision === "confirm";
  if (acceptanceSha256 !== canonicalJsonSha256(body) || v.id !== privateActionAcceptanceId(v.scope, v.keySha256) ||
    v.result.status !== (confirm ? "confirmed" : "dismissed") ||
    (confirm ? v.result.memoryId !== `memory:${v.resourceId}` || v.result.memoryTargetRevision !== 1 : v.result.memoryId !== null || v.result.memoryTargetRevision !== null)) {
    context.addIssue({ code: "custom", message: "Source map acceptance is inconsistent." });
  }
});
export const knowledgeCognitionNativeRecordSchema = z.object({ id: knowledgeCognitionNativeIdSchema, documentId: id, sourceTitle: z.string().min(1).max(500),
  status: knowledgeCognitionNativeStatusSchema, decision: z.enum(["confirm", "dismiss"]).nullable(), createdAt: at, updatedAt: at, reviewedAt: at.nullable(),
  batchIndex: z.number().int().min(0).max(9999), batchCount: z.number().int().min(1).max(10000),
  summary: z.object({ text: z.string().min(1).max(4000), confidenceBasisPoints: z.number().int().min(0).max(10000),
    evidence: z.array(z.object({ quote: z.string().min(1).max(1200) }).strict()).min(1).max(8) }).strict(),
  topics: z.array(z.object({ label: z.string().min(1).max(160) }).strict()).max(24),
  claims: z.array(z.object({ statement: z.string().min(1).max(1200) }).strict()).max(48),
  entities: z.array(z.object({ canonicalLabel: z.string().min(1).max(320) }).strict()).max(48),
  relations: z.array(z.object({ statement: z.string().min(1).max(1200) }).strict()).max(64),
  allowedDecisions: z.array(z.enum(["confirm", "dismiss"])).max(2), review: knowledgeCognitionNativeReviewPinSchema.nullable(),
  projection: z.enum(["not_requested", "unconfirmed", "completed"]) }).strict().superRefine((v, context) => {
  if (v.batchIndex >= v.batchCount || new Set(v.allowedDecisions).size !== v.allowedDecisions.length ||
    Boolean(v.review) !== Boolean(v.allowedDecisions.length) || (v.review && (v.review.candidateId !== v.id || v.review.documentId !== v.documentId)) ||
    (v.status === "pending_review" ? v.decision !== null || v.reviewedAt !== null : v.decision !== (v.status === "confirmed" ? "confirm" : "dismiss") || !v.reviewedAt) ||
    (v.status !== "pending_review" && v.allowedDecisions.length > 0)) context.addIssue({ code: "custom", message: "Source map review state is inconsistent." });
});
export type KnowledgeCognitionNativeRequest = z.infer<typeof knowledgeCognitionNativeDecisionRequestSchema>;
export type KnowledgeCognitionNativeIntent = z.infer<typeof knowledgeCognitionNativeIntentSchema>;
export type KnowledgeCognitionNativeAcceptance = z.infer<typeof knowledgeCognitionNativeAcceptanceSchema>;
export type KnowledgeCognitionNativeRecord = z.infer<typeof knowledgeCognitionNativeRecordSchema>;
export function buildKnowledgeCognitionNativeIntent(input: { scope: PrivateActionScope; reviewId: string; idempotencyKey: string; request: KnowledgeCognitionNativeRequest }) {
  return knowledgeCognitionNativeIntentSchema.parse({ contract: "asael-private-memory-action-intent:1", operation: "knowledge.cognition.decide",
    scope: input.scope, resourceId: input.reviewId, keySha256: privateActionKeySha256(input.scope, input.idempotencyKey), request: input.request });
}
export function sealKnowledgeCognitionNativePin(value: z.input<typeof pin>) { const body = pin.parse(value); return knowledgeCognitionNativeReviewPinSchema.parse({ ...body, reviewSha256: canonicalJsonSha256(body) }); }
export function sealKnowledgeCognitionNativeAcceptance(value: z.input<typeof acceptance>) { const body = acceptance.parse(value); return knowledgeCognitionNativeAcceptanceSchema.parse({ ...body, acceptanceSha256: canonicalJsonSha256(body) }); }
