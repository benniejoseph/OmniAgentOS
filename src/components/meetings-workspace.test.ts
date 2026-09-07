import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProcessedMeetingMedia,
  meetingRecordingCanProcess,
  type ProcessedMeetingMediaView,
} from "@/components/meetings-workspace";

describe("processed meeting media", () => {
  it("requires write access and explicit recording consent before processing", () => {
    const source = { kind: "capture_recording" as const, media: null };
    expect(meetingRecordingCanProcess(true, [{ recordingConsent: "granted" }], source))
      .toBe(true);
    expect(meetingRecordingCanProcess(true, [{ recordingConsent: "pending" }], source))
      .toBe(false);
    expect(meetingRecordingCanProcess(false, [{ recordingConsent: "granted" }], source))
      .toBe(false);
  });

  it("renders timestamped speakers and direct citations", () => {
    const media: ProcessedMeetingMediaView = {
      processingStatus: "ready",
      operationJobId: "media-job-1",
      rawAudioDeletedAt: "2026-09-08T10:05:00.000Z",
      updatedAt: "2026-09-08T10:05:00.000Z",
      output: {
        mediaRevisionId: "recording-1:media:v1",
        processedAt: "2026-09-08T10:05:00.000Z",
        languageTags: ["en-US"],
        turns: [{
          turnId: `media-turn:${"a".repeat(64)}`,
          startMilliseconds: 65_000,
          endMilliseconds: 68_000,
          languageTag: "en-US",
          speaker: {
            label: "A",
            identity: "known",
            participantId: "participant:owner",
            displayName: "Owner",
          },
          text: "We approved the launch.",
        }],
        chapters: [],
        summary: {
          text: "The launch was approved.",
          citations: [{
            turnId: `media-turn:${"a".repeat(64)}`,
            segmentIndex: 0,
            startMilliseconds: 65_000,
            endMilliseconds: 68_000,
            speakerLabel: "A",
            speakerParticipantId: "participant:owner",
          }],
        },
        actionItems: [],
        decisions: [],
        warnings: [],
      },
    };

    const html = renderToStaticMarkup(createElement(ProcessedMeetingMedia, {
      label: "Customer call",
      media,
    }));

    expect(html).toContain("The launch was approved.");
    expect(html).toContain("1:05 · Speaker A");
    expect(html).toContain("Owner");
    expect(html).toContain("We approved the launch.");
    expect(html).toContain("Raw audio deleted");
  });

  it("shows durable background status before an output revision exists", () => {
    const html = renderToStaticMarkup(createElement(ProcessedMeetingMedia, {
      label: "Research interview",
      media: {
        processingStatus: "waiting",
        operationJobId: "media-job-2",
        rawAudioDeletedAt: null,
        updatedAt: "2026-09-08T10:05:00.000Z",
        output: null,
      },
    }));

    expect(html).toContain("continuing in the background");
    expect(html).toContain("waiting");
  });

  it("offers cited action items for proposal only when a project is linked", () => {
    const citation = {
      turnId: `media-turn:${"b".repeat(64)}`,
      segmentIndex: 0,
      startMilliseconds: 10_000,
      endMilliseconds: 12_000,
      speakerLabel: "A",
      speakerParticipantId: "participant:owner",
    };
    const media: ProcessedMeetingMediaView = {
      processingStatus: "ready",
      operationJobId: "media-job-3",
      rawAudioDeletedAt: null,
      updatedAt: "2026-09-08T10:05:00.000Z",
      output: {
        mediaRevisionId: "recording-1:media:v1",
        processedAt: "2026-09-08T10:05:00.000Z",
        languageTags: ["en-US"],
        turns: [{
          turnId: citation.turnId,
          startMilliseconds: citation.startMilliseconds,
          endMilliseconds: citation.endMilliseconds,
          languageTag: "en-US",
          speaker: {
            label: "A",
            identity: "known",
            participantId: "participant:owner",
            displayName: "Owner",
          },
          text: "I will send the plan.",
        }],
        chapters: [],
        summary: { text: "A follow-up was assigned.", citations: [citation] },
        actionItems: [{
          actionItemId: `media-action:${"c".repeat(64)}`,
          text: "Send the rollout plan.",
          citations: [citation],
          ownerParticipantId: "participant:owner",
          ownershipEvidence: "explicit",
          dueDateEvidence: "unconfirmed",
        }],
        decisions: [],
        warnings: [],
      },
    };
    const ready = renderToStaticMarkup(createElement(ProcessedMeetingMedia, {
      label: "Customer call",
      media,
      canWrite: true,
      meetingHasProject: true,
      onProposeCommitment: () => undefined,
    }));
    const unscoped = renderToStaticMarkup(createElement(ProcessedMeetingMedia, {
      label: "Customer call",
      media,
      canWrite: true,
      meetingHasProject: false,
      onProposeCommitment: () => undefined,
    }));

    expect(ready).toContain("Propose as work");
    expect(ready).toContain("0:10 · Speaker A");
    expect(unscoped).toContain("Link a project first");
    expect(unscoped).toContain("disabled");
  });
});
