import { z } from "zod";

import { getSql } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  notificationDecisionV1Schema,
  type NotificationDecisionV1,
} from "@/lib/mobile/notification-decision";
import {
  notificationDigestDeliveryV1Schema,
  notificationDispositionRecordV1Schema,
  type NotificationDigestDeliveryV1,
  type NotificationDispositionRecordV1,
} from "@/lib/mobile/notification-disposition";
import {
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const notificationDispositionEventPayloadSchema = z.object({
  schemaVersion: z.literal(2),
  decision: notificationDecisionV1Schema,
  disposition: z.object({
    id: z.string().regex(/^notification_disposition_[a-f0-9]{48}$/),
    sourceKind: z.enum([
      "tool_approval", "meeting", "customer_risk", "agent_run",
      "today_reminder", "delegated_task", "scheduled_routine",
      "security_incident",
    ]),
    occurrenceSha256: sha256Schema,
    candidateSha256: sha256Schema,
    outcome: z.enum(["send", "defer", "digest", "suppress"]),
    state: z.enum(["pending", "terminal"]),
    reason: z.string().min(1).max(80),
    lifecycleRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    dueAt: z.string().datetime({ offset: true }).nullable(),
    deliveryKind: z.enum([
      "mobile_push_outbox", "incident_alert_outbox",
      "notification_ledger", "digest_ledger",
    ]).nullable(),
    deliveryBindingSha256: sha256Schema.nullable(),
  }).strict(),
  contentIncluded: z.literal(false),
  decisionGrantsAuthority: z.literal(false),
}).strict().superRefine((value, refinement) => {
  if (
    value.disposition.candidateSha256 !== value.decision.candidateSha256 ||
    value.disposition.outcome !== value.decision.outcome ||
    value.disposition.reason !== value.decision.reason
  ) {
    refinement.addIssue({
      code: "custom",
      path: ["disposition"],
      message: "Notification disposition event is not bound to its decision.",
    });
  }
});

export const notificationDigestEventPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  digestDeliveryId: z.string().regex(/^notification_digest_[a-f0-9]{48}$/),
  sequence: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  candidateCount: z.number().int().min(1).max(100),
  candidateManifestSha256: sha256Schema,
  deliveryBindingSha256: sha256Schema,
  windowStartedAt: z.string().datetime({ offset: true }),
  windowEndedAt: z.string().datetime({ offset: true }),
  contentIncluded: z.literal(false),
  decisionGrantsAuthority: z.literal(false),
}).strict();

type NotificationDecisionSql = ReturnType<typeof getSql>;

export function notificationDecisionExecutionScope(input: {
  tenantId: string;
  actorId: string;
  sourceId: string;
  producerId: string;
  decision: NotificationDecisionV1;
}): ExecutionScope {
  const decision = notificationDecisionV1Schema.parse(input.decision);
  return createExecutionScope({
    tenantId: input.tenantId,
    initiatingActorId: input.actorId,
    executingPrincipalType: "system",
    executingPrincipalId: boundedId(input.producerId, 200, "producer"),
    correlationId: `notification-decision:${decision.receiptSha256}`,
    causationId: boundedId(input.sourceId, 240, "source"),
    purpose: "notification.delivery.decision",
  });
}

export async function appendNotificationDispositionEvent(input: {
  decision: NotificationDecisionV1;
  disposition: NotificationDispositionRecordV1;
  executionScope: ExecutionScope;
  sql?: NotificationDecisionSql;
}) {
  const decision = notificationDecisionV1Schema.parse(input.decision);
  const disposition = notificationDispositionRecordV1Schema.parse(
    input.disposition,
  );
  const executionScope = exactDecisionScope(input.executionScope, decision);
  const payload = notificationDispositionEventPayloadSchema.parse({
    schemaVersion: 2,
    decision,
    disposition: {
      id: disposition.id,
      sourceKind: disposition.sourceKind,
      occurrenceSha256: disposition.occurrenceSha256,
      candidateSha256: disposition.candidateSha256,
      outcome: disposition.outcome,
      state: disposition.state,
      reason: disposition.reason,
      lifecycleRevision: disposition.lifecycleRevision,
      dueAt: disposition.dueAt,
      deliveryKind: disposition.deliveryKind,
      deliveryBindingSha256: disposition.deliveryBindingSha256,
    },
    contentIncluded: false,
    decisionGrantsAuthority: false,
  });
  return appendScopedDomainEvent({
    id: `notification_disposition_event_${canonicalJsonSha256({
      dispositionId: disposition.id,
      lifecycleRevision: disposition.lifecycleRevision,
      decisionReceiptSha256: decision.receiptSha256,
    }).slice(0, 48)}`,
    streamId: `notification-disposition:${disposition.id}`,
    type: "notification.disposition_recorded",
    executionScope,
    payload,
  }, input.sql ? { sql: input.sql } : {});
}

export async function appendNotificationDigestEvent(input: {
  delivery: NotificationDigestDeliveryV1;
  executionScope: ExecutionScope;
  sql?: NotificationDecisionSql;
}) {
  const delivery = notificationDigestDeliveryV1Schema.parse(input.delivery);
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (
    !executionScope ||
    executionScope.tenantId !== delivery.tenantId ||
    executionScope.initiatingActorId !== delivery.ownerActorId ||
    executionScope.executingPrincipalType !== "system" ||
    executionScope.causationId !== delivery.id ||
    executionScope.purpose !== "notification.digest.delivery"
  ) {
    throw new Error("Notification digest event scope is invalid.");
  }
  const payload = notificationDigestEventPayloadSchema.parse({
    schemaVersion: 1,
    digestDeliveryId: delivery.id,
    sequence: delivery.sequence,
    candidateCount: delivery.candidateCount,
    candidateManifestSha256: delivery.candidateManifestSha256,
    deliveryBindingSha256: delivery.deliveryBindingSha256,
    windowStartedAt: delivery.windowStartedAt,
    windowEndedAt: delivery.windowEndedAt,
    contentIncluded: false,
    decisionGrantsAuthority: false,
  });
  return appendScopedDomainEvent({
    id: `notification_digest_event_${delivery.deliveryBindingSha256.slice(0, 48)}`,
    streamId: `notification-digest:${delivery.ownerActorId}`,
    type: "notification.digest_delivered",
    executionScope,
    payload,
  }, input.sql ? { sql: input.sql } : {});
}

function exactDecisionScope(
  value: ExecutionScope,
  decision: NotificationDecisionV1,
) {
  const executionScope = parsePersistedExecutionScope(value);
  if (
    !executionScope ||
    executionScope.executingPrincipalType !== "system" ||
    executionScope.correlationId !==
      `notification-decision:${decision.receiptSha256}` ||
    executionScope.purpose !== "notification.delivery.decision"
  ) {
    throw new Error("Notification decision event scope is invalid.");
  }
  return executionScope;
}

function boundedId(value: string, max: number, label: string) {
  const result = value.trim();
  if (!result || result.length > max) {
    throw new Error(`Notification ${label} identity is invalid.`);
  }
  return result;
}
