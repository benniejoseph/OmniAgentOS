import { z } from "zod";
import { appServiceReceiptSchema } from "@/lib/app-services/receipt-contracts";
import { memoryFormationReasonSchema, memoryTierSchema } from "@/lib/memory/tier-policy";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

// Publication shapes only: no store, embedding, projection or secret-dependent
// implementation is imported here. Enrollment does not change replay semantics.
const id = z.string().min(1).max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
const opaque = z.string().min(1).max(500);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const at = z.string().datetime({ offset: true });
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fraction = z.number().min(0).max(1);
const memoryType = z.enum(["preference", "fact", "episode", "procedure", "knowledge", "decision", "task"]);
const claim = z.enum(["active", "candidate", "superseded", "contradicted", "forgotten"]);
const archiveReason = z.enum(["manual", "exact_duplicate", "retention_expired"]);
const action = z.enum(["pin", "unpin", "archive", "restore"]);
const problem = (context: z.RefinementCtx, message: string) => context.addIssue({ code: "custom", message });

const policy = z.object({
  version: z.literal(1), tier: memoryTierSchema,
  retention: z.object({ mode: z.enum(["time_bounded", "source_policy", "until_invalidated", "obligation_lifecycle"]), defaultDays: z.number().nonnegative().nullable(), expiredRecordsAreRetrievable: z.literal(false) }).strict(),
  promotion: z.object({ targets: z.array(memoryTierSchema).max(8), automatic: z.literal(false), minimumVerifiedOccurrences: count, review: z.enum(["user_or_governed_evidence_review", "not_promotable"]) }).strict(),
  correction: z.object({ strategy: z.literal("superseding_revision"), preserveHistory: z.literal(true), confidenceIncreaseRequiresEvidence: z.literal(true) }).strict(),
  retrieval: z.object({ requiresActiveClaim: z.literal(true), requiresTemporalValidity: z.literal(true), requiresAuthorizedScope: z.literal(true), sessionAffinityRequired: z.boolean(), priorityWeight: z.number().nonnegative() }).strict(),
}).strict();
const publicAccess = z.object({
  visibility: z.enum(["agent_private", "user_private", "mission_shared", "project_shared", "workspace_shared", "user_legacy", "project_legacy", "workspace_legacy"]),
  sensitivity: z.enum(["public", "internal", "confidential", "restricted", "legacy_unspecified"]),
  scope: z.enum(["user", "workspace", "project"]), owner: z.literal("current_user").optional(),
  agentId: opaque.nullable().optional(), workspaceId: opaque.nullable().optional(), projectId: opaque.nullable().optional(), missionId: opaque.nullable().optional(),
}).strict();
export const nativeMemoryRecordSchema = z.object({
  id, tenantId: z.string().min(1).max(120).optional(), type: memoryType, tier: memoryTierSchema, tierPolicyVersion: z.literal(1),
  formationReason: memoryFormationReasonSchema.optional(), title: z.string().max(240), content: z.string().max(200_000),
  tags: z.array(z.string().max(80)).max(50), scope: z.enum(["user", "workspace", "project"]), source: z.string().max(4_000),
  importance: fraction, confidence: fraction.optional(), claimStatus: claim.optional(), assertedBy: z.enum(["user", "agent", "system", "import"]).optional(),
  evidenceRefs: z.array(z.string().max(500)).max(50).optional(), validFrom: at.optional(), validTo: at.optional(),
  supersedesId: id.optional(), contradictionOfId: id.optional(), forgottenAt: at.optional(), retentionExpiresAt: at.optional(),
  lastUsedAt: at.optional(), useCount: count.optional(), promotedFromTier: memoryTierSchema.optional(), promotedAt: at.optional(),
  pinnedAt: at.optional(), archivedAt: at.optional(), archiveReason: archiveReason.optional(), duplicateOfMemoryId: id.optional(),
  createdAt: at, updatedAt: at, access: publicAccess,
  explainability: z.object({
    why: z.string().max(1_000), source: z.string().max(4_000), scope: z.enum(["user", "workspace", "project"]), confidence: fraction,
    lastUsedAt: at.nullable(), useCount: count, validity: z.enum(["archived", "retention_expired", "outside_validity_interval", "active", "candidate", "superseded", "contradicted", "forgotten"]),
    validFrom: at.nullable(), validTo: at.nullable(), retentionExpiresAt: at.nullable(), policy,
    lifecycle: z.object({ policyVersion: z.literal(1), pinned: z.boolean(), pinnedAt: at.nullable(), archived: z.boolean(), archivedAt: at.nullable(),
      archiveReason: archiveReason.nullable(), duplicateOfMemoryId: id.nullable(), retrievalPriorityMultiplier: z.number().nonnegative(), historicalTruthChanged: z.literal(false) }).strict(),
  }).strict(),
}).strict();
export const nativeMemoryCreateRequestSchema = z.object({
  title: z.string().trim().min(1).max(240), content: z.string().min(1).max(200_000), type: memoryType.optional(), tier: memoryTierSchema.optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(), importance: fraction.optional(), confidence: fraction.optional(),
  evidenceRefs: z.array(z.string().trim().min(1).max(500)).max(50).optional(), validFrom: z.string().datetime().optional(), validTo: z.string().datetime().optional(),
}).strict();
export const nativeMemoryCorrectionRequestSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(), content: z.string().min(1).max(200_000).optional(),
  confidence: fraction.optional(), validTo: z.string().datetime().optional(), contradiction: z.boolean().optional(),
}).strict().refine((value) => Object.values(value).some((entry) => entry !== undefined), { message: "At least one correction field is required." });

