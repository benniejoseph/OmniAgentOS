import { z } from "zod";
import { digestSchema, exactIdSchema, instantSchema, responsibilityIdSchema } from "./contracts";

export const RESPONSIBILITY_NOTIFICATION_CONTRACT = "asael-responsibility-notifications:1" as const;
export const RESPONSIBILITY_NOTIFICATION_POLICY = "owner_in_app_material_change_v1" as const;
export const RESPONSIBILITY_NOTIFICATION_RETRY_MS = 15 * 60_000;
export const RESPONSIBILITY_NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60_000;
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const count = z.number().int().min(0).max(1_000);
const owner = { tenantId: exactIdSchema, actorId: z.string().regex(/^actor:[a-f0-9-]{36}$/), responsibilityId: responsibilityIdSchema };

/** Separate standing authority. Existing read-only runtime configurations and
 * their historical none-authority receipts are never upgraded in place. */
export const notificationConfigurationSchema = z.object({
  schemaVersion: z.literal(1), ...owner, policy: z.literal(RESPONSIBILITY_NOTIFICATION_POLICY),
  runtimeConfigurationSha256: digestSchema, responsibilityRevision: revision,
  reviewSha256: digestSchema, draftSha256: digestSchema,
  source: z.object({ kind: z.literal("meeting"), id: exactIdSchema, workspaceId: exactIdSchema }).strict(),
  destination: z.literal("owner_in_app"), quietOnNoChange: z.literal(true),
  maximumNotifications: z.number().int().min(1).max(1_000), expiresAt: instantSchema,
  configurationSha256: digestSchema,
}).strict();
export const notificationAdmissionSchema = z.object({
  schemaVersion: z.literal(1), contract: z.literal(RESPONSIBILITY_NOTIFICATION_CONTRACT), ...owner,
  revision, generation: revision, state: z.enum(["enabled", "paused", "draining", "ended"]),
  reason: z.enum(["owner_enabled", "owner_stopped", "runtime_paused", "runtime_resumed", "runtime_ended", "runtime_blocked", "expired", "checks_exhausted"]),
  configuration: notificationConfigurationSchema, used: count, reserved: count,
  enabledAt: instantSchema, updatedAt: instantSchema,
}).strict();
export const notificationCandidateStateSchema = z.enum(["pending", "held", "delivered", "canceled", "blocked", "expired"]);
export const notificationCandidateReasonSchema = z.enum([
  "material_change", "quiet_hours", "delivery_retry", "in_app_recorded", "owner_paused", "owner_ended", "runtime_blocked",
  "expired", "owner_stopped", "source_unavailable", "destination_unavailable", "notifications_disabled", "preferences_unavailable", "notification_limit",
]);
export const notificationCandidateSchema = z.object({
  schemaVersion: z.literal(1), ...owner, id: z.string().regex(/^responsibility-notification:[a-f0-9]{64}$/),
  changeId: z.string().regex(/^responsibility-change:[a-f0-9]{64}$/), changeSha256: digestSchema,
  configurationSha256: digestSchema, generation: revision, revision,
  state: notificationCandidateStateSchema, reason: notificationCandidateReasonSchema,
  attempts: z.number().int().min(0).max(100), expiresAt: instantSchema, nextAttemptAt: instantSchema.nullable(),
  notificationId: z.string().regex(/^notification_[a-f0-9]{48}$/).nullable(),
  dispositionId: z.string().regex(/^notification_disposition_[a-f0-9]{48}$/).nullable(),
  deliveryBindingSha256: digestSchema.nullable(), createdAt: instantSchema, updatedAt: instantSchema, terminalAt: instantSchema.nullable(),
}).strict();
export const notificationReceiptSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().regex(/^responsibility-notification-receipt:[a-f0-9]{64}$/),
  idempotencySha256: digestSchema, requestSha256: digestSchema, previousRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER - 2),
  action: z.enum(["enable", "stop", "admit", "hold", "retry", "deliver", "cancel", "block", "expire", "lifecycle"]),
  snapshot: notificationAdmissionSchema, candidate: notificationCandidateSchema.nullable(), savedAt: instantSchema,
  contentIncluded: z.literal(false), receiptSha256: digestSchema,
}).strict();
export const notificationStopRequestSchema = z.object({ action: z.literal("stop"), expectedRevision: revision, expectedGeneration: revision }).strict();
export const notificationEnableRequestSchema = z.object({
  action: z.literal("enable"), expectedRuntimeRevision: revision, expectedRuntimeGeneration: revision,
  configurationSha256: digestSchema, acknowledgeDestination: z.literal("owner_in_app"),
}).strict();
export const notificationControlRequestSchema = z.discriminatedUnion("action", [notificationEnableRequestSchema, notificationStopRequestSchema]);
export type NotificationConfiguration = z.infer<typeof notificationConfigurationSchema>;
export type NotificationAdmission = z.infer<typeof notificationAdmissionSchema>;
export type ResponsibilityNotificationCandidate = z.infer<typeof notificationCandidateSchema>;
export type ResponsibilityNotificationReceipt = z.infer<typeof notificationReceiptSchema>;
export type NotificationCandidateReason = z.infer<typeof notificationCandidateReasonSchema>;
export type NotificationEnableRequest = z.infer<typeof notificationEnableRequestSchema>;
export type NotificationControlRequest = z.infer<typeof notificationControlRequestSchema>;
