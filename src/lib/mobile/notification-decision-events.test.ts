import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  appendScopedDomainEvent: vi.fn(async (event) => event),
}));

vi.mock("@/lib/events/store", () => ({
  appendScopedDomainEvent: mocks.appendScopedDomainEvent,
}));

import {
  appendNotificationDecisionEvent,
  notificationDecisionEventPayloadSchema,
  notificationDecisionExecutionScope,
} from "@/lib/mobile/notification-decision-events";
import { buildNotificationDecisionV1 } from "@/lib/mobile/notification-decision";

beforeEach(() => {
  mocks.appendScopedDomainEvent.mockClear();
});

describe("notification decision events", () => {
  it("persists a content-free receipt and binds push metadata by correlation", async () => {
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
    const executionScope = notificationDecisionExecutionScope({
      tenantId: "tenant-one",
      actorId: "actor-one",
      sourceId: "approval-one",
      producerId: "mobile-push-producer",
      decision,
    });

    await appendNotificationDecisionEvent({ decision, executionScope });

    const [event] = mocks.appendScopedDomainEvent.mock.calls[0];
    expect(event).toMatchObject({
      type: "notification.delivery_decided",
      streamId: `notification-decision:${decision.candidateSha256}`,
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
        delivery: {
          attempted: true,
          bindingMode: "execution_scope_correlation",
        },
        contentIncluded: false,
        decisionGrantsAuthority: false,
      },
    });
    expect(notificationDecisionEventPayloadSchema.safeParse(event.payload).success)
      .toBe(true);
    expect(JSON.stringify(event.payload)).not.toContain("approval-one");
    expect(JSON.stringify(event.payload)).not.toContain("title");
    expect(JSON.stringify(event.payload)).not.toContain("body");
  });

  it("rejects a scope that is not bound to the exact receipt", async () => {
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
    const executionScope = notificationDecisionExecutionScope({
      tenantId: "tenant-one",
      actorId: "actor-one",
      sourceId: "run-one",
      producerId: "mobile-push-producer",
      decision,
    });

    await expect(appendNotificationDecisionEvent({
      decision,
      executionScope: {
        ...executionScope,
        correlationId: "notification-decision:" + "0".repeat(64),
      },
    })).rejects.toThrow("scope is invalid");
  });
});
