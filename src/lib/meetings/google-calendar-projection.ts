import { createHash } from "node:crypto";

import type { MeetingParticipant, MeetingRevision } from "@/lib/meetings/contracts";
import {
  findMeetingBySourceItemId,
  saveMeeting,
  type MeetingMutationAuthority,
} from "@/lib/meetings/store";
import { createExecutionScope, type ExecutionScope } from "@/lib/security/execution-scope";
import { personalWorkspaceId } from "@/lib/workspaces/contracts";

export type GoogleCalendarMeetingEvent = Readonly<{
  eventId: string;
  title: string;
  description: string;
  status: string;
  start: string;
  end: string;
  timezone: string;
  location: string;
  organizer: GoogleCalendarPerson;
  attendees: readonly GoogleCalendarPerson[];
}>;

type GoogleCalendarPerson = Readonly<{
  email: string;
  displayName: string;
  role: "organizer" | "required";
  responseStatus: string;
  optional: boolean;
}>;

type CalendarProjectionBase = Readonly<{
  tenantId: string;
  actorId: string;
  sourceItemId: string;
  sourceExecutionScope: ExecutionScope;
  providerRevisionId: string;
}>;

export async function projectGoogleCalendarMeeting(
  input: CalendarProjectionBase & Readonly<{
    event: GoogleCalendarMeetingEvent;
    sourceRevisionId: string;
  }>,
) {
  const authority = calendarAuthority(input);
  const existing = await findMeetingBySourceItemId(authority, input.sourceItemId);
  const start = calendarTimestamp(input.event.start, "start");
  const end = calendarTimestamp(input.event.end, "end");
  if (Date.parse(end) <= Date.parse(start)) {
    throw new Error("Google Calendar event end must follow its start.");
  }
  const participants = mergeCalendarParticipants(input.event, existing);
  const calendarLinkId = `calendar:${digest(input.sourceItemId).slice(0, 40)}`;
  const sourceLinks = [
    ...(existing?.sourceLinks || []).filter((link) => link.kind !== "calendar_event"),
    {
      linkId: calendarLinkId,
      kind: "calendar_event" as const,
      sourceId: input.sourceItemId,
      sourceRevisionId: input.sourceRevisionId,
      mediaRole: "calendar" as const,
      label: "Google Calendar",
    },
  ];
  return saveMeeting({
    authority,
    ...(existing ? { meetingId: existing.meetingId, expectedRevision: existing.revision } : {}),
    draft: {
      title: bounded(input.event.title, 240, "Calendar event"),
      summary: bounded(input.event.description, 8_000),
      status: calendarMeetingStatus(input.event.status, start, end),
      scheduledStartAt: start,
      scheduledEndAt: end,
      actualStartAt: existing?.actualStartAt || null,
      actualEndAt: existing?.actualEndAt || null,
      timezone: bounded(input.event.timezone, 100, "UTC"),
      location: bounded(input.event.location, 500),
      projectId: existing?.projectId || null,
      declaredAccessClass: existing?.declaredAccessClass || "owner_private",
      participants,
      sourceLinks,
      entityLinks: existing?.entityLinks || [],
      decisions: existing?.decisions || [],
      commitments: existing?.commitments || [],
      followUps: existing?.followUps || [],
    },
  });
}

export async function cancelGoogleCalendarMeeting(input: CalendarProjectionBase) {
  const authority = calendarAuthority(input);
  const existing = await findMeetingBySourceItemId(authority, input.sourceItemId);
  if (!existing || existing.status === "cancelled") return existing;
  return saveMeeting({
    authority,
    meetingId: existing.meetingId,
    expectedRevision: existing.revision,
    draft: {
      title: existing.title,
      summary: existing.summary,
      status: "cancelled",
      scheduledStartAt: existing.scheduledStartAt,
      scheduledEndAt: existing.scheduledEndAt,
      actualStartAt: existing.actualStartAt,
      actualEndAt: existing.actualEndAt,
      timezone: existing.timezone,
      location: existing.location,
      projectId: existing.projectId,
      declaredAccessClass: existing.declaredAccessClass,
      participants: existing.participants,
      sourceLinks: existing.sourceLinks.map((link) => ({
        linkId: link.linkId,
        kind: link.kind,
        sourceId: link.sourceId,
        sourceRevisionId: link.sourceRevisionId,
        mediaRole: link.mediaRole,
        label: link.label,
      })),
      entityLinks: existing.entityLinks,
      decisions: existing.decisions,
      commitments: existing.commitments,
      followUps: existing.followUps,
    },
  });
}

