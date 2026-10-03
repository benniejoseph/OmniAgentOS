import { z } from "zod";
import { digestSchema, exactIdSchema, instantSchema, responsibilityIdSchema, responsibilitySourceSchema } from "./contracts";
import { comparisonCategorySchema, comparisonProjectionSchema, semanticDigestsSchema } from "./comparison-policy";

export const RESPONSIBILITY_OBSERVATION_CONTRACT = "asael-responsibility-observation:1" as const;
export const observationTargetSchema = z.object({
  tenantId: exactIdSchema, actorId: z.string().min(1).max(320), responsibilityId: responsibilityIdSchema,
  responsibilityRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), reviewSha256: digestSchema,
}).strict();
export const observationEvidenceRefSchema = z.object({
  kind: z.enum(["meeting_revision", "source_evidence", "thread_turn", "capture_extraction"]),
  id: exactIdSchema, revisionId: exactIdSchema, revisionSha256: digestSchema, contentSha256: digestSchema,
}).strict();
const authority = z.object({
  tenantId: exactIdSchema, requestActorId: z.string().min(1).max(320), authoredOwnerActorId: z.string().min(1).max(320),
  authoritySha256: digestSchema, purpose: z.literal("responsibility_observation"),
}).strict();
export const sourceObservationFailureSchema = z.enum(["missing", "access_denied", "stale", "partial", "unsupported", "retrieval_failed", "evidence_invalid", "semantic_comparison_required", "evidence_conflict"]);

/** Adapter output only: parse validation does not establish provenance or grant access. */
export const authoritativeSourceReadSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("available"), source: responsibilitySourceSchema, authority,
    revisionId: exactIdSchema, revisionSha256: digestSchema, observedAt: instantSchema, sourceUpdatedAt: instantSchema, freshUntil: instantSchema,
    current: z.literal(true), complete: z.literal(true),
    evidence: z.array(observationEvidenceRefSchema).min(1).max(100), projection: comparisonProjectionSchema,
  }).strict(),
  z.object({ state: z.literal("unavailable"), source: responsibilitySourceSchema, reason: sourceObservationFailureSchema }).strict(),
]);
export type AuthoritativeSourceRead = z.infer<typeof authoritativeSourceReadSchema>;
export type ObservationTarget = z.infer<typeof observationTargetSchema>;
export type ObservationEvidenceRef = z.infer<typeof observationEvidenceRefSchema>;

