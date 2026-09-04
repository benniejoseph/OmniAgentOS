import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  RetainedRecordingMetadataDialog,
  captureRecordingCanDelete,
  captureRecordingCollectionIsReadable,
  captureRecordingMetadataDetailIsSafe,
  captureRecordingOpenMode,
  captureRecordingRequestIsCurrent,
  disableCaptureRecordingCapabilities,
} from "@/components/capture/long-recording-studio";
import type {
  RequestCaptureRecordingMetadataDetail,
  RequestCaptureRecordingSummary,
} from "@/lib/capture/types";

const exactSummary: RequestCaptureRecordingSummary = {
  id: "recording-exact",
  title: "Owned planning session",
  status: "ready",
  startedAt: "2026-09-05T00:00:00.000Z",
  completedAt: "2026-09-05T00:04:00.000Z",
  durationMs: 240_000,
  segmentCount: 4,
  updatedAt: "2026-09-05T00:04:00.000Z",
  metadataDetailAvailable: true,
  detailAvailable: true,
  manageable: true,
};

const retainedDetail: RequestCaptureRecordingMetadataDetail = {
  id: "recording-retained",
  title: "Retained research interview",
  status: "ready",
  language: "en-US",
  tags: ["research", "interview"],
  startedAt: "2026-09-04T10:00:00.000Z",
  completedAt: "2026-09-04T10:01:30.000Z",
  durationMs: 90_000,
  byteCount: 32_768,
  segmentCount: 1,
  createdAt: "2026-09-04T10:00:00.000Z",
  updatedAt: "2026-09-04T10:01:30.000Z",
  segments: [{
    id: "segment-retained",
    segmentIndex: 0,
    mimeType: "audio/webm;codecs=opus",
    durationMs: 60_000,
    byteCount: 32_768,
    transcriptionStatus: "completed",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:01:00.000Z",
  }],
  metadataAvailable: true,
  segmentMetadataAvailable: true,
  transcriptAvailable: false,
  audioAvailable: false,
  manageable: false,
};

describe("Capture recording request-read UI", () => {
  it("chooses full and retained detail only from current list capabilities", () => {
    expect(captureRecordingOpenMode(exactSummary)).toBe("full");
    expect(captureRecordingOpenMode({
      detailAvailable: false,
      metadataDetailAvailable: true,
    })).toBe("metadata");
    expect(captureRecordingOpenMode({
      detailAvailable: false,
      metadataDetailAvailable: false,
    })).toBeUndefined();
    expect(captureRecordingOpenMode({
      detailAvailable: true,
      metadataDetailAvailable: true,
    })).toBe("full");
  });

  it("clears every actionable capability while history is unverified", () => {
    const [disabled] = disableCaptureRecordingCapabilities([exactSummary]);

    expect(disabled).toMatchObject({
      metadataDetailAvailable: false,
      detailAvailable: false,
      manageable: false,
    });
    expect(captureRecordingOpenMode(disabled)).toBeUndefined();
    expect(captureRecordingCanDelete(disabled)).toBe(false);
    expect(captureRecordingCanDelete(exactSummary)).toBe(true);
    expect(captureRecordingCanDelete(exactSummary, "Capture writes are disabled."))
      .toBe(false);
  });

  it("accepts only the readable collection acknowledgement", () => {
    expect(captureRecordingCollectionIsReadable("readable_v1")).toBe(true);
    expect(captureRecordingCollectionIsReadable("exact_v1")).toBe(false);
    expect(captureRecordingCollectionIsReadable(undefined)).toBe(false);
  });

  it("suppresses aborted and superseded request results", () => {
    const current = new AbortController();
    const stale = new AbortController();

    expect(captureRecordingRequestIsCurrent(current, current)).toBe(true);
    expect(captureRecordingRequestIsCurrent(current, stale)).toBe(false);
    current.abort();
    expect(captureRecordingRequestIsCurrent(current, current)).toBe(false);
  });

  it("requires the retained contract, exact id, and non-sensitive capabilities", () => {
    expect(captureRecordingMetadataDetailIsSafe(
      retainedDetail,
      retainedDetail.id,
      "readable_v1",
    )).toBe(true);
    expect(captureRecordingMetadataDetailIsSafe(
      retainedDetail,
      "another-recording",
      "readable_v1",
    )).toBe(false);
    expect(captureRecordingMetadataDetailIsSafe(
      retainedDetail,
      retainedDetail.id,
      "exact_v1",
    )).toBe(false);
    expect(captureRecordingMetadataDetailIsSafe(
      { ...retainedDetail, manageable: true },
      retainedDetail.id,
      "readable_v1",
    )).toBe(false);
    expect(captureRecordingMetadataDetailIsSafe(
      { ...retainedDetail, transcriptAvailable: true },
      retainedDetail.id,
      "readable_v1",
    )).toBe(false);
    expect(captureRecordingMetadataDetailIsSafe(
      { ...retainedDetail, audioAvailable: true },
      retainedDetail.id,
      "readable_v1",
    )).toBe(false);
  });

  it("server-renders retained metadata without media, transcript, or mutation controls", () => {
    const html = renderToStaticMarkup(createElement(
      RetainedRecordingMetadataDialog,
      {
        recording: {
          ...retainedDetail,
          transcript: "SECRET TRANSCRIPT MUST NOT RENDER",
          audioUrl: "/api/capture/private-audio",
        } as RequestCaptureRecordingMetadataDetail,
        onClose: () => undefined,
      },
    ));

    expect(html).toContain("Retained recording metadata");
    expect(html).toContain("Read-only retained history");
    expect(html).toContain("Retained research interview");
    expect(html).toContain("audio/webm;codecs=opus");
    expect(html).toContain("Transcription completed");
    expect(html).not.toContain("SECRET TRANSCRIPT MUST NOT RENDER");
    expect(html).not.toContain("/api/capture/private-audio");
    expect(html).not.toContain("<audio");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Download text");
    expect(html).not.toContain(">Copy<");
    expect(html).not.toContain(">Delete<");
    expect(html).not.toContain(">Update<");
  });

  it("honors parent and segment metadata capabilities independently", () => {
    const html = renderToStaticMarkup(createElement(
      RetainedRecordingMetadataDialog,
      {
        recording: {
          ...retainedDetail,
          metadataAvailable: false,
          segmentMetadataAvailable: false,
        },
        onClose: () => undefined,
      },
    ));

    expect(html).toContain("Recording metadata is not available");
    expect(html).toContain("Segment metadata is not available");
    expect(html).not.toContain(retainedDetail.title);
    expect(html).not.toContain(retainedDetail.segments[0].mimeType);
  });
});
