import { describe, expect, it } from "vitest";

import {
  decideServerNotification,
  delegatedTaskNotificationCandidate,
  domainNotificationCandidate,
  notificationDispositionCoordinates,
  scheduledRoutineNotificationCandidate,
  securityIncidentNotificationCandidate,
  todayReminderNotificationCandidate,
} from "@/lib/mobile/notification-delivery-policy";

const base = {
  tenantId: "tenant-one",
  actorId: "actor-one",
  sourceId: "source-one",
  occurrenceKey: "revision-one",
  occursAt: "2026-09-22T09:30:00.000Z",
} as const;

describe("server notification delivery policy", () => {
  it("derives closed candidate classes only from server-owned domain state", () => {
    expect(domainNotificationCandidate({
      ...base,
      sourceKind: "approval",
      sourceState: "approval_required",
    })).toMatchObject({ kind: "approval" });
    expect(domainNotificationCandidate({
      ...base,
      sourceKind: "meeting",
      sourceState: "scheduled",
    })).toMatchObject({
      kind: "meeting",
      startsAt: base.occursAt,
    });
    expect(domainNotificationCandidate({
      ...base,
      sourceKind: "customer",
      sourceState: "at_risk",
    })).toMatchObject({
      kind: "failure",
      actionable: true,
      severity: "warning",
    });
    expect(domainNotificationCandidate({
      ...base,
      sourceKind: "run",
      sourceState: "completed",
    })).toMatchObject({ kind: "routine_success" });
    expect(domainNotificationCandidate({
      ...base,
      sourceKind: "run",
      sourceState: "canceled",
    })).toMatchObject({ kind: "informational" });
  });

  it("suppresses routine success and digests informational cancellation", () => {
    expect(decide("completed")).toMatchObject({
      outcome: "suppress",
      reason: "routine_success",
    });
    expect(decide("canceled")).toMatchObject({
      outcome: "digest",
      reason: "digest_nonurgent",
    });
  });

  it("sends actionable failures but respects quiet hours and cooldown", () => {
    expect(decide("failed")).toMatchObject({
      outcome: "send",
      reason: "actionable_failure",
    });
    expect(decide("failed", { quietHoursActive: true })).toMatchObject({
      outcome: "defer",
      reason: "quiet_hours",
    });
    expect(decide("failed", { cooldownActive: true })).toMatchObject({
      outcome: "defer",
      reason: "cooldown_active",
    });
  });

  it("treats due reminders as actionable but never critical", () => {
    const candidate = todayReminderNotificationCandidate({
      tenantId: base.tenantId,
      actorId: base.actorId,
      sourceKind: "today_reminder",
      sourceId: base.sourceId,
      occurrenceKey: base.occurrenceKey,
      urgency: "overdue",
    });
    expect(candidate).toMatchObject({
      kind: "failure",
      actionable: true,
      severity: "warning",
    });
    expect(decideServerNotification({
      candidate,
      policy: {
        evaluatedAt: "2026-09-22T09:00:00.000Z",
        quietHoursActive: true,
        cooldownActive: true,
      },
    })).toMatchObject({
      outcome: "defer",
      critical: false,
      bypassedQuietHours: false,
      bypassedCooldown: false,
    });
  });

  it("rejects a mismatched producer state instead of accepting free-form authority", () => {
    expect(() => domainNotificationCandidate({
      ...base,
      sourceKind: "approval",
      sourceState: "completed",
    })).toThrow("approval notification state is unsupported");
  });

  it("derives delegation, schedule, and security authority from closed server state", () => {
    expect(delegatedTaskNotificationCandidate({
      ...base,
      sourceKind: "delegated_task",
      state: "waiting",
    })).toMatchObject({ kind: "approval" });
    expect(delegatedTaskNotificationCandidate({
      ...base,
      sourceKind: "delegated_task",
      state: "rejected",
    })).toMatchObject({
      kind: "failure",
      severity: "warning",
      actionable: true,
    });
    expect(scheduledRoutineNotificationCandidate({
      ...base,
      sourceKind: "scheduled_routine",
      state: "circuit_open",
    })).toMatchObject({
      kind: "failure",
      severity: "critical",
      actionable: true,
    });
    expect(securityIncidentNotificationCandidate({
      ...base,
      sourceKind: "security_incident",
      severity: "critical",
    })).toMatchObject({ kind: "security", severity: "critical" });
  });

  it("binds exact candidate and occurrence digests without source prose", () => {
    const decision = decide("failed");
    const coordinates = notificationDispositionCoordinates({
      tenantId: base.tenantId,
      ownerActorId: base.actorId,
      sourceKind: "agent_run",
      sourceId: base.sourceId,
      occurrenceKey: base.occurrenceKey,
      decision,
    });
    expect(coordinates).toMatchObject({
      tenantId: base.tenantId,
      ownerActorId: base.actorId,
      candidateSha256: decision.candidateSha256,
    });
    expect(coordinates.occurrenceSha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

function decide(
  sourceState: "completed" | "failed" | "canceled",
  overrides: Partial<{
    quietHoursActive: boolean;
    cooldownActive: boolean;
  }> = {},
) {
  return decideServerNotification({
    candidate: domainNotificationCandidate({
      ...base,
      sourceKind: "run",
      sourceState,
    }),
    policy: {
      evaluatedAt: "2026-09-22T09:00:00.000Z",
      quietHoursActive: overrides.quietHoursActive ?? false,
      cooldownActive: overrides.cooldownActive ?? false,
      digestEnabled: true,
    },
  });
}
