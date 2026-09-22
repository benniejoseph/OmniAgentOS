import { z } from "zod";

import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";

export const NOTIFICATION_DECISION_SCHEMA_VERSION = 1 as const;
export const DEFAULT_MEETING_IMMINENCE_MINUTES = 60;

const opaqueIdSchema = z.string().min(1).max(240);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const canonicalTimestampSchema = z
  .string()
  .datetime({ offset: true })
  .refine((value) => new Date(value).toISOString() === value);

const candidateBase = z.object({
  candidateId: opaqueIdSchema,
  occurrenceSha256: sha256Schema,
});
const notificationCandidateKindSchema = z.enum([
  "approval",
  "security",
  "failure",
  "meeting",
  "routine_success",
  "informational",
]);

export const notificationCandidateV1Schema = z.discriminatedUnion("kind", [
  candidateBase.extend({ kind: z.literal("approval") }).strict(),
  candidateBase.extend({
    kind: z.literal("security"),
    severity: z.enum(["warning", "critical"]),
  }).strict(),
  candidateBase.extend({
    kind: z.literal("failure"),
    actionable: z.boolean(),
    severity: z.enum(["warning", "critical"]),
  }).strict(),
  candidateBase.extend({
    kind: z.literal("meeting"),
    startsAt: canonicalTimestampSchema,
  }).strict(),
  candidateBase.extend({ kind: z.literal("routine_success") }).strict(),
  candidateBase.extend({ kind: z.literal("informational") }).strict(),
]);

export type NotificationCandidateV1 = Readonly<
  z.infer<typeof notificationCandidateV1Schema>
>;

export const notificationDecisionOutcomeSchema = z.enum([
  "send",
  "defer",
  "digest",
  "suppress",
]);

export const notificationDecisionReasonSchema = z.enum([
  "approval_required",
  "security_alert",
  "actionable_failure",
  "meeting_imminent",
  "critical_delivery",
  "quiet_hours",
  "cooldown_active",
  "digest_nonurgent",
  "digest_during_cooldown",
  "routine_success",
  "failure_not_actionable",
  "meeting_not_imminent",
  "not_worthy",
]);

const decisionBodySchema = z.object({
  schemaVersion: z.literal(NOTIFICATION_DECISION_SCHEMA_VERSION),
  receiptKind: z.literal("notification_decision"),
  decisionId: z.string().regex(/^notification_decision_[a-f0-9]{48}$/),
  candidateSha256: sha256Schema,
  candidateKind: notificationCandidateKindSchema,
  policySha256: sha256Schema,
  evaluatedAt: canonicalTimestampSchema,
  outcome: notificationDecisionOutcomeSchema,
  reason: notificationDecisionReasonSchema,
  mustSend: z.boolean(),
  critical: z.boolean(),
  quietHoursActive: z.boolean(),
  cooldownActive: z.boolean(),
  digestEnabled: z.boolean(),
  bypassedQuietHours: z.boolean(),
  bypassedCooldown: z.boolean(),
  contentIncluded: z.literal(false),
  decisionGrantsAuthority: z.literal(false),
}).strict().superRefine((decision, context) => {
  const expected = expectedDecisionCoordinates(decision);
  if (
    !expected.valid ||
    decision.outcome !== expected.outcome ||
    decision.reason !== expected.reason ||
    decision.bypassedQuietHours !== expected.bypassedQuietHours ||
    decision.bypassedCooldown !== expected.bypassedCooldown
  ) {
    context.addIssue({
      code: "custom",
      message: "Notification decision flags are inconsistent.",
    });
  }
});

export const notificationDecisionV1Schema = decisionBodySchema.extend({
  receiptSha256: sha256Schema,
}).strict().superRefine((decision, context) => {
  const { receiptSha256, ...body } = decision;
  if (receiptSha256 !== canonicalJsonSha256(body)) {
    context.addIssue({
      code: "custom",
      path: ["receiptSha256"],
      message: "Notification decision digest does not match its body.",
    });
  }
});

export type NotificationDecisionV1 = Readonly<
  z.infer<typeof notificationDecisionV1Schema>
>;

