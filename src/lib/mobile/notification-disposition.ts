import { z } from "zod";

import {
  notificationDecisionReasonSchema,
  notificationDecisionV1Schema,
  type NotificationDecisionV1,
} from "@/lib/mobile/notification-decision";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NOTIFICATION_DISPOSITION_SCHEMA_VERSION = 1 as const;
export const NOTIFICATION_DEFER_MINUTES = 15;
export const NOTIFICATION_DEFER_MAX_MINUTES = 24 * 60;
export const NOTIFICATION_DELIVERY_RETRY_MINUTES = 15;
export const NOTIFICATION_DIGEST_WINDOW_MINUTES = 15;

const opaqueIdSchema = z.string().trim().min(1).max(1_000);
const shortOpaqueIdSchema = z.string().trim().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
);

export const notificationDispositionSourceKindSchema = z.enum([
  "tool_approval",
  "meeting",
  "customer_risk",
  "agent_run",
  "today_reminder",
  "delegated_task",
  "scheduled_routine",
  "security_incident",
]);

export const notificationDispositionDeliveryKindSchema = z.enum([
  "mobile_push_outbox",
  "incident_alert_outbox",
  "notification_ledger",
  "digest_ledger",
]);

export type NotificationDispositionSourceKind = z.infer<
  typeof notificationDispositionSourceKindSchema
>;
export type NotificationDispositionDeliveryKind = z.infer<
  typeof notificationDispositionDeliveryKindSchema
>;

export const notificationDispositionCoordinatesSchema = z.object({
  tenantId: z.string().trim().min(1).max(240),
  ownerActorId: z.string().trim().min(1).max(320),
  sourceKind: notificationDispositionSourceKindSchema,
  sourceId: shortOpaqueIdSchema,
  occurrenceKey: opaqueIdSchema,
  occurrenceSha256: sha256Schema,
  candidateSha256: sha256Schema,
}).strict();

export type NotificationDispositionCoordinates = Readonly<
  z.infer<typeof notificationDispositionCoordinatesSchema>
>;

const dispositionRecordBaseSchema = z.object({
  schemaVersion: z.literal(NOTIFICATION_DISPOSITION_SCHEMA_VERSION),
  id: z.string().regex(/^notification_disposition_[a-f0-9]{48}$/),
  tenantId: z.string().trim().min(1).max(240),
  ownerActorId: z.string().trim().min(1).max(320),
  sourceKind: notificationDispositionSourceKindSchema,
  sourceId: shortOpaqueIdSchema,
  occurrenceKey: opaqueIdSchema,
  occurrenceSha256: sha256Schema,
  candidateSha256: sha256Schema,
  outcome: z.enum(["send", "defer", "digest", "suppress"]),
  state: z.enum(["pending", "terminal"]),
  reason: notificationDecisionReasonSchema,
  mustSend: z.boolean(),
  critical: z.boolean(),
  policySha256: sha256Schema,
  decisionReceiptSha256: sha256Schema,
  evaluatedAt: canonicalTimestampSchema,
  dueAt: canonicalTimestampSchema.nullable(),
  digestDeliveryId: shortOpaqueIdSchema.nullable(),
  deliveryKind: notificationDispositionDeliveryKindSchema.nullable(),
  deliveryBindingSha256: sha256Schema.nullable(),
  lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  createdAt: canonicalTimestampSchema,
  updatedAt: canonicalTimestampSchema,
  terminalAt: canonicalTimestampSchema.nullable(),
  contentIncluded: z.literal(false),
  decisionGrantsAuthority: z.literal(false),
}).strict();

