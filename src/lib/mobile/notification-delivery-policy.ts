import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import {
  buildNotificationDecisionV1,
  type NotificationCandidateV1,
  type NotificationDecisionV1,
} from "@/lib/mobile/notification-decision";
import type {
  NotificationDispositionCoordinates,
  NotificationDispositionSourceKind,
} from "@/lib/mobile/notification-disposition";

export const MOBILE_PUSH_COOLDOWN_MINUTES = 15;

export type DomainNotificationProducerKind =
  | "approval"
  | "meeting"
  | "customer"
  | "run";

type CandidateCoordinates = Readonly<{
  tenantId: string;
  actorId: string;
  sourceKind: DomainNotificationProducerKind | "today_reminder";
  sourceId: string;
  occurrenceKey: string;
}>;

type ProactiveCandidateCoordinates = Readonly<{
  tenantId: string;
  actorId: string;
  sourceKind: NotificationDispositionSourceKind;
  sourceId: string;
  occurrenceKey: string;
}>;

export type DomainNotificationCandidateInput = CandidateCoordinates & Readonly<{
  occursAt: string;
  sourceState: "approval_required" | "scheduled" | "at_risk" |
    "completed" | "failed" | "canceled";
}>;

export type NotificationDecisionPolicyInput = Readonly<{
  evaluatedAt: string;
  quietHoursActive: boolean;
  cooldownActive: boolean;
  digestEnabled?: boolean;
  meetingImminenceMinutes?: number;
}>;

/**
 * Converts server-owned domain state into the closed NotificationCandidateV1
 * vocabulary. No model output or retrieved content participates in this map.
 */
export function domainNotificationCandidate(
  input: DomainNotificationCandidateInput,
): NotificationCandidateV1 {
  const base = candidateBase(input);
  switch (input.sourceKind) {
    case "approval":
      requireState(input.sourceState, "approval_required", input.sourceKind);
      return { ...base, kind: "approval" };
    case "meeting":
      requireState(input.sourceState, "scheduled", input.sourceKind);
      return { ...base, kind: "meeting", startsAt: canonicalInstant(input.occursAt) };
    case "customer":
      requireState(input.sourceState, "at_risk", input.sourceKind);
      return {
        ...base,
        kind: "failure",
        actionable: true,
        severity: "warning",
      };
    case "run":
      if (input.sourceState === "completed") {
        return { ...base, kind: "routine_success" };
      }
      if (input.sourceState === "failed") {
        return {
          ...base,
          kind: "failure",
          actionable: true,
          severity: "warning",
        };
      }
      if (input.sourceState === "canceled") {
        return { ...base, kind: "informational" };
      }
      throw new Error("Run notification state is unsupported.");
    case "today_reminder":
      throw new Error("Today reminders require todayReminderNotificationCandidate().");
  }
}

export function todayReminderNotificationCandidate(
  input: CandidateCoordinates & Readonly<{ urgency: "due_soon" | "overdue" }>,
): NotificationCandidateV1 {
  if (input.sourceKind !== "today_reminder") {
    throw new Error("Today reminder candidate source kind is invalid.");
  }
  return {
    ...candidateBase(input),
    kind: "failure",
    actionable: true,
    // A due reminder is actionable but not a critical security condition. It
    // therefore respects both quiet hours and cooldown.
    severity: "warning",
  };
}

export function delegatedTaskNotificationCandidate(input:
  ProactiveCandidateCoordinates & Readonly<{
    state: "waiting" | "failed" | "rejected";
  }>,
): NotificationCandidateV1 {
  if (input.sourceKind !== "delegated_task") {
    throw new Error("Delegated-task notification source kind is invalid.");
  }
  const base = candidateBase(input);
  if (input.state === "waiting") return { ...base, kind: "approval" };
  return {
    ...base,
    kind: "failure",
    actionable: true,
    severity: "warning",
  };
}

export function scheduledRoutineNotificationCandidate(input:
  ProactiveCandidateCoordinates & Readonly<{
    state: "approval_required" | "failed" | "circuit_open";
  }>,
): NotificationCandidateV1 {
  if (input.sourceKind !== "scheduled_routine") {
    throw new Error("Scheduled-routine notification source kind is invalid.");
  }
  const base = candidateBase(input);
  if (input.state === "approval_required") {
    return { ...base, kind: "approval" };
  }
  return {
    ...base,
    kind: "failure",
    actionable: true,
    severity: input.state === "circuit_open" ? "critical" : "warning",
  };
}

export function securityIncidentNotificationCandidate(input:
  ProactiveCandidateCoordinates & Readonly<{
    severity: "warning" | "critical";
  }>,
): NotificationCandidateV1 {
  if (input.sourceKind !== "security_incident") {
    throw new Error("Security-incident notification source kind is invalid.");
  }
  return {
    ...candidateBase(input),
    kind: "security",
    severity: input.severity,
  };
}

export function notificationDispositionCoordinates(input: {
  tenantId: string;
  ownerActorId: string;
  sourceKind: NotificationDispositionSourceKind;
  sourceId: string;
  occurrenceKey: string;
  decision: NotificationDecisionV1;
}): NotificationDispositionCoordinates {
  return {
    tenantId: input.tenantId,
    ownerActorId: input.ownerActorId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    occurrenceKey: input.occurrenceKey,
    occurrenceSha256: canonicalJsonSha256({
      tenantId: input.tenantId,
      ownerActorId: input.ownerActorId,
      sourceKind: input.sourceKind,
      sourceId: input.sourceId,
      occurrenceKey: input.occurrenceKey,
    }),
    candidateSha256: input.decision.candidateSha256,
  };
}

export function decideServerNotification(input: {
  candidate: NotificationCandidateV1;
  policy: NotificationDecisionPolicyInput;
}): NotificationDecisionV1 {
  return buildNotificationDecisionV1({
    candidate: input.candidate,
    evaluatedAt: canonicalInstant(input.policy.evaluatedAt),
    quietHoursActive: input.policy.quietHoursActive,
    cooldownActive: input.policy.cooldownActive,
    digestEnabled: input.policy.digestEnabled ?? true,
    meetingImminenceMinutes: input.policy.meetingImminenceMinutes,
  });
}

function candidateBase(input: CandidateCoordinates | ProactiveCandidateCoordinates) {
  const occurrenceSha256 = canonicalJsonSha256({
    tenantId: input.tenantId,
    actorId: input.actorId,
    sourceKind: input.sourceKind,
    sourceId: input.sourceId,
    occurrenceKey: input.occurrenceKey,
  });
  return {
    candidateId: `notification_candidate_${occurrenceSha256.slice(0, 48)}`,
    occurrenceSha256,
  } as const;
}

function requireState(
  actual: DomainNotificationCandidateInput["sourceState"],
  expected: DomainNotificationCandidateInput["sourceState"],
  kind: string,
) {
  if (actual !== expected) {
    throw new Error(`${kind} notification state is unsupported.`);
  }
}

function canonicalInstant(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new Error("Notification candidate timestamp is invalid.");
  }
  return new Date(milliseconds).toISOString();
}
