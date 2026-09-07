import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ProcessedMeetingMedia,
  type ProcessedMeetingMediaView,
} from "@/components/meetings-workspace";

describe("processed meeting media", () => {
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
});