export const sourceObservationReceiptSchema = z.object({
  source: responsibilitySourceSchema, state: z.enum(["accepted", "unavailable"]), reason: sourceObservationFailureSchema.nullable(),
  revisionId: exactIdSchema.nullable(), revisionSha256: digestSchema.nullable(), authoritySha256: digestSchema.nullable(),
  observedAt: instantSchema.nullable(), sourceUpdatedAt: instantSchema.nullable(), freshUntil: instantSchema.nullable(),
  evidence: z.array(observationEvidenceRefSchema).max(100),
}).strict().superRefine((value, context) => {
  const accepted = value.state === "accepted";
  if (accepted !== (value.reason === null) || (accepted && (!value.revisionId || !value.revisionSha256 || !value.authoritySha256 || !value.observedAt || !value.sourceUpdatedAt || !value.freshUntil || !value.evidence.length))) {
    context.addIssue({ code: "custom", message: "Source receipt is inconsistent." });
  }
  if (!accepted && (value.revisionId !== null || value.revisionSha256 !== null || value.authoritySha256 !== null || value.observedAt !== null || value.sourceUpdatedAt !== null || value.freshUntil !== null || value.evidence.length)) {
    context.addIssue({ code: "custom", message: "Unavailable source receipts cannot claim accepted evidence." });
  }
});
export const responsibilityObservationSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(RESPONSIBILITY_OBSERVATION_CONTRACT), id: z.string().regex(/^responsibility-observation:[a-f0-9]{64}$/),
  target: observationTargetSchema, policySha256: digestSchema, observationKeySha256: digestSchema, observedAt: instantSchema,
  sources: z.array(sourceObservationReceiptSchema).min(1).max(20),
  state: z.enum(["complete", "insufficient_evidence", "blocked", "failed"]), semantic: semanticDigestsSchema.nullable(),
  failureReasons: z.array(sourceObservationFailureSchema).max(9),
  authorityEffect: z.literal("none"), activationSupported: z.literal(false), observationSha256: digestSchema,
}).strict();
export const responsibilityBaselineSchema = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), target: observationTargetSchema,
  policySha256: digestSchema, observationId: z.string().regex(/^responsibility-observation:[a-f0-9]{64}$/), observationSha256: digestSchema,
  semantic: semanticDigestsSchema, acceptedAt: instantSchema, baselineSha256: digestSchema,
}).strict();
export const responsibilityChangeRecordSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^responsibility-change:[a-f0-9]{64}$/), target: observationTargetSchema,
  policySha256: digestSchema, previousBaselineSha256: digestSchema, observationId: z.string().regex(/^responsibility-observation:[a-f0-9]{64}$/),
  categories: z.array(comparisonCategorySchema).min(1).max(6), evidence: z.array(observationEvidenceRefSchema).min(1).max(2_000),
  previousSemanticSha256: digestSchema, semanticSha256: digestSchema, deliveryState: z.literal("not_requested"), changeSha256: digestSchema,
}).strict();
export type ResponsibilityObservation = z.infer<typeof responsibilityObservationSchema>;
export type ResponsibilityBaseline = z.infer<typeof responsibilityBaselineSchema>;
export type ResponsibilityChangeRecord = z.infer<typeof responsibilityChangeRecordSchema>;
export type ObservationOutcome = "baseline_established" | "material_change" | "no_change" | "insufficient_evidence" | "blocked" | "failed";
export type ObservationCommitPlan = {
  expectedBaselineRevision: number; observation: ResponsibilityObservation; outcome: ObservationOutcome;
  reasons: readonly string[]; nextBaseline: ResponsibilityBaseline | null; change: ResponsibilityChangeRecord | null;
  authorityEffect: "none"; activationSupported: false;
};

/** Internal observation admission request. No source facts or success flags. */
export const responsibilityObservationRequestSchema = z.object({
  responsibilityId: responsibilityIdSchema,
  expectedResponsibilityRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  expectedReviewSha256: digestSchema, expectedBaselineRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  policySha256: digestSchema,
}).strict();
const reason = z.enum([...sourceObservationFailureSchema.options, ...comparisonCategorySchema.options,
  "observation_outdated", "first_complete_observation", "equivalent_evidence"]);
export const observationCommitPlanSchema = z.object({
  expectedBaselineRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 1),
  observation: responsibilityObservationSchema,
  outcome: z.enum(["baseline_established", "material_change", "no_change", "insufficient_evidence", "blocked", "failed"]),
  reasons: z.array(reason).min(1).max(16), nextBaseline: responsibilityBaselineSchema.nullable(), change: responsibilityChangeRecordSchema.nullable(),
  authorityEffect: z.literal("none"), activationSupported: z.literal(false),
}).strict();
export const responsibilityObservationReceiptSchema = z.object({
  schemaVersion: z.literal(1), request: responsibilityObservationRequestSchema,
  requestSha256: digestSchema, plan: observationCommitPlanSchema, savedAt: instantSchema, receiptSha256: digestSchema,
}).strict();
export type ResponsibilityObservationRequest = z.infer<typeof responsibilityObservationRequestSchema>;
export type ResponsibilityObservationReceipt = z.infer<typeof responsibilityObservationReceiptSchema>;
export type ResponsibilityObservationResult = { receipt: ResponsibilityObservationReceipt; currentBaseline: ResponsibilityBaseline | null; replayed: boolean };
