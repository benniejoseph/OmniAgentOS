import { describe, expect, it } from "vitest";
import {
  captureExtractionReceipt,
  captureRecordingExtraction,
  captureExtractionReceiptSchema,
  renderCaptureExtractionUnits,
} from "@/lib/capture/extraction";

describe("structured capture extraction", () => {
  it("preserves recording segment time ranges and marks incomplete recordings partial", () => {
    const extraction = captureRecordingExtraction({
      durationMs: 2_250,
      segments: [
        { segmentIndex: 2, durationMs: 750, transcript: "Third segment", transcriptionStatus: "completed" },
        { segmentIndex: 0, durationMs: 1_000, transcript: "First segment", transcriptionStatus: "completed" },
        { segmentIndex: 1, durationMs: 500, transcript: "", transcriptionStatus: "failed" },
      ],
    });

    expect(extraction.state).toBe("partial");
    expect(extraction.warningCodes).toEqual(["recording_failed_segments"]);
    expect(extraction.units.map((unit) => unit.locator)).toEqual([
      {
        kind: "media_time_range",
        mediaKind: "audio",
        startMilliseconds: 0,
        endMillisecondsExclusive: 1_000,
        durationMilliseconds: 2_250,
      },
      {
        kind: "media_time_range",
        mediaKind: "audio",
        startMilliseconds: 1_500,
        endMillisecondsExclusive: 2_250,
        durationMilliseconds: 2_250,
      },
    ]);
    expect(renderCaptureExtractionUnits(extraction.units)).toBe("First segment\n\nThird segment");

    const receipt = captureExtractionReceipt(extraction);
    expect(receipt.state).toBe("partial");
    expect(receipt.locatorKinds).toEqual(["media_time_range"]);
    expect(receipt.unitCount).toBe(2);
    expect(() => captureExtractionReceiptSchema.parse(receipt)).not.toThrow();
  });

  it("uses a bounded text locator when a recording segment lacks duration", () => {
    const extraction = captureRecordingExtraction({
      durationMs: 0,
      segments: [
        { segmentIndex: 0, durationMs: 0, transcript: "No timing metadata", transcriptionStatus: "completed" },
      ],
    });

    expect(extraction.state).toBe("partial");
    expect(extraction.warningCodes).toEqual(["recording_segment_duration_missing"]);
    expect(extraction.units[0]?.locator.kind).toBe("text_span");
  });
});
