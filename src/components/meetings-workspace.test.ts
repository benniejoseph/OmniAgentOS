import { describe, expect, it } from "vitest";

import {
  meetingSourceLinkFromLibrary,
  normalizeMeetingParticipantConsent,
} from "@/components/meetings-workspace";

describe("meeting workspace source and consent mapping", () => {
  it("retains the exact calendar source revision selected from Library", () => {
    const link = meetingSourceLinkFromLibrary({
      id: "library:calendar:event-1",
      kind: "meeting",
      sourceAuthority: "source_item",
      sourceId: "source-item-1",
      title: "Customer review",
      sourceLabel: "Google Calendar",
      status: "ready",
      currentVersion: {
        sourceRevisionId: "source-revision-1",
        mediaType: "text/calendar",
      },
    });
    expect(link).toMatchObject({
      kind: "calendar_event",
      sourceId: "source-item-1",
      sourceRevisionId: "source-revision-1",
      mediaRole: "calendar",
    });
  });

  it("lets the server bind a captured recording to its current exact digest", () => {
    const link = meetingSourceLinkFromLibrary({
      id: "library:recording:recording-1",
      kind: "recording",
      sourceAuthority: "capture_recording",
      sourceId: "recording-1",
      title: "Recorded call",
      sourceLabel: "Capture",
      status: "ready",
      currentVersion: {
        sourceRevisionId: null,
        mediaType: "audio/webm",
      },
    });
    expect(link.kind).toBe("capture_recording");
    expect(link.mediaRole).toBe("recording");
    expect(link.sourceRevisionId).toBeUndefined();
  });

  it("timestamps explicit consent and clears the timestamp when consent is unknown", () => {
    const participant = {
      participantId: "participant-1",
      displayName: "Customer",
      email: null,
      entityId: null,
      role: "required" as const,
      response: "accepted" as const,
      attendeeConsent: "granted" as const,
      recordingConsent: "pending" as const,
      consentCapturedAt: null,
      source: "manual" as const,
    };
    const captured = normalizeMeetingParticipantConsent(participant);
    expect(captured.consentCapturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(normalizeMeetingParticipantConsent({
      ...captured,
      attendeeConsent: "unknown",
      recordingConsent: "unknown",
    }).consentCapturedAt).toBeNull();
  });
});