export type BuildNotificationDecisionV1Input = Readonly<{
  candidate: NotificationCandidateV1;
  evaluatedAt: string;
  quietHoursActive: boolean;
  cooldownActive: boolean;
  digestEnabled: boolean;
  meetingImminenceMinutes?: number;
}>;

/**
 * Applies deterministic notification-worthiness policy. `mustSend` means a
 * direct notification remains required; quiet hours or cooldown may defer it.
 * Only a critical security or actionable-failure candidate bypasses them.
 */
export function buildNotificationDecisionV1(
  input: BuildNotificationDecisionV1Input,
): NotificationDecisionV1 {
  const candidate = notificationCandidateV1Schema.parse(input.candidate);
  const evaluatedAt = canonicalTimestampSchema.parse(input.evaluatedAt);
  const meetingImminenceMinutes = z.number().int().min(1).max(24 * 60).parse(
    input.meetingImminenceMinutes ?? DEFAULT_MEETING_IMMINENCE_MINUTES,
  );
  const classification = classifyCandidate(
    candidate,
    evaluatedAt,
    meetingImminenceMinutes,
  );
  const choice = chooseOutcome({
    ...classification,
    quietHoursActive: input.quietHoursActive,
    cooldownActive: input.cooldownActive,
    digestEnabled: input.digestEnabled,
  });
  const candidateSha256 = canonicalJsonSha256(candidate);
  const policySha256 = canonicalJsonSha256({
    quietHoursActive: input.quietHoursActive,
    cooldownActive: input.cooldownActive,
    digestEnabled: input.digestEnabled,
    meetingImminenceMinutes,
  });
  const identity = {
    candidateSha256,
    policySha256,
    evaluatedAt,
  };
  const body = decisionBodySchema.parse({
    schemaVersion: NOTIFICATION_DECISION_SCHEMA_VERSION,
    receiptKind: "notification_decision",
    decisionId: `notification_decision_${canonicalJsonSha256(identity).slice(0, 48)}`,
    candidateSha256,
    candidateKind: candidate.kind,
    policySha256,
    evaluatedAt,
    outcome: choice.outcome,
    reason: choice.reason,
    mustSend: classification.mustSend,
    critical: classification.critical,
    quietHoursActive: input.quietHoursActive,
    cooldownActive: input.cooldownActive,
    digestEnabled: input.digestEnabled,
    bypassedQuietHours: classification.critical && input.quietHoursActive,
    bypassedCooldown: classification.critical && input.cooldownActive,
    contentIncluded: false,
    decisionGrantsAuthority: false,
  });
  return Object.freeze(notificationDecisionV1Schema.parse({
    ...body,
    receiptSha256: canonicalJsonSha256(body),
  }));
}

export function parseNotificationDecisionV1(
  value: unknown,
): NotificationDecisionV1 {
  return Object.freeze(notificationDecisionV1Schema.parse(value));
}

type Classification = Readonly<{
  mustSend: boolean;
  critical: boolean;
  directReason: "approval_required" | "security_alert" | "actionable_failure" |
    "meeting_imminent";
  suppressReason: "routine_success" | "failure_not_actionable" |
    "meeting_not_imminent" | "not_worthy";
}>;

function classifyCandidate(
  candidate: NotificationCandidateV1,
  evaluatedAt: string,
  meetingImminenceMinutes: number,
): Classification {
  switch (candidate.kind) {
    case "approval":
      return classification(true, false, "approval_required", "not_worthy");
    case "security":
      return classification(
        true,
        candidate.severity === "critical",
        "security_alert",
        "not_worthy",
      );
    case "failure":
      return classification(
        candidate.actionable,
        candidate.actionable && candidate.severity === "critical",
        "actionable_failure",
        "failure_not_actionable",
      );
    case "meeting": {
      const millisecondsUntilStart = Date.parse(candidate.startsAt) - Date.parse(evaluatedAt);
      const imminent = millisecondsUntilStart >= 0 &&
        millisecondsUntilStart <= meetingImminenceMinutes * 60_000;
      return classification(
        imminent,
        false,
        "meeting_imminent",
        "meeting_not_imminent",
      );
    }
    case "routine_success":
      return classification(false, false, "security_alert", "routine_success");
    case "informational":
      return classification(false, false, "security_alert", "not_worthy");
  }
}

