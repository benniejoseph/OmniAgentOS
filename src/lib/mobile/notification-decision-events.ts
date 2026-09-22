import { z } from "zod";

import { getSql } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import {
  notificationDecisionV1Schema,
  type NotificationDecisionV1,
} from "@/lib/mobile/notification-decision";
import {
  createExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

export const notificationDecisionEventPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  decision: notificationDecisionV1Schema,
  delivery: z.object({
    attempted: z.boolean(),
    correlationIdSha256: sha256Schema,
    bindingMode: z.literal("execution_scope_correlation"),
  }).strict(),
  contentIncluded: z.literal(false),
  decisionGrantsAuthority: z.literal(false),
}).strict().superRefine((value, refinement) => {
  if (value.delivery.attempted !== (value.decision.outcome === "send")) {
    refinement.addIssue({
      code: "custom",
      path: ["delivery", "attempted"],
      message: "Only a send decision may attempt direct delivery.",
    });
  }
  const expectedCorrelationIdSha256 = canonicalJsonSha256(
    `notification-decision:${value.decision.receiptSha256}`,
  );
  if (value.delivery.correlationIdSha256 !== expectedCorrelationIdSha256) {
    refinement.addIssue({
      code: "custom",
      path: ["delivery", "correlationIdSha256"],
      message: "Notification delivery correlation binding is invalid.",
    });
  }
});

export type NotificationDecisionEventPayload = z.infer<
  typeof notificationDecisionEventPayloadSchema
>;

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
    executingPrincipalId: boundedProducerId(input.producerId),
    correlationId: `notification-decision:${decision.receiptSha256}`,
    causationId: boundedSourceId(input.sourceId),
    purpose: "notification.delivery.decision",
  });
}

export async function appendNotificationDecisionEvent(input: {
  decision: NotificationDecisionV1;
  executionScope: ExecutionScope;
  sql?: NotificationDecisionSql;
}) {
  const decision = notificationDecisionV1Schema.parse(input.decision);
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (
    !executionScope ||
    executionScope.executingPrincipalType !== "system" ||
    executionScope.correlationId !==
      `notification-decision:${decision.receiptSha256}` ||
    executionScope.purpose !== "notification.delivery.decision"
  ) {
    throw new Error("Notification decision event scope is invalid.");
  }
  const payload = notificationDecisionEventPayloadSchema.parse({
    schemaVersion: 1,
    decision,
    delivery: {
      attempted: decision.outcome === "send",
      correlationIdSha256: canonicalJsonSha256(
        executionScope.correlationId,
      ),
      bindingMode: "execution_scope_correlation",
    },
    contentIncluded: false,
    decisionGrantsAuthority: false,
  });
  return appendScopedDomainEvent({
    id: `notification_decision_event_${decision.receiptSha256.slice(0, 48)}`,
    streamId: `notification-decision:${decision.candidateSha256}`,
    type: "notification.delivery_decided",
    executionScope,
    payload,
  }, input.sql ? { sql: input.sql } : {});
}

function boundedProducerId(value: string) {
  const producerId = value.trim();
  if (!producerId || producerId.length > 200) {
    throw new Error("Notification producer identity is invalid.");
  }
  return producerId;
}

function boundedSourceId(value: string) {
  const sourceId = value.trim();
  if (!sourceId || sourceId.length > 240) {
    throw new Error("Notification source identity is invalid.");
  }
  return sourceId;
}