function receipt(operation: string, mutation = true) {
  return appServiceReceiptSchema.superRefine((value, context) => {
    if (value.operation !== operation || value.accessMode !== (mutation ? "mutation" : "read") || value.resourceType !== "memory" ||
      value.action !== (mutation ? "write.memory" : "read") || value.eventContract !== (mutation ? "memory.atomic-events.v1" : "read_only:no_domain_mutation") ||
      (value.idempotencyKeySha256 !== null) !== mutation) problem(context, "Receipt operation or authority differs.");
  });
}
function outcome(value: { serviceReceipt: z.infer<typeof appServiceReceiptSchema> }, context: z.RefinementCtx, data?: unknown) {
  const { serviceReceipt, ...body } = value;
  if (serviceReceipt.outcomeSha256 !== canonicalJsonSha256(data ?? body)) problem(context, "Receipt does not bind the returned service data.");
}
export const nativeMemoryCreateResponseSchema = z.object({
  record: nativeMemoryRecordSchema,
  entityProjection: z.object({ candidateCount: count, createdCount: count, linkedCount: count, reviewRequiredCount: count }).strict().optional(),
  serviceReceipt: receipt("memory.write"),
}).strict().superRefine((value, context) => outcome(value, context));
const reconciliation = z.object({
  id: opaque, tenantId: opaque, kind: z.enum(["confirmation", "contradiction"]), status: z.enum(["pending", "resolved"]),
  decision: z.enum(["confirm_candidate", "keep_existing", "keep_both"]).optional(),
  detectionReason: z.enum(["unconfirmed_candidate", "unverified_inference", "unverified_workflow_output", "similar_claim_conflict", "explicit_contradiction", "legacy_candidate"]),
  candidate: nativeMemoryRecordSchema, existing: nativeMemoryRecordSchema.optional(), createdAt: at, updatedAt: at, resolvedAt: at.optional(),
}).strict();
export const nativeMemoryCorrectionResponseSchema = z.object({
  previous: nativeMemoryRecordSchema, corrected: nativeMemoryRecordSchema, review: reconciliation.optional(),
  operationReceipt: z.object({ operation: z.enum(["correct", "propose_contradiction"]), previousMemoryId: id, correctedMemoryId: id, previousClaimStatus: claim.optional(), reviewRequired: z.boolean() }).strict(),
  serviceReceipt: receipt("memory.correct"),
}).strict().superRefine((value, context) => {
  const { previous, corrected, review, operationReceipt } = value;
  outcome(value, context, { correction: { previous, corrected, ...(review ? { review } : {}) }, operationReceipt });
  if (operationReceipt.previousMemoryId !== previous.id || operationReceipt.correctedMemoryId !== corrected.id || previous.id === corrected.id ||
    corrected[operationReceipt.operation === "correct" ? "supersedesId" : "contradictionOfId"] !== previous.id) problem(context, "Correction must bind its exact predecessor and successor.");
});

const lifecycle = z.object({ policyVersion: z.literal(1), pinnedAt: at.nullable(), archivedAt: at.nullable(), archiveReason: archiveReason.nullable(), duplicateOfMemoryId: id.nullable(), updatedAt: at.nullable() }).strict();
export const nativeMemoryLifecycleReadSchema = z.object({
  contract: z.literal("asael-memory-lifecycle-read:1"),
  target: z.object({ tenantId: z.string().min(1).max(120), ownerActorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
    memoryId: id, visibility: z.literal("user_private"), claimStatus: z.enum(["active", "candidate", "superseded", "contradicted"]),
    targetRevision: count.min(1), lifecycleRevision: count, token: sha }).strict(), lifecycle,
}).strict();
export const nativeMemoryLifecycleRequestSchema = z.object({ contract: z.literal("asael-memory-lifecycle-mutation:1"), action, expectedTargetToken: sha }).strict();
export const nativeMemoryLifecycleAcceptanceSchema = z.object({
  contract: z.literal("asael-memory-lifecycle-acceptance:1"), id: z.string().regex(/^memory-lifecycle-acceptance:[a-f0-9]{64}$/),
  tenantId: nativeMemoryLifecycleReadSchema.shape.target.shape.tenantId, ownerActorId: nativeMemoryLifecycleReadSchema.shape.target.shape.ownerActorId,
  memoryId: id, action, idempotencyKeySha256: sha, requestSha256: sha, expectedTargetToken: sha, acceptedAt: at,
  targetRevision: count.min(1), beforeLifecycleRevision: count, afterLifecycleRevision: count.min(1), lifecycle,
  historicalTruthChanged: z.literal(false), permanentDeletion: z.literal(false),
}).strict().refine((value) => value.afterLifecycleRevision === value.beforeLifecycleRevision + 1);
export const nativeMemoryLifecycleReadResponseSchema = z.object({ current: nativeMemoryLifecycleReadSchema, serviceReceipt: receipt("memory.inspect", false) }).strict()
  .superRefine((value, context) => outcome(value, context));
