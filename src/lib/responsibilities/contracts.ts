import { z } from "zod";
import { runBudgetCountersV1Schema } from "@/lib/runs/budgets";

export const RESPONSIBILITY_CONTRACT = "asael-responsibility-draft:1" as const;
export const responsibilityIdSchema = z.string().regex(/^responsibility:[a-f0-9]{64}$/);
export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const exactIdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9._:@/+~-]*$/);
export const instantSchema = z.string().datetime().refine((value) => new Date(value).toISOString() === value);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const text = (max: number) => z.string().max(max).refine((value) => value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value));

export const responsibilitySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("meeting"), id: exactIdSchema, workspaceId: exactIdSchema }).strict(),
  z.object({ kind: z.literal("thread"), id: z.string().uuid() }).strict(),
  z.object({ kind: z.literal("capture_asset"), id: exactIdSchema }).strict(),
]);
export const responsibilityWorkSchema = z.object({ workspaceId: exactIdSchema, projectId: exactIdSchema, workItemId: exactIdSchema }).strict();
export const responsibilityCadenceSchema = z.object({
  frequency: z.enum(["hourly", "daily", "weekly"]), interval: z.number().int().min(1).max(24),
  timezone: z.string().min(1).max(100).refine((value) => {
    try { new Intl.DateTimeFormat("en", { timeZone: value }); return value.trim() === value; } catch { return false; }
  }),
  startsAt: instantSchema, expiresAt: instantSchema, missedPolicy: z.literal("skip"),
}).strict().refine((value) => {
  const duration = Date.parse(value.expiresAt) - Date.parse(value.startsAt);
  return duration > 0 && duration <= 366 * 86_400_000;
}, "A responsibility requires a finite duration of at most 366 days.");

/** Incomplete drafts are representable; a preview reports exactly what is missing. */
export const responsibilityDraftSchema = z.object({
  schemaVersion: z.literal(1), purpose: text(2_000), desiredOutcome: text(2_000),
  sources: z.array(responsibilitySourceSchema).max(20).refine((sources) => new Set(sources.map(sourceKey)).size === sources.length, "Sources must be unique."),
  cadence: responsibilityCadenceSchema.nullable(),
  limits: z.object({ maxChecks: z.number().int().min(1).max(10_000), maxNotifications: z.number().int().min(0).max(1_000), cumulative: runBudgetCountersV1Schema }).strict().nullable(),
  notificationRule: z.object({ kind: z.literal("material_change_only"), destination: z.literal("owner_in_app"), quietOnNoChange: z.literal(true) }).strict().nullable(),
  successCondition: text(1_000), stopConditions: z.array(text(500).refine((value) => value.length > 0)).max(8),
  work: responsibilityWorkSchema.nullable(), procedureId: exactIdSchema.nullable(), agentId: exactIdSchema.nullable(),
}).strict();

export const responsibilityCreateSchema = z.object({ action: z.literal("create"), expectedRevision: z.literal(0), draft: responsibilityDraftSchema }).strict();
export const responsibilityChangeSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("update"), expectedRevision: revision, draft: responsibilityDraftSchema }).strict(),
  z.object({ action: z.literal("review"), expectedRevision: revision, draftSha256: digestSchema, reviewSha256: digestSchema }).strict(),
]);
export const responsibilityMutationSchema = z.union([responsibilityCreateSchema, responsibilityChangeSchema]);

export const responsibilityPinsSchema = z.object({
  sources: z.array(z.object({ source: responsibilitySourceSchema, revisionSha256: digestSchema }).strict()).min(1).max(20),
  work: responsibilityWorkSchema.extend({ projectionSha256: digestSchema }).strict(),
  procedure: z.object({ id: exactIdSchema, snapshotSha256: digestSchema, toolBindingsSha256: digestSchema }).strict(),
  agent: z.object({ id: exactIdSchema, definitionVersionId: exactIdSchema, principalVersionId: exactIdSchema, identityPinSha256: digestSchema, policySha256: digestSchema }).strict(),
}).strict();
export const responsibilityReviewSchema = z.object({
  schemaVersion: z.literal(1), draftSha256: digestSchema, reviewSha256: digestSchema,
  pins: responsibilityPinsSchema, reviewedAt: instantSchema,
  authorityEffect: z.literal("none"), activationSupported: z.literal(false),
}).strict();
export const responsibilityRecordSchema = z.object({
  schemaVersion: z.literal(1), id: responsibilityIdSchema, tenantId: exactIdSchema,
  actorId: z.string().min(1).max(320).refine((value) => value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value)),
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), state: z.enum(["draft", "reviewed"]),
  draft: responsibilityDraftSchema, draftSha256: digestSchema, review: responsibilityReviewSchema.nullable(),
  createdAt: instantSchema, updatedAt: instantSchema,
}).strict().refine((value) => (value.state === "reviewed") === (value.review !== null) && value.createdAt <= value.updatedAt);

export type ResponsibilityDraft = z.infer<typeof responsibilityDraftSchema>;
export type ResponsibilitySource = z.infer<typeof responsibilitySourceSchema>;
export type ResponsibilityPins = z.infer<typeof responsibilityPinsSchema>;
export type ResponsibilityRecord = z.infer<typeof responsibilityRecordSchema>;
export type ResponsibilityMutation = z.infer<typeof responsibilityMutationSchema>;
export type ResponsibilityPreview = { state: "ready"; draftSha256: string; reviewSha256: string; pins: ResponsibilityPins; authorityEffect: "none"; activationSupported: false };
export function sourceKey(source: ResponsibilitySource) { return JSON.stringify([source.kind, source.id, "workspaceId" in source ? source.workspaceId : null]); }

export const RESPONSIBILITY_COMPATIBILITY = Object.freeze({
  schemaVersion: 1, supportedActions: ["create", "update", "review"] as const,
  activationSupported: false, executionAuthority: "none" as const,
  observationSupported: false, deliverySupported: false,
  unknownVersionBehavior: "reject_without_mutation" as const,
});