function calendarAuthority(input: CalendarProjectionBase): MeetingMutationAuthority {
  const workspaceId = personalWorkspaceId(input.actorId);
  return {
    tenantId: input.tenantId,
    workspaceId,
    canonicalActorId: input.actorId,
    readableActorIds: [input.actorId],
    idempotencyKey: `google-calendar-meeting:${digest({
      sourceItemId: input.sourceItemId,
      providerRevisionId: input.providerRevisionId,
    })}`,
    executionScope: createExecutionScope({
      tenantId: input.tenantId,
      initiatingActorId: input.actorId,
      executingPrincipalType: "system",
      executingPrincipalId: "connector.google.calendar_projection",
      workspaceId,
      correlationId: input.sourceExecutionScope.correlationId,
      causationId: input.sourceExecutionScope.causationId,
      contextGrantIds: input.sourceExecutionScope.contextGrantIds,
      capabilityGrantIds: input.sourceExecutionScope.capabilityGrantIds,
      purpose: "connector.google.calendar.project_meeting",
    }),
  };
}

function mergeCalendarParticipants(
  event: GoogleCalendarMeetingEvent,
  existing?: MeetingRevision,
) {
  const retainedByEmail = new Map((existing?.participants || [])
    .filter((participant) => participant.email)
    .map((participant) => [participant.email!.toLowerCase(), participant]));
  const people = [event.organizer, ...event.attendees];
  const unique = new Map<string, GoogleCalendarPerson>();
  for (const person of people) {
    const key = person.email.trim().toLowerCase() || person.displayName.trim().toLowerCase();
    if (!key || unique.has(key)) continue;
    unique.set(key, person);
  }
  return [...unique.values()].slice(0, 250).map((person): MeetingParticipant => {
    const email = validEmail(person.email);
    const retained = email ? retainedByEmail.get(email.toLowerCase()) : undefined;
    return {
      participantId: retained?.participantId || `calendar-person:${digest(email || person.displayName).slice(0, 40)}`,
      displayName: bounded(person.displayName, 160, email || "Calendar participant"),
      email,
      entityId: retained?.entityId || null,
      role: person.role === "organizer" ? "organizer" : person.optional ? "optional" : "required",
      response: calendarResponse(person.responseStatus),
      attendeeConsent: retained?.attendeeConsent || "unknown",
      recordingConsent: retained?.recordingConsent || "unknown",
      consentCapturedAt: retained?.consentCapturedAt || null,
      source: "calendar",
    };
  });
}

function calendarMeetingStatus(
  providerStatus: string,
  start: string,
  end: string,
): MeetingRevision["status"] {
  if (providerStatus === "cancelled") return "cancelled";
  const now = Date.now();
  if (now >= Date.parse(end)) return "completed";
  if (now >= Date.parse(start)) return "in_progress";
  return "scheduled";
}

function calendarTimestamp(value: string, field: string) {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const parsed = new Date(dateOnly ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error(`Google Calendar ${field} is invalid.`);
  }
  return parsed.toISOString();
}

function calendarResponse(value: string): MeetingParticipant["response"] {
  if (value === "accepted" || value === "declined" || value === "tentative") return value;
  if (value === "needsAction") return "needs_action";
  return "unknown";
}

function validEmail(value: string) {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320
    ? email
    : null;
}

function bounded(value: string, limit: number, fallback = "") {
  const text = String(value || "").trim().slice(0, limit);
  return text || fallback;
}

function digest(value: unknown) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}
