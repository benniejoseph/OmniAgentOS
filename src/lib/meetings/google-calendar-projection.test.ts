import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMeeting: vi.fn(), saveMeeting: vi.fn() }));
vi.mock("@/lib/meetings/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/meetings/store")>(),
  findMeetingBySourceItemId: mocks.findMeeting,
  saveMeeting: mocks.saveMeeting,
}));

import { projectGoogleCalendarMeeting } from "@/lib/meetings/google-calendar-projection";
import { createExecutionScope } from "@/lib/security/execution-scope";

const actorId = "actor:11111111-1111-4111-8111-111111111111";

describe("Google Calendar meeting projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findMeeting.mockResolvedValue(undefined);
    mocks.saveMeeting.mockImplementation(async (input) => input);
  });

  it("projects a Calendar event into an owner-private canonical Meeting draft", async () => {
    await projectGoogleCalendarMeeting({
      tenantId: "personal",
      actorId,
      sourceItemId: "source_item_calendar_one",
      sourceRevisionId: "source_revision_calendar_one",
      providerRevisionId: "etag-one",
      sourceExecutionScope: createExecutionScope({
        tenantId: "personal",
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: "connector.google.personal_sync",
        correlationId: "calendar-sync-one",
        purpose: "connector.google.personal_sync.ingest",
      }),
      event: {
        eventId: "event-one",
        title: "Product review",
        description: "Review the release evidence.",
        status: "confirmed",
        start: "2099-09-11T10:00:00+05:30",
        end: "2099-09-11T11:00:00+05:30",
        timezone: "Asia/Kolkata",
        location: "Google Meet",
        organizer: { email: "owner@example.com", displayName: "Owner", role: "organizer", responseStatus: "accepted", optional: false },
        attendees: [{ email: "reviewer@example.com", displayName: "Reviewer", role: "required", responseStatus: "needsAction", optional: false }],
      },
    });

    expect(mocks.saveMeeting).toHaveBeenCalledWith(expect.objectContaining({
      authority: expect.objectContaining({
        tenantId: "personal",
        canonicalActorId: actorId,
        workspaceId: "workspace:personal:11111111-1111-4111-8111-111111111111",
        executionScope: expect.objectContaining({
          executingPrincipalId: "connector.google.calendar_projection",
          purpose: "meeting.write",
        }),
      }),
      draft: expect.objectContaining({
        title: "Product review",
        status: "scheduled",
        scheduledStartAt: "2099-09-11T04:30:00.000Z",
        declaredAccessClass: "owner_private",
        participants: expect.arrayContaining([
          expect.objectContaining({ email: "owner@example.com", role: "organizer", attendeeConsent: "unknown" }),
          expect.objectContaining({ email: "reviewer@example.com", response: "needs_action" }),
        ]),
        sourceLinks: [expect.objectContaining({ kind: "calendar_event", sourceId: "source_item_calendar_one", sourceRevisionId: "source_revision_calendar_one" })],
      }),
    }));
  });

  it("preserves user-added source links as valid draft inputs when Calendar updates an existing meeting", async () => {
    mocks.findMeeting.mockResolvedValue({
      meetingId: "meeting-one",
      revision: 4,
      title: "Existing meeting",
      summary: "Existing summary",
      status: "scheduled",
      scheduledStartAt: "2099-09-11T04:30:00.000Z",
      scheduledEndAt: "2099-09-11T05:30:00.000Z",
      actualStartAt: null,
      actualEndAt: null,
      timezone: "Asia/Kolkata",
      location: "Google Meet",
      projectId: null,
      declaredAccessClass: "owner_private",
      participants: [],
      sourceLinks: [
        {
          linkId: "recording-one",
          kind: "recording",
          sourceId: "source-recording-one",
          sourceRevisionId: "revision-recording-one",
          mediaRole: "recording",
          label: "Meeting recording",
          sourceHash: "private-store-field",
          sourceRevisionHash: "private-revision-field",
          accessClass: "owner_private",
        },
        {
          linkId: "old-calendar-link",
          kind: "calendar_event",
          sourceId: "source_item_calendar_one",
          sourceRevisionId: "old-calendar-revision",
          mediaRole: "calendar",
          label: "Google Calendar",
          sourceHash: "old-source-hash",
          sourceRevisionHash: "old-revision-hash",
          accessClass: "owner_private",
        },
      ],
      entityLinks: [],
      decisions: [],
      commitments: [],
      followUps: [],
    });

    await projectGoogleCalendarMeeting({
      tenantId: "personal",
      actorId,
      sourceItemId: "source_item_calendar_one",
      sourceRevisionId: "source_revision_calendar_two",
      providerRevisionId: "etag-two",
      sourceExecutionScope: createExecutionScope({
        tenantId: "personal",
        initiatingActorId: actorId,
        executingPrincipalType: "system",
        executingPrincipalId: "connector.google.personal_sync",
        correlationId: "calendar-sync-two",
        purpose: "connector.google.personal_sync.ingest",
      }),
      event: {
        eventId: "event-one",
        title: "Updated product review",
        description: "Updated agenda.",
        status: "confirmed",
        start: "2099-09-11T10:00:00+05:30",
        end: "2099-09-11T11:00:00+05:30",
        timezone: "Asia/Kolkata",
        location: "Google Meet",
        organizer: { email: "owner@example.com", displayName: "Owner", role: "organizer", responseStatus: "accepted", optional: false },
        attendees: [],
      },
    });

    expect(mocks.saveMeeting).toHaveBeenCalledWith(expect.objectContaining({
      meetingId: "meeting-one",
      expectedRevision: 4,
      draft: expect.objectContaining({
        sourceLinks: [
          {
            linkId: "recording-one",
            kind: "recording",
            sourceId: "source-recording-one",
            sourceRevisionId: "revision-recording-one",
            mediaRole: "recording",
            label: "Meeting recording",
          },
          expect.objectContaining({
            kind: "calendar_event",
            sourceRevisionId: "source_revision_calendar_two",
          }),
        ],
      }),
    }));
  });
});