export const notificationDispositionRecordV1Schema = dispositionRecordBaseSchema
  .superRefine((record, context) => {
    const expectedId = notificationDispositionId({
      tenantId: record.tenantId,
      ownerActorId: record.ownerActorId,
      candidateSha256: record.candidateSha256,
    });
    if (record.id !== expectedId) {
      context.addIssue({ code: "custom", path: ["id"], message: "Disposition ID is invalid." });
    }
    const terminal = record.state === "terminal";
    if (terminal !== (record.terminalAt !== null)) {
      context.addIssue({ code: "custom", path: ["terminalAt"], message: "Disposition terminal state is invalid." });
    }
    const deliveryPending = record.outcome === "send" &&
      record.state === "pending";
    if (record.outcome === "defer" || deliveryPending) {
      if (record.state !== "pending" || !record.dueAt) {
        context.addIssue({ code: "custom", path: ["dueAt"], message: "Retryable dispositions require a pending due time." });
      } else {
        const delay = Date.parse(record.dueAt) - Date.parse(record.evaluatedAt);
        if (delay <= 0 || delay > NOTIFICATION_DEFER_MAX_MINUTES * 60_000) {
          context.addIssue({ code: "custom", path: ["dueAt"], message: "Disposition due time is outside its bound." });
        }
      }
    } else if (record.dueAt !== null) {
      context.addIssue({ code: "custom", path: ["dueAt"], message: "Only a pending retryable disposition may have a due time." });
    }
    if (record.outcome === "digest") {
      const delivered = record.state === "terminal";
      if (
        delivered !== (record.digestDeliveryId !== null) ||
        delivered !== (record.deliveryKind === "digest_ledger") ||
        delivered !== (record.deliveryBindingSha256 !== null)
      ) {
        context.addIssue({ code: "custom", path: ["digestDeliveryId"], message: "Digest disposition delivery binding is invalid." });
      }
    } else if (record.digestDeliveryId !== null) {
      context.addIssue({ code: "custom", path: ["digestDeliveryId"], message: "Only a digest disposition may bind a digest delivery." });
    }
    if (record.outcome === "send") {
      const pending = record.state === "pending";
      if (pending && (record.deliveryKind || record.deliveryBindingSha256)) {
        context.addIssue({ code: "custom", path: ["deliveryKind"], message: "A pending direct delivery cannot have a delivery binding." });
      } else if (
        !pending && (!record.deliveryKind || !record.deliveryBindingSha256)
      ) {
        context.addIssue({ code: "custom", path: ["deliveryKind"], message: "A terminal direct delivery requires a delivery binding." });
      }
    }
    if (record.outcome === "suppress") {
      if (
        record.state !== "terminal" ||
        record.deliveryKind !== null ||
        record.deliveryBindingSha256 !== null
      ) {
        context.addIssue({ code: "custom", path: ["deliveryKind"], message: "Suppressed dispositions cannot bind a delivery." });
      }
    }
    if (
      record.outcome !== "send" &&
      record.outcome !== "digest" &&
      (record.deliveryKind !== null || record.deliveryBindingSha256 !== null)
    ) {
      context.addIssue({ code: "custom", path: ["deliveryKind"], message: "Pending or suppressed dispositions cannot bind a delivery." });
    }
    if (
      Date.parse(record.createdAt) > Date.parse(record.updatedAt) ||
      Date.parse(record.evaluatedAt) > Date.parse(record.updatedAt)
    ) {
      context.addIssue({ code: "custom", path: ["updatedAt"], message: "Disposition timestamps are invalid." });
    }
  });

export type NotificationDispositionRecordV1 = Readonly<
  z.infer<typeof notificationDispositionRecordV1Schema>
>;

export const notificationDigestDeliveryV1Schema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().regex(/^notification_digest_[a-f0-9]{48}$/),
  tenantId: z.string().trim().min(1).max(240),
  ownerActorId: z.string().trim().min(1).max(320),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  windowStartedAt: canonicalTimestampSchema,
  windowEndedAt: canonicalTimestampSchema,
  candidateCount: z.number().int().min(1).max(100),
  candidateManifestSha256: sha256Schema,
  deliveryBindingSha256: sha256Schema,
  recordedAt: canonicalTimestampSchema,
  contentIncluded: z.literal(false),
  decisionGrantsAuthority: z.literal(false),
}).strict().refine(
  (record) => Date.parse(record.windowStartedAt) <= Date.parse(record.windowEndedAt),
  { path: ["windowEndedAt"], message: "Digest window is invalid." },
);

export type NotificationDigestDeliveryV1 = Readonly<
  z.infer<typeof notificationDigestDeliveryV1Schema>
>;

export function notificationDispositionId(input: {
  tenantId: string;
  ownerActorId: string;
  candidateSha256: string;
}) {
  return `notification_disposition_${canonicalJsonSha256({
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    candidateSha256: sha256Schema.parse(input.candidateSha256),
  }).slice(0, 48)}`;
}

export function boundedNotificationDeferDueAt(evaluatedAt: string) {
  const evaluated = canonicalTimestampSchema.parse(evaluatedAt);
  return new Date(
    Date.parse(evaluated) + NOTIFICATION_DEFER_MINUTES * 60_000,
  ).toISOString();
}

export function boundedNotificationDeliveryRetryDueAt(evaluatedAt: string) {
  const evaluated = canonicalTimestampSchema.parse(evaluatedAt);
  return new Date(
    Date.parse(evaluated) + NOTIFICATION_DELIVERY_RETRY_MINUTES * 60_000,
  ).toISOString();
}

export function notificationDeliveryBindingSha256(input: {
  deliveryKind: NotificationDispositionDeliveryKind;
  decisionReceiptSha256: string;
  deliveryIds?: readonly string[];
  targetSha256: string;
}) {
  return canonicalJsonSha256({
    deliveryKind: notificationDispositionDeliveryKindSchema.parse(input.deliveryKind),
    decisionReceiptSha256: sha256Schema.parse(input.decisionReceiptSha256),
    deliveryIdSha256s: [...(input.deliveryIds || [])]
      .map((id) => canonicalJsonSha256(shortOpaqueIdSchema.parse(id)))
      .sort(),
    targetSha256: sha256Schema.parse(input.targetSha256),
  });
}

