import { describe, expect, it } from "vitest";

import { buildNotificationDecisionV1 } from "@/lib/mobile/notification-decision";
import {
  buildNotificationDispositionRecordV1,
  completeDigestDispositionV1,
  notificationDispositionEligible,
  notificationDispositionId,
  type NotificationDispositionCoordinates,
} from "@/lib/mobile/notification-disposition";

const occurrenceSha256 = "a".repeat(64);
const targetSha256 = "b".repeat(64);

describe("durable notification disposition", () => {
  it("bounds a deferred decision and permits reconsideration only when due", () => {
    const decision = notificationDecision("approval", {
      evaluatedAt: "2026-09-22T09:00:00.000Z",
      quietHoursActive: true,
    });
    const coordinates = dispositionCoordinates(decision.candidateSha256);
    const deferred = buildNotificationDispositionRecordV1({
      coordinates,
      decision,
      now: decision.evaluatedAt,
    });

    expect(deferred).toMatchObject({
      id: notificationDispositionId(coordinates),
      outcome: "defer",
      state: "pending",
      dueAt: "2026-09-22T09:15:00.000Z",
      lifecycleRevision: 0,
      contentIncluded: false,
      decisionGrantsAuthority: false,
    });
    expect(notificationDispositionEligible(
      deferred,
      "2026-09-22T09:14:59.999Z",
    )).toBe(false);
    expect(notificationDispositionEligible(
      deferred,
      "2026-09-22T09:15:00.000Z",
    )).toBe(true);

    const send = notificationDecision("approval", {
      evaluatedAt: "2026-09-22T09:15:00.000Z",
    });
    const terminal = buildNotificationDispositionRecordV1({
      coordinates,
      decision: send,
      prior: deferred,
      deliveryKind: "mobile_push_outbox",
      deliveryBindingSha256: targetSha256,
      now: send.evaluatedAt,
    });
    expect(terminal).toMatchObject({
      outcome: "send",
      state: "terminal",
      lifecycleRevision: 1,
      dueAt: null,
      deliveryKind: "mobile_push_outbox",
      deliveryBindingSha256: targetSha256,
    });
    expect(notificationDispositionEligible(
      terminal,
      "2026-09-23T09:00:00.000Z",
    )).toBe(false);
  });

  it("keeps suppressed routine success terminal and delivery-free", () => {
    const decision = notificationDecision("routine_success");
    const record = buildNotificationDispositionRecordV1({
      coordinates: dispositionCoordinates(decision.candidateSha256),
      decision,
      now: decision.evaluatedAt,
    });
    expect(record).toMatchObject({
      outcome: "suppress",
      state: "terminal",
      deliveryKind: null,
      deliveryBindingSha256: null,
    });
  });

  it("bounds an unavailable direct delivery and retries it only when due", () => {
    const decision = notificationDecision("approval");
    const coordinates = dispositionCoordinates(decision.candidateSha256);
    const pending = buildNotificationDispositionRecordV1({
      coordinates,
      decision,
      now: decision.evaluatedAt,
    });

    expect(pending).toMatchObject({
      outcome: "send",
      state: "pending",
      dueAt: "2026-09-22T09:15:00.000Z",
      deliveryKind: null,
      deliveryBindingSha256: null,
    });
    expect(notificationDispositionEligible(
      pending,
      "2026-09-22T09:14:59.999Z",
    )).toBe(false);
    expect(notificationDispositionEligible(
      pending,
      "2026-09-22T09:15:00.000Z",
    )).toBe(true);

    const retry = notificationDecision("approval", {
      evaluatedAt: "2026-09-22T09:15:00.000Z",
    });
    expect(buildNotificationDispositionRecordV1({
      coordinates,
      decision: retry,
      prior: pending,
      deliveryKind: "mobile_push_outbox",
      deliveryBindingSha256: targetSha256,
      now: retry.evaluatedAt,
    })).toMatchObject({
      outcome: "send",
      state: "terminal",
      dueAt: null,
      lifecycleRevision: 1,
    });
  });

  it("terminalizes a digest only through an exact actor-owned digest delivery", () => {
    const decision = notificationDecision("informational");
    const pending = buildNotificationDispositionRecordV1({
      coordinates: dispositionCoordinates(decision.candidateSha256),
      decision,
      now: decision.evaluatedAt,
    });
    const completed = completeDigestDispositionV1({
      record: pending,
      digestDelivery: {
        schemaVersion: 1,
        id: `notification_digest_${"c".repeat(48)}`,
        tenantId: "tenant-one",
        ownerActorId: "actor-one",
        sequence: 1,
        windowStartedAt: "2026-09-22T09:00:00.000Z",
        windowEndedAt: "2026-09-22T09:15:00.000Z",
        candidateCount: 1,
        candidateManifestSha256: "d".repeat(64),
        deliveryBindingSha256: "e".repeat(64),
        recordedAt: "2026-09-22T09:30:00.000Z",
        contentIncluded: false,
        decisionGrantsAuthority: false,
      },
      now: "2026-09-22T09:30:00.000Z",
    });

    expect(completed).toMatchObject({
      outcome: "digest",
      state: "terminal",
      digestDeliveryId: `notification_digest_${"c".repeat(48)}`,
      deliveryKind: "digest_ledger",
      deliveryBindingSha256: "e".repeat(64),
      lifecycleRevision: 1,
    });
  });
});

function notificationDecision(
  kind: "approval" | "routine_success" | "informational",
  options: {
    evaluatedAt?: string;
    quietHoursActive?: boolean;
  } = {},
) {
  return buildNotificationDecisionV1({
    candidate: {
      candidateId: "candidate-one",
      occurrenceSha256,
      kind,
    },
    evaluatedAt: options.evaluatedAt || "2026-09-22T09:00:00.000Z",
    quietHoursActive: options.quietHoursActive ?? false,
    cooldownActive: false,
    digestEnabled: true,
  });
}

function dispositionCoordinates(
  candidateSha256: string,
): NotificationDispositionCoordinates {
  return {
    tenantId: "tenant-one",
    ownerActorId: "actor-one",
    sourceKind: "agent_run",
    sourceId: "source-one",
    occurrenceKey: "occurrence-one",
    occurrenceSha256,
    candidateSha256,
  };
}