function classification(
  mustSend: boolean,
  critical: boolean,
  directReason: Classification["directReason"],
  suppressReason: Classification["suppressReason"],
): Classification {
  return { mustSend, critical, directReason, suppressReason };
}

function chooseOutcome(input: Classification & {
  quietHoursActive: boolean;
  cooldownActive: boolean;
  digestEnabled: boolean;
}): {
  outcome: z.infer<typeof notificationDecisionOutcomeSchema>;
  reason: z.infer<typeof notificationDecisionReasonSchema>;
} {
  if (input.mustSend) {
    if (input.critical) {
      return { outcome: "send", reason: "critical_delivery" };
    }
    if (input.quietHoursActive) {
      return { outcome: "defer", reason: "quiet_hours" };
    }
    if (input.cooldownActive) {
      return { outcome: "defer", reason: "cooldown_active" };
    }
    return { outcome: "send", reason: input.directReason };
  }

  if (input.suppressReason === "routine_success") {
    return { outcome: "suppress", reason: "routine_success" };
  }
  if (input.digestEnabled) {
    return {
      outcome: "digest",
      reason: input.cooldownActive ? "digest_during_cooldown" : "digest_nonurgent",
    };
  }
  return { outcome: "suppress", reason: input.suppressReason };
}

function expectedDecisionCoordinates(decision: {
  candidateKind: NotificationCandidateV1["kind"];
  mustSend: boolean;
  critical: boolean;
  quietHoursActive: boolean;
  cooldownActive: boolean;
  digestEnabled: boolean;
}) {
  const bypassedQuietHours = decision.critical && decision.quietHoursActive;
  const bypassedCooldown = decision.critical && decision.cooldownActive;
  if (decision.critical) {
    if (
      !decision.mustSend ||
      (decision.candidateKind !== "security" && decision.candidateKind !== "failure")
    ) {
      return invalidDecisionCoordinates();
    }
    return {
      outcome: "send" as const,
      reason: "critical_delivery" as const,
      bypassedQuietHours,
      bypassedCooldown,
      valid: true as const,
    };
  }
  if (decision.mustSend) {
    if (decision.candidateKind === "routine_success" ||
        decision.candidateKind === "informational") {
      return invalidDecisionCoordinates();
    }
    if (decision.quietHoursActive) {
      return {
        outcome: "defer" as const,
        reason: "quiet_hours" as const,
        bypassedQuietHours,
        bypassedCooldown,
        valid: true as const,
      };
    }
    if (decision.cooldownActive) {
      return {
        outcome: "defer" as const,
        reason: "cooldown_active" as const,
        bypassedQuietHours,
        bypassedCooldown,
        valid: true as const,
      };
    }
    const reason = decision.candidateKind === "approval"
      ? "approval_required" as const
      : decision.candidateKind === "security"
        ? "security_alert" as const
        : decision.candidateKind === "failure"
          ? "actionable_failure" as const
          : "meeting_imminent" as const;
    return {
      outcome: "send" as const,
      reason,
      bypassedQuietHours,
      bypassedCooldown,
      valid: true as const,
    };
  }
  if (decision.candidateKind === "approval" || decision.candidateKind === "security") {
    return invalidDecisionCoordinates();
  }
  if (decision.candidateKind === "routine_success") {
    return {
      outcome: "suppress" as const,
      reason: "routine_success" as const,
      bypassedQuietHours,
      bypassedCooldown,
      valid: true as const,
    };
  }
  if (decision.digestEnabled) {
    return {
      outcome: "digest" as const,
      reason: decision.cooldownActive
        ? "digest_during_cooldown" as const
        : "digest_nonurgent" as const,
      bypassedQuietHours,
      bypassedCooldown,
      valid: true as const,
    };
  }
  return {
    outcome: "suppress" as const,
    reason: decision.candidateKind === "failure"
      ? "failure_not_actionable" as const
      : decision.candidateKind === "meeting"
        ? "meeting_not_imminent" as const
        : "not_worthy" as const,
    bypassedQuietHours,
    bypassedCooldown,
    valid: true as const,
  };
}

function invalidDecisionCoordinates() {
  return {
    outcome: "suppress" as const,
    reason: "not_worthy" as const,
    bypassedQuietHours: false,
    bypassedCooldown: false,
    valid: false as const,
  };
}