export function buildNotificationDispositionRecordV1(input: {
  coordinates: NotificationDispositionCoordinates;
  decision: NotificationDecisionV1;
  prior?: NotificationDispositionRecordV1;
  dueAt?: string;
  deliveryKind?: NotificationDispositionDeliveryKind;
  deliveryBindingSha256?: string;
  now: string;
}): NotificationDispositionRecordV1 {
  const coordinates = notificationDispositionCoordinatesSchema.parse(input.coordinates);
  const decision = notificationDecisionV1Schema.parse(input.decision);
  if (
    decision.candidateSha256 !== coordinates.candidateSha256 ||
    decision.candidateKind === "informational" && decision.mustSend
  ) {
    throw new Error("Notification decision is not bound to the disposition candidate.");
  }
  const now = canonicalTimestampSchema.parse(input.now);
  const prior = input.prior
    ? notificationDispositionRecordV1Schema.parse(input.prior)
    : undefined;
  if (prior && !sameDispositionCoordinates(prior, coordinates)) {
    throw new Error("Notification disposition coordinates changed.");
  }
  if (prior && !notificationDispositionEligible(prior, now)) {
    throw new Error("Notification disposition is not eligible for reconsideration.");
  }
  const outcome = decision.outcome;
  const directDeliveryBound = outcome === "send" &&
    input.deliveryKind !== undefined &&
    input.deliveryBindingSha256 !== undefined;
  const state = outcome === "defer" || outcome === "digest" ||
      outcome === "send" && !directDeliveryBound
    ? "pending" as const
    : "terminal" as const;
  const dueAt = outcome === "defer"
    ? canonicalTimestampSchema.parse(
        input.dueAt || boundedNotificationDeferDueAt(decision.evaluatedAt),
      )
    : outcome === "send" && state === "pending"
      ? canonicalTimestampSchema.parse(
          input.dueAt || boundedNotificationDeliveryRetryDueAt(decision.evaluatedAt),
        )
    : null;
  const deliveryKind = outcome === "send" && state === "terminal"
    ? notificationDispositionDeliveryKindSchema.parse(input.deliveryKind)
    : null;
  const deliveryBindingSha256 = outcome === "send" && state === "terminal"
    ? sha256Schema.parse(input.deliveryBindingSha256)
    : null;
  return Object.freeze(notificationDispositionRecordV1Schema.parse({
    schemaVersion: NOTIFICATION_DISPOSITION_SCHEMA_VERSION,
    id: prior?.id || notificationDispositionId(coordinates),
    ...coordinates,
    outcome,
    state,
    reason: decision.reason,
    mustSend: decision.mustSend,
    critical: decision.critical,
    policySha256: decision.policySha256,
    decisionReceiptSha256: decision.receiptSha256,
    evaluatedAt: decision.evaluatedAt,
    dueAt,
    digestDeliveryId: null,
    deliveryKind,
    deliveryBindingSha256,
    lifecycleRevision: prior ? prior.lifecycleRevision + 1 : 0,
    createdAt: prior?.createdAt || now,
    updatedAt: now,
    terminalAt: state === "terminal" ? now : null,
    contentIncluded: false,
    decisionGrantsAuthority: false,
  }));
}

export function completeDigestDispositionV1(input: {
  record: NotificationDispositionRecordV1;
  digestDelivery: NotificationDigestDeliveryV1;
  now: string;
}): NotificationDispositionRecordV1 {
  const record = notificationDispositionRecordV1Schema.parse(input.record);
  const digestDelivery = notificationDigestDeliveryV1Schema.parse(
    input.digestDelivery,
  );
  const now = canonicalTimestampSchema.parse(input.now);
  if (
    record.outcome !== "digest" ||
    record.state !== "pending" ||
    record.tenantId !== digestDelivery.tenantId ||
    record.ownerActorId !== digestDelivery.ownerActorId
  ) {
    throw new Error("Digest disposition cannot bind this delivery.");
  }
  return Object.freeze(notificationDispositionRecordV1Schema.parse({
    ...record,
    state: "terminal",
    digestDeliveryId: digestDelivery.id,
    deliveryKind: "digest_ledger",
    deliveryBindingSha256: digestDelivery.deliveryBindingSha256,
    lifecycleRevision: record.lifecycleRevision + 1,
    updatedAt: now,
    terminalAt: now,
  }));
}

export function notificationDispositionEligible(
  record: NotificationDispositionRecordV1,
  now: string,
) {
  const parsed = notificationDispositionRecordV1Schema.parse(record);
  const evaluatedNow = Date.parse(canonicalTimestampSchema.parse(now));
  return (parsed.outcome === "defer" || parsed.outcome === "send") &&
    parsed.state === "pending" &&
    parsed.dueAt !== null && Date.parse(parsed.dueAt) <= evaluatedNow;
}

export function sameDispositionCoordinates(
  record: NotificationDispositionRecordV1,
  coordinates: NotificationDispositionCoordinates,
) {
  return record.tenantId === coordinates.tenantId &&
    record.ownerActorId === coordinates.ownerActorId &&
    record.sourceKind === coordinates.sourceKind &&
    record.sourceId === coordinates.sourceId &&
    record.occurrenceKey === coordinates.occurrenceKey &&
    record.occurrenceSha256 === coordinates.occurrenceSha256 &&
    record.candidateSha256 === coordinates.candidateSha256;
}
