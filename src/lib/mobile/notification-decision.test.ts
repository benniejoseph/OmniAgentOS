import { describe, expect, it } from "vitest";

import {
  buildNotificationDecisionV1,
  notificationDecisionV1Schema,
} from "@/lib/mobile/notification-decision";

const evaluatedAt = "2026-09-22T09:00:00.000Z";

function decide(
  candidate: Parameters<typeof buildNotificationDecisionV1>[0]["candidate"],
  options: Partial<Omit<
    Parameters<typeof buildNotificationDecisionV1>[0],
    "candidate"
  >> = {},
) {
  return buildNotificationDecisionV1({
    candidate,
    evaluatedAt,
    quietHoursActive: false,
    cooldownActive: false,
    digestEnabled: true,
    ...options,
  });
}

function base(candidateId: string) {
  return { candidateId, occurrenceSha256: "a".repeat(64) };
}

describe("NotificationDecisionV1", () => {
  it.each([
    [{ ...base("approval-one"), kind: "approval" as const }, "approval_required"],
    [{
      ...base("security-one"),
      kind: "security" as const,
      severity: "warning" as const,
    }, "security_alert"],
    [{
      ...base("failure-one"),
      kind: "failure" as const,
      actionable: true,
      severity: "warning" as const,
    }, "actionable_failure"],
    [{
      ...base("meeting-one"),
      kind: "meeting" as const,
      startsAt: "2026-09-22T09:30:00.000Z",
    }, "meeting_imminent"],
  ])("must-send candidates are delivered directly when allowed", (candidate, reason) => {
    expect(decide(candidate)).toMatchObject({
      outcome: "send",
      reason,
      mustSend: true,
    });
  });

  it("suppresses routine success even when digests are enabled", () => {
    expect(decide({
      ...base("run-one"),
      kind: "routine_success",
    })).toMatchObject({
      outcome: "suppress",
      reason: "routine_success",
      mustSend: false,
    });
  });

  it("defers noncritical must-send work during quiet hours", () => {
    expect(decide(
      { ...base("approval-one"), kind: "approval" },
      { quietHoursActive: true },
    )).toMatchObject({
      outcome: "defer",
      reason: "quiet_hours",
      mustSend: true,
      bypassedQuietHours: false,
    });
  });

  it("lets critical security and actionable failures bypass quiet hours and cooldown", () => {
    for (const candidate of [
      {
        ...base("security-critical"),
        kind: "security" as const,
        severity: "critical" as const,
      },
      {
        ...base("failure-critical"),
        kind: "failure" as const,
        actionable: true,
        severity: "critical" as const,
      },
    ]) {
      expect(decide(candidate, {
        quietHoursActive: true,
        cooldownActive: true,
      })).toMatchObject({
        outcome: "send",
        reason: "critical_delivery",
        critical: true,
        bypassedQuietHours: true,
        bypassedCooldown: true,
      });
    }
  });

  it("uses cooldown and digest outcomes without claiming delivery", () => {
    expect(decide(
      { ...base("approval-one"), kind: "approval" },
      { cooldownActive: true },
    )).toMatchObject({ outcome: "defer", reason: "cooldown_active" });
    expect(decide(
      { ...base("information-one"), kind: "informational" },
      { cooldownActive: true },
    )).toMatchObject({ outcome: "digest", reason: "digest_during_cooldown" });
  });

  it("is content-free, deterministic, and digest-bound", () => {
    const decision = decide({
      ...base("approval-one"),
      kind: "approval",
    });
    expect(decision).toMatchObject({
      contentIncluded: false,
      decisionGrantsAuthority: false,
    });
    expect(decision).not.toHaveProperty("candidateId");
    expect(decision).not.toHaveProperty("title");
    expect(decision).not.toHaveProperty("body");
    expect(decide({
      ...base("approval-one"),
      kind: "approval",
    }).receiptSha256).toBe(decision.receiptSha256);
    expect(notificationDecisionV1Schema.safeParse({
      ...decision,
      outcome: "suppress",
    }).success).toBe(false);
  });

  it("only treats meetings inside the configured lead window as imminent", () => {
    const candidate = {
      ...base("meeting-later"),
      kind: "meeting" as const,
      startsAt: "2026-09-22T10:30:00.000Z",
    };
    expect(decide(candidate, {
      meetingImminenceMinutes: 60,
      digestEnabled: false,
    })).toMatchObject({
      outcome: "suppress",
      reason: "meeting_not_imminent",
    });
    expect(decide(candidate, {
      meetingImminenceMinutes: 120,
    })).toMatchObject({
      outcome: "send",
      reason: "meeting_imminent",
    });
  });
});