export const nativeMemoryLifecycleChangeResponseSchema = z.object({
  acceptance: nativeMemoryLifecycleAcceptanceSchema, replayed: z.boolean(), current: nativeMemoryLifecycleReadSchema,
  currentRecord: z.discriminatedUnion("state", [z.object({ state: z.literal("available"), memory: nativeMemoryRecordSchema }).strict(), z.object({ state: z.literal("unavailable") }).strict()]),
  serviceReceipt: receipt("memory.lifecycle"),
}).strict().superRefine((value, context) => outcome(value, context));

const deletionReceipt = z.object({
  schemaVersion: z.literal(1), contractKind: z.literal("memory_deletion"), id: opaque, memoryId: opaque,
  attributionKind: z.enum(["scope_bound", "legacy_unattributed"]), deleteReason: z.enum(["explicit_forget", "legacy_unattributed"]),
  forgottenAt: at, descendantMemoryCount: count, retrievalTraceCount: count, graphNodeCount: count, graphEdgeCount: count,
  descendantManifestSha256: sha.nullable(), receiptSha256: sha.nullable(), createdAt: at,
}).strict();
export const nativeMemoryForgetResponseSchema = z.object({
  forgotten: z.literal(true), id, record: nativeMemoryRecordSchema,
  deletionGuarantee: z.enum(["scope_bound_receipt", "legacy_unattributed_receipt", "best_effort"]), deletionDisposition: z.enum(["committed", "already_deleted"]),
  deletionReceipt: deletionReceipt.nullable(), invalidatedAgentRunCount: count, invalidatedWorkflowRunCount: count,
  invalidatedDailyBriefCount: count, affectedEntityCount: count, retiredEntityCount: count, retiredEntityAliasCount: count,
  operationReceipt: z.object({ operation: z.literal("forget"), memoryId: id, expectedReceiptManifestSha256: sha, deletionDisposition: z.enum(["committed", "already_deleted"]), deletionReceiptSha256: sha.nullable(), irreversible: z.literal(true) }).strict(),
  serviceReceipt: receipt("memory.forget"),
}).strict().superRefine((value, context) => {
  const { serviceReceipt: _receipt, forgotten: _flag, operationReceipt, ...forgotten } = value;
  void _receipt; void _flag;
  outcome(value, context, { forgotten, operationReceipt });
  if (operationReceipt.memoryId !== value.id || operationReceipt.deletionDisposition !== value.deletionDisposition || operationReceipt.deletionReceiptSha256 !== (value.deletionReceipt?.receiptSha256 ?? null)) problem(context, "Deletion response identities disagree.");
});
export const nativeMemoryMutationErrorSchema = z.union([
  z.object({ error: z.string().min(1).max(4_000), code: z.string().max(200).optional(), requestId: z.string().uuid().optional() }).strict(),
  z.object({ error: z.enum(["Unauthorized", "Forbidden"]), message: z.string().max(4_000) }).strict(),
  z.object({ error: z.string().max(4_000), details: z.object({ formErrors: z.array(z.string()), fieldErrors: z.record(z.string(), z.array(z.string()).optional()) }).strict() }).strict(),
]);
export const nativeMemoryMutationSchemas = Object.freeze({
  NativeMemoryRecord: nativeMemoryRecordSchema,
  NativeMemoryCreateRequest: nativeMemoryCreateRequestSchema, NativeMemoryCreateResponse: nativeMemoryCreateResponseSchema,
  NativeMemoryCorrectionRequest: nativeMemoryCorrectionRequestSchema, NativeMemoryCorrectionResponse: nativeMemoryCorrectionResponseSchema,
  NativeMemoryLifecycleRequest: nativeMemoryLifecycleRequestSchema, NativeMemoryLifecycleReadResponse: nativeMemoryLifecycleReadResponseSchema,
  NativeMemoryLifecycleChangeResponse: nativeMemoryLifecycleChangeResponseSchema, NativeMemoryForgetResponse: nativeMemoryForgetResponseSchema,
  NativeMemoryMutationError: nativeMemoryMutationErrorSchema,
});
