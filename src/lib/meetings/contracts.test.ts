import { describe, expect, it } from "vitest";

import {
  buildMeetingRevision,
  meetingRevisionSchema,
  strictestMeetingAccessClass,
  type MeetingDefinitionInput,
} from "@/lib/meetings/contracts";

const actorId = "actor:11111111-1111-4111-8111-111111111111";
const meetingId = "meeting:22222222-2222-4222-8222-222222222222";
const timestamp = "2026-09-08T10:00:00.000Z";
const digest = "a".repeat(64);

function definition(): MeetingDefinitionInput {
  return {
    title: "Quarterly customer review",
    summary: "Review delivery and agree next steps.",
    status: "scheduled" as const,
    scheduledStartAt: timestamp,
    scheduledEndAt: "2026-09-08T11:00:00.000Z",
    actualStartAt: null,
    actualEndAt: null,
    timezone: "Asia/Kolkata",
    location: "Video call",
    projectId: "project-1",
    declaredAccessClass: "workspace_members" as const,
    participants: [{
      participantId: "participant:customer",
      displayName: "Customer",
      email: "customer@example.com",
      entityId: "entity:customer",
      role: "required" as const,
      response: "accepted" as const,
      attendeeConsent: "granted" as const,
      recordingConsent: "granted" as const,
      consentCapturedAt: timestamp,
      source: "calendar" as const,
    }],
    sourceLinks: [{
      linkId: "link:calendar",
      kind: "calendar_event" as const,
      sourceId: "source-item-1",
      sourceRevisionId: "source-revision-1",
      sourceRevisionSha256: digest,
      sourceAuthoritySha256: "b".repeat(64),
      accessClass: "project_members" as const,
      mediaRole: "calendar" as const,
      label: "Calendar event",
    }],
    entityLinks: [{
      entityId: "entity:account",
      entityType: "account" as const,
      label: "Example account",
      relationship: "customer" as const,
    }],
    decisions: [],
    commitments: [],
    followUps: [],
  };
}

describe("meeting contracts", () => {
  it("selects the strictest linked source authority", () => {
    expect(strictestMeetingAccessClass(["workspace_members", "project_members"]))
      .toBe("project_members");
    expect(strictestMeetingAccessClass(["workspace_members", "owner_private"]))
      .toBe("owner_private");
  });

  it("builds an immutable, digest-bound revision", () => {
    const meeting = buildMeetingRevision({
      tenantId: "tenant-a",
      workspaceId: "workspace:tenant-a",
      ownerActorId: actorId,
      meetingId,
      revision: 1,
      definition: definition(),
      revisedAt: timestamp,
    });
    expect(meeting.meetingRevisionId).toBe(`${meetingId}:v1`);
    expect(meeting.effectiveAccessClass).toBe("project_members");
    expect(meeting.previousMeetingRevisionId).toBeNull();
    expect(Object.isFrozen(meeting)).toBe(true);
    expect(Object.isFrozen(meeting.participants)).toBe(true);
    expect(meetingRevisionSchema.parse(meeting)).toEqual(meeting);
  });

  it("rejects recording links while any participant consent is unresolved", () => {
    const original = definition();
    const value = {
      ...original,
      participants: original.participants.map((participant) => ({
        ...participant,
        recordingConsent: "pending" as const,
      })),
      sourceLinks: [...original.sourceLinks, {
        ...original.sourceLinks[0],
        linkId: "link:recording",
        kind: "capture_recording" as const,
        sourceId: "capture-recording-1",
        sourceRevisionId: "capture-recording-1:v1",
        mediaRole: "recording" as const,
        accessClass: "owner_private" as const,
      }],
    };
    expect(() => buildMeetingRevision({
      tenantId: "tenant-a",
      workspaceId: "workspace:tenant-a",
      ownerActorId: actorId,
      meetingId,
      revision: 1,
      definition: value,
      revisedAt: timestamp,
    })).toThrow(/permit recording/);
  });

  it("rejects tampered source access and revision content", () => {
    const meeting = buildMeetingRevision({
      tenantId: "tenant-a",
      workspaceId: "workspace:tenant-a",
      ownerActorId: actorId,
      meetingId,
      revision: 1,
      definition: definition(),
      revisedAt: timestamp,
    });
    expect(meetingRevisionSchema.safeParse({
      ...meeting,
      effectiveAccessClass: "workspace_members",
    }).success).toBe(false);
    expect(meetingRevisionSchema.safeParse({ ...meeting, title: "Tampered" }).success)
      .toBe(false);
  });
});
