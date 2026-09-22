import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async (event) => event),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import { buildNotificationDecisionV1 } from "@/lib/mobile/notification-decision";
import {
  appendNotificationDigestEvent,
  appendNotificationDispositionEvent,
  notificationDecisionExecutionScope,
  notificationDigestEventPayloadSchema,
  notificationDispositionEventPayloadSchema,
} from "@/lib/mobile/notification-decision-events";
import { buildNotificationDispositionRecordV1 } from "@/lib/mobile/notification-disposition";
import { createExecutionScope } from "@/lib/security/execution-scope";

beforeEach(() => {
  mocks.appendScopedDomainEvent.mockClear();
});

describe("notification disposition events", () => {
  it("persists a content-free terminal receipt bound to the exact decision", async () => {
    const decision = buildNotificationDecisionV1({
      candidate: {
        candidateId: "approval-one",
        occurrenceSha256: "a".repeat(64),
        kind: "approval",
      },
      evaluatedAt: "2026-09-22T09:00:00.000Z",
      quietHoursActive: false,
      cooldownActive: false,
      digestEnabled: true,
    });
    const disposition = buildNotificationDispositionRecordV1({
      coordinates: {
        tenantId: "tenant-one",
        ownerActorId: "actor-one",
        sourceKind: "tool_approval",
        sourceId: "approval-one",
        occurrenceKey: "revision-one",
        occurrenceSha256: "b".repeat(64),
        candidateSha256: decision.candidateSha256,
      },
      decision,
      deliveryKind: "mobile_push_outbox",
      deliveryBindingSha256: "c".repeat(64),
      now: decision.evaluatedAt,
    });
    const executionScope = notificationDecisionExecutionScope({
      tenantId: "tenant-one",
      actorId: "actor-one",
      sourceId: "approval-one",
      producerId: "mobile-push-producer",
      decision,
    });

    await appendNotificationDispositionEvent({
      decision,
      disposition,
      executionScope,
    });

    const [event] = mocks.appendScopedDomainEvent.mock.calls[0];
    expect(event).toMatchObject({
      type: "notification.disposition_recorded",
      streamId: `notification-disposition:${disposition.id}`,
      executionScope: {
        correlationId: `notification-decision:${decision.receiptSha256}`,
        causationId: "approval-one",
        executingPrincipalType: "system",
        executingPrincipalId: "mobile-push-producer",
      },
      payload: {
        decision: {
          receiptSha256: decision.receiptSha256,
          decisionGrantsAuthority: false,
          contentIncluded: false,
        },
        disposition: {
          id: disposition.id,
          sourceKind: "tool_approval",
          state: "terminal",
          deliveryKind: "mobile_push_outbox",
        },
        contentIncluded: false,
        decisionGrantsAuthority: false,
      },
    });
    expect(
      notificationDispositionEventPayloadSchema.safeParse(event.payload).success,
    ).toBe(true);
    expect(JSON.stringify(event.payload)).not.toContain("approval-one");
    expect(JSON.stringify(event.payload)).not.toContain("title");
    expect(JSON.stringify(event.payload)).not.toContain("body");
  });

  it("rejects a disposition scope not bound to the exact decision receipt", async () => {
    const decision = buildNotificationDecisionV1({
      candidate: {
        candidateId: "information-one",
        occurrenceSha256: "b".repeat(64),
        kind: "informational",
      },
      evaluatedAt: "2026-09-22T09:00:00.000Z",
      quietHoursActive: false,
      cooldownActive: false,
      digestEnabled: true,
    });
    const disposition = buildNotificationDispositionRecordV1({
      coordinates: {
        tenantId: "tenant-one",
        ownerActorId: "actor-one",
        sourceKind: "agent_run",
        sourceId: "run-one",
        occurrenceKey: "revision-one",
        occurrenceSha256: "c".repeat(64),
        candidateSha256: decision.candidateSha256,
      },
      decision,
      now: decision.evaluatedAt,
    });
    const executionScope = notificationDecisionExecutionScope({
      tenantId: "tenant-one",
      actorId: "actor-one",
      sourceId: "run-one",
      producerId: "mobile-push-producer",
      decision,
    });

    await expect(appendNotificationDispositionEvent({
      decision,
      disposition,
      executionScope: {
        ...executionScope,
        correlationId: "notification-decision:" + "0".repeat(64),
      },
    })).rejects.toThrow("scope is invalid");
  });

  it("records a bounded actor-owned digest receipt without candidate content", async () => {
    const delivery = {
      schemaVersion: 1 as const,
      id: `notification_digest_${"d".repeat(48)}`,
      tenantId: "tenant-one",
      ownerActorId: "actor-one",
      sequence: 1,
      windowStartedAt: "2026-09-22T09:00:00.000Z",
      windowEndedAt: "2026-09-22T09:15:00.000Z",
      candidateCount: 3,
      candidateManifestSha256: "e".repeat(64),
      deliveryBindingSha256: "f".repeat(64),
      recordedAt: "2026-09-22T09:30:00.000Z",
      contentIncluded: false as const,
      decisionGrantsAuthority: false as const,
    };
    await appendNotificationDigestEvent({
      delivery,
      executionScope: createExecutionScope({
        tenantId: delivery.tenantId,
        initiatingActorId: delivery.ownerActorId,
        executingPrincipalType: "system",
        executingPrincipalId: "notification-digest-batcher",
        correlationId: `notification-digest:${delivery.id}`,
        causationId: delivery.id,
        purpose: "notification.digest.delivery",
      }),
    });

    const [event] = mocks.appendScopedDomainEvent.mock.calls[0];
    expect(event).toMatchObject({
      type: "notification.digest_delivered",
      payload: {
        digestDeliveryId: delivery.id,
        candidateCount: 3,
        contentIncluded: false,
        decisionGrantsAuthority: false,
      },
    });
    expect(notificationDigestEventPayloadSchema.safeParse(event.payload).success)
      .toBe(true);
  });
});
