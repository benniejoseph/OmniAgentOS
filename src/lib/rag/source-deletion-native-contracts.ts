import { z } from "zod";
import { privateActionAcceptanceId, privateActionKeySha256, privateActionScopeSchema, privateActionShaSchema as sha, type PrivateActionScope } from "@/lib/memory/private-action-contracts";
import { knowledgeDeletionTargetId } from "@/lib/rag/deletion-events";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NATIVE_KNOWLEDGE_SOURCE_DELETION_READ_CONTRACT = "asael-knowledge-source-deletion-read:1" as const;
export const nativeKnowledgeSourceKindSchema = z.enum(["google","mail","calendar","drive"]);
export const NATIVE_KNOWLEDGE_SOURCE_PREFIXES = Object.freeze({ google: "google:", mail: "google:mail:", calendar: "google:calendar:", drive: "google:drive:" });
export const NATIVE_KNOWLEDGE_SOURCE_DELETION_POLICY_SHA256 = canonicalJsonSha256({ version: 1, scope: "owned-private-connected-source",
  maximumDocuments: 500, maximumEvidenceUnits: 20000, maximumMemories: 2000, maximumGraphItemsPerKind: 5000, localOnly: true, exactReviewedLineage: true });
const count = z.number().int().min(0), at = z.string().datetime({ offset: true });
const pin = z.object({ sourceKind: nativeKnowledgeSourceKindSchema, documentCount: count.max(500), derivedMemoryCount: count.max(2000),
  retrievalTraceCount: count.max(5000), graphNodeCount: count.max(5000), graphEdgeCount: count.max(5000),
  manifestSha256: sha, policySha256: z.literal(NATIVE_KNOWLEDGE_SOURCE_DELETION_POLICY_SHA256) }).strict();
export const nativeKnowledgeSourceDeletionPinSchema = pin.extend({ reviewSha256: sha }).strict().superRefine((v, c) => {
  const { reviewSha256, ...body } = v; if (reviewSha256 !== canonicalJsonSha256(body)) c.addIssue({ code: "custom", message: "Source deletion review digest is inconsistent." });
});
export const nativeKnowledgeSourceDeletionReviewSchema = z.object({ sourceKind: nativeKnowledgeSourceKindSchema,
  localOnly: z.literal(true), futureImportsMayReappear: z.literal(true), eligible: z.boolean(),
  reason: z.enum(["scope_too_large","unsupported_memory_lineage","write_permission_required"]).nullable(), pin: nativeKnowledgeSourceDeletionPinSchema.nullable(),
  documents: z.array(z.object({ id: z.string().min(1).max(320), title: z.string().max(500), expired: z.boolean() }).strict()).max(500) }).strict()
  .refine((v) => v.eligible === (v.reason === null && v.pin !== null) && (v.pin === null || v.pin.sourceKind === v.sourceKind && v.pin.documentCount === v.documents.length),
    "Source deletion eligibility must describe its complete manifest.");
export const nativeKnowledgeSourceDeletionRequestSchema = z.object({ contract: z.literal("asael-knowledge-source-delete:1"), review: nativeKnowledgeSourceDeletionPinSchema }).strict();
export const nativeKnowledgeSourceDeletionIntentSchema = z.object({ contract: z.literal("asael-private-memory-action-intent:1"), operation: z.literal("knowledge.source.delete"),
  scope: privateActionScopeSchema, resourceId: z.string().regex(/^knowledge_source_[a-f0-9]{64}$/), keySha256: sha, request: nativeKnowledgeSourceDeletionRequestSchema }).strict()
  .refine((v) => v.resourceId === knowledgeDeletionTargetId(NATIVE_KNOWLEDGE_SOURCE_PREFIXES[v.request.review.sourceKind]), "Source deletion intent names another local source.");
const acceptance = z.object({ contract: z.literal("asael-knowledge-source-deletion-acceptance:1"), id: z.string().regex(/^private-action-acceptance:[a-f0-9]{64}$/),
  operation: z.literal("knowledge.source.delete"), scope: privateActionScopeSchema, resourceId: z.string().regex(/^knowledge_source_[a-f0-9]{64}$/), keySha256: sha,
  requestSha256: sha, reviewSha256: sha, acceptedAt: at, result: z.object({ sourceKind: nativeKnowledgeSourceKindSchema, localOnly: z.literal(true),
    manifestSha256: sha, documents: count.max(500), memories: count.max(2000), retrievalTraces: count.max(5000), graphNodes: count.max(5000), graphEdges: count.max(5000) }).strict() }).strict();
export const nativeKnowledgeSourceDeletionAcceptanceSchema = acceptance.extend({ acceptanceSha256: sha }).strict().superRefine((v, c) => {
  const { acceptanceSha256, ...body } = v;
  if (acceptanceSha256 !== canonicalJsonSha256(body) || v.id !== privateActionAcceptanceId(v.scope, v.keySha256) ||
    v.resourceId !== knowledgeDeletionTargetId(NATIVE_KNOWLEDGE_SOURCE_PREFIXES[v.result.sourceKind])) c.addIssue({ code: "custom", message: "Source deletion acceptance is inconsistent." });
});
export type NativeKnowledgeSourceKind = z.infer<typeof nativeKnowledgeSourceKindSchema>;
export type NativeKnowledgeSourceDeletionRequest = z.infer<typeof nativeKnowledgeSourceDeletionRequestSchema>;
export type NativeKnowledgeSourceDeletionAcceptance = z.infer<typeof nativeKnowledgeSourceDeletionAcceptanceSchema>;
export function buildNativeKnowledgeSourceDeletionIntent(input: { scope: PrivateActionScope; sourceKind: NativeKnowledgeSourceKind; request: NativeKnowledgeSourceDeletionRequest; idempotencyKey: string }) {
  if (input.sourceKind !== input.request.review.sourceKind) throw new Error("Source deletion request names another reviewed source.");
  return nativeKnowledgeSourceDeletionIntentSchema.parse({ contract: "asael-private-memory-action-intent:1", operation: "knowledge.source.delete", scope: input.scope,
    resourceId: knowledgeDeletionTargetId(NATIVE_KNOWLEDGE_SOURCE_PREFIXES[input.sourceKind]), keySha256: privateActionKeySha256(input.scope, input.idempotencyKey), request: input.request });
}
export function sealNativeKnowledgeSourceDeletionPin(input: z.input<typeof pin>) { const value = pin.parse(input); return nativeKnowledgeSourceDeletionPinSchema.parse({ ...value, reviewSha256: canonicalJsonSha256(value) }); }
export function sealNativeKnowledgeSourceDeletionAcceptance(input: z.input<typeof acceptance>) { const value = acceptance.parse(input); return nativeKnowledgeSourceDeletionAcceptanceSchema.parse({ ...value, acceptanceSha256: canonicalJsonSha256(value) }); }
