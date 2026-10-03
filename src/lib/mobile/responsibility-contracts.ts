import { z } from "zod";
import {
  digestSchema,
  exactIdSchema,
  RESPONSIBILITY_CONTRACT,
  responsibilityChangeSchema,
  responsibilityCreateSchema,
  responsibilityPinsSchema,
  responsibilityRecordSchema,
  responsibilitySourceSchema,
  responsibilityWorkSchema,
} from "@/lib/responsibilities/contracts";
import { RESPONSIBILITY_MEETING_COMPARISON_POLICY } from "@/lib/responsibilities/comparison-policy";
import {
  RESPONSIBILITY_OBSERVATION_CONTRACT,
  responsibilityBaselineSchema,
  responsibilityObservationReceiptSchema,
} from "@/lib/responsibilities/observation-contracts";
import {
  notificationAdmissionSchema,
  notificationCandidateSchema,
  notificationConfigurationSchema,
  notificationControlRequestSchema,
  notificationReceiptSchema,
  RESPONSIBILITY_NOTIFICATION_CONTRACT,
} from "@/lib/responsibilities/notification-contracts";
import {
  pilotConfigurationSchema,
  RESPONSIBILITY_PILOT_DISCLOSURE,
  RESPONSIBILITY_RUNTIME_CONTRACT,
  responsibilityLifecycleRequestSchema,
  responsibilityLifecycleSchema,
  responsibilityWakeSchema,
  runtimeReceiptSchema,
  runtimeRevisionSchema,
} from "@/lib/responsibilities/runtime-contracts";
import { responsibilityReceiptSchema } from "@/lib/responsibilities/state";

// Wire envelopes compose the authoritative domain shapes. Hash verification,
// current-owner authorization and transition admission remain server concerns;
// the JSON Schema document cannot substitute for those runtime checks.
export const nativeResponsibilityCreateRequestSchema = responsibilityCreateSchema;
export const nativeResponsibilityChangeRequestSchema = responsibilityChangeSchema;
export const nativeResponsibilityLifecycleRequestSchema = responsibilityLifecycleRequestSchema;
export const nativeResponsibilityNotificationControlRequestSchema = notificationControlRequestSchema;

const reasonCode = z.string().min(1).max(240);
const boundedText = z.string().min(1).max(2_000);
const recentCoverageSchema = z.object({
  kind: z.literal("bounded_recent"),
  limit: z.number().int().min(1).max(100),
  returned: z.number().int().min(0).max(100),
  total: z.null(),
}).strict();
const draftEnvelope = {
  schemaVersion: z.literal(1),
  contract: z.literal(RESPONSIBILITY_CONTRACT),
  compatibility: z.object({
    schemaVersion: z.literal(1),
    supportedActions: z.tuple([z.literal("create"), z.literal("update"), z.literal("review")]),
    activationSupported: z.literal(false),
    executionAuthority: z.literal("none"),
    observationSupported: z.literal(false),
    deliverySupported: z.literal(false),
    unknownVersionBehavior: z.literal("reject_without_mutation"),
  }).strict(),
};

export const nativeResponsibilityListResponseSchema = z.object({
  ...draftEnvelope,
  records: z.array(responsibilityRecordSchema).max(100),
  hasMore: z.boolean(),
  coverage: recentCoverageSchema,
}).strict().superRefine((value, context) => {
  if (value.coverage.returned !== value.records.length || value.records.length > value.coverage.limit) {
    context.addIssue({ code: "custom", message: "Responsibility list coverage must describe its returned records." });
  }
});

const draftReadinessSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("not_checked"), issues: z.tuple([]) }).strict(),
  z.object({ state: z.literal("incomplete"), issues: z.array(reasonCode).min(1).max(12) }).strict(),
  z.object({ state: z.literal("blocked"), issues: z.tuple([reasonCode]) }).strict(),
  z.object({
    state: z.literal("ready"), draftSha256: digestSchema, reviewSha256: digestSchema,
    pins: responsibilityPinsSchema, authorityEffect: z.literal("none"), activationSupported: z.literal(false),
  }).strict(),
]);

export const nativeResponsibilityReadResponseSchema = z.object({
  ...draftEnvelope, record: responsibilityRecordSchema, readiness: draftReadinessSchema,
}).strict();

export const nativeResponsibilityMutationResponseSchema = z.object({
  ...draftEnvelope, current: responsibilityRecordSchema, receipt: responsibilityReceiptSchema, replayed: z.boolean(),
}).strict();

function referenceGroup<T extends z.ZodType>(item: T) {
  return z.discriminatedUnion("state", [
    z.object({ state: z.literal("available"), items: z.array(item).max(40), hasMore: z.boolean() }).strict(),
    z.object({
      state: z.literal("unavailable"), items: z.tuple([]), hasMore: z.null(),
      errorCode: z.literal("responsibility_reference_read_unavailable"),
    }).strict(),
  ]);
}
const label = z.string().min(1).max(240);
const labelledId = z.object({ id: exactIdSchema, label }).strict();
export const nativeResponsibilityReferencesResponseSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal("asael-responsibility-references:1"),
  owner: z.object({
    tenantId: exactIdSchema,
    actorId: z.string().regex(/^actor:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/),
  }).strict(),
  groups: z.object({
    sources: referenceGroup(z.object({ source: responsibilitySourceSchema, label }).strict()),
    work: referenceGroup(responsibilityWorkSchema.extend({ label }).strict()),
    procedures: referenceGroup(labelledId),
    agents: referenceGroup(labelledId),
  }).strict(),
  coverage: z.object({ perGroupLimit: z.literal(40), totals: z.literal("unavailable") }).strict(),
  authorityEffect: z.literal("none"),
}).strict();

const runtimeEnvelope = { schemaVersion: z.literal(1), contract: z.literal(RESPONSIBILITY_RUNTIME_CONTRACT) };
const blockedPreview = z.object({ state: z.literal("blocked"), reason: reasonCode, authorityEffect: z.literal("none") }).strict();
export const nativeResponsibilityLifecycleReadResponseSchema = z.object({
  ...runtimeEnvelope,
  current: responsibilityLifecycleSchema.nullable(),
  disclosure: z.object({
    pilot: z.literal(RESPONSIBILITY_PILOT_DISCLOSURE.pilot), source: boundedText, comparison: boundedText,
    cadence: boundedText, stops: boundedText, execution: boundedText,
  }).strict(),
  wakes: z.array(responsibilityWakeSchema).max(40),
  receipts: z.array(runtimeReceiptSchema).max(40),
  coverage: z.object({ limit: z.literal(40), total: z.null(), hasMoreWakes: z.boolean(), hasMoreReceipts: z.boolean() }).strict(),
  dispatchReadiness: z.literal("not_observed"),
  deliverySupported: z.literal(false),
  preview: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("ready"), configuration: pilotConfigurationSchema,
      authorityEffect: z.literal("none"), dispatchReadiness: z.literal("not_observed"),
    }).strict(),
    blockedPreview,
  ]).optional(),
}).strict();
export const nativeResponsibilityLifecycleMutationResponseSchema = z.object({
  ...runtimeEnvelope, current: responsibilityLifecycleSchema, receipt: runtimeReceiptSchema, replayed: z.boolean(),
}).strict();

const comparisonPolicy = RESPONSIBILITY_MEETING_COMPARISON_POLICY;
const comparisonPolicySchema = z.object({
  schemaVersion: z.literal(1), id: z.literal(comparisonPolicy.id),
  maximumSourceAgeSeconds: z.literal(comparisonPolicy.maximumSourceAgeSeconds),
  firstObservation: z.literal(comparisonPolicy.firstObservation),
  advancement: z.literal(comparisonPolicy.advancement),
  uncertainComparison: z.literal(comparisonPolicy.uncertainComparison),
  adapterCoverage: boundedText,
  materialExamples: z.array(boundedText).min(1).max(10),
  cosmeticExamples: z.array(boundedText).min(1).max(10),
  unsupportedExamples: z.array(boundedText).min(1).max(10),
  policySha256: digestSchema,
}).strict();
export const nativeResponsibilityObservationsResponseSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(RESPONSIBILITY_OBSERVATION_CONTRACT),
  policy: comparisonPolicySchema,
  authorityEffect: z.literal("none"), activationSupported: z.literal(false), deliverySupported: z.literal(false),
  receipts: z.array(responsibilityObservationReceiptSchema).max(100),
  baseline: responsibilityBaselineSchema.nullable(), hasMore: z.boolean(), coverage: recentCoverageSchema,
}).strict().superRefine((value, context) => {
  if (value.coverage.returned !== value.receipts.length || value.receipts.length > value.coverage.limit) {
    context.addIssue({ code: "custom", message: "Observation coverage must describe its returned receipts." });
  }
});

const notificationEnvelope = {
  schemaVersion: z.literal(1), contract: z.literal(RESPONSIBILITY_NOTIFICATION_CONTRACT),
  disclosure: boundedText, externalDelivery: z.literal(false),
};
export const nativeResponsibilityNotificationsReadResponseSchema = z.object({
  ...notificationEnvelope,
  current: notificationAdmissionSchema.nullable(),
  candidates: z.array(notificationCandidateSchema).max(40),
  receipts: z.array(notificationReceiptSchema).max(40),
  coverage: z.object({ limit: z.literal(40), total: z.null(), hasMoreCandidates: z.boolean(), hasMoreReceipts: z.boolean() }).strict(),
  preview: z.discriminatedUnion("state", [
    z.object({
      state: z.literal("ready"), authorityEffect: z.literal("none"), configuration: notificationConfigurationSchema,
      expectedRuntimeRevision: runtimeRevisionSchema, expectedRuntimeGeneration: runtimeRevisionSchema,
    }).strict(),
    blockedPreview,
  ]).optional(),
}).strict();
export const nativeResponsibilityNotificationsMutationResponseSchema = z.object({
  ...notificationEnvelope, current: notificationAdmissionSchema, receipt: notificationReceiptSchema, replayed: z.boolean(),
}).strict();

export const nativeResponsibilityDomainErrorResponseSchema = z.object({
  error: boundedText, code: reasonCode, reload: z.literal(true).optional(),
}).strict();
// These routes keep the same flat domain, authorization and idempotency error
// envelopes used on the web; they do not emit the nested mobile-auth envelope.
export const nativeResponsibilityErrorResponseSchema = z.union([
  nativeResponsibilityDomainErrorResponseSchema,
  z.object({ error: z.enum(["Unauthorized", "Forbidden"]), message: boundedText }).strict(),
  z.object({ error: z.literal("Invalid request"), message: boundedText }).strict(),
]);

export const nativeResponsibilityContractSchemas = Object.freeze({
  NativeResponsibilityCreateRequest: nativeResponsibilityCreateRequestSchema,
  NativeResponsibilityChangeRequest: nativeResponsibilityChangeRequestSchema,
  NativeResponsibilityListResponse: nativeResponsibilityListResponseSchema,
  NativeResponsibilityReadResponse: nativeResponsibilityReadResponseSchema,
  NativeResponsibilityMutationResponse: nativeResponsibilityMutationResponseSchema,
  NativeResponsibilityReferencesResponse: nativeResponsibilityReferencesResponseSchema,
  NativeResponsibilityLifecycleRequest: nativeResponsibilityLifecycleRequestSchema,
  NativeResponsibilityLifecycleReadResponse: nativeResponsibilityLifecycleReadResponseSchema,
  NativeResponsibilityLifecycleMutationResponse: nativeResponsibilityLifecycleMutationResponseSchema,
  NativeResponsibilityObservationsResponse: nativeResponsibilityObservationsResponseSchema,
  NativeResponsibilityNotificationControlRequest: nativeResponsibilityNotificationControlRequestSchema,
  NativeResponsibilityNotificationsReadResponse: nativeResponsibilityNotificationsReadResponseSchema,
  NativeResponsibilityNotificationsMutationResponse: nativeResponsibilityNotificationsMutationResponseSchema,
  NativeResponsibilityErrorResponse: nativeResponsibilityErrorResponseSchema,
});
