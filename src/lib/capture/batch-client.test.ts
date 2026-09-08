import { describe, expect, it } from "vitest";
import {
  captureBatchRejectionMessage,
  captureBatchTitle,
  MAX_CAPTURE_BATCH_FILE_BYTES,
  mergeCaptureBatchFiles,
  runCaptureBatch,
} from "@/lib/capture/batch-client";

const file = (name: string, size = 100, lastModified = 1) => ({
  name,
  size,
  type: "text/plain",
  lastModified,
});

describe("Capture batch client", () => {
  it("accepts distinct documents and explains rejected files", () => {
    const result = mergeCaptureBatchFiles(
      [file("lesson-01.vtt")],
      [
        file("lesson-01.vtt"),
        file("empty.txt", 0),
        file("lesson-02.srt"),
        file("large.txt", MAX_CAPTURE_BATCH_FILE_BYTES + 1),
      ],
    );

    expect(result.accepted.map((item) => item.name)).toEqual(["lesson-02.srt"]);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "duplicate",
      "empty",
      "too_large",
    ]);
    expect(captureBatchRejectionMessage(result.rejected)).toBe(
      "3 files were not added (1 over 5 MB, 1 empty, 1 duplicate).",
    );
  });

  it("processes a batch with bounded concurrency and preserves result order", async () => {
    let active = 0;
    let peak = 0;
    const results = await runCaptureBatch([1, 2, 3, 4, 5], async (item) => {
      active += 1;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active -= 1;
      return item * 10;
    }, 2);

    expect(peak).toBe(2);
    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  it("derives readable document titles from transcript filenames", () => {
    expect(captureBatchTitle("ICT_2026-lesson-01.vtt")).toBe(
      "ICT 2026 lesson 01",
    );
  });

  it("caps a browser batch at fifty files", () => {
    const current = Array.from({ length: 49 }, (_, index) =>
      file(`lesson-${index}.txt`, 100, index + 1)
    );
    const result = mergeCaptureBatchFiles(current, [
      file("lesson-50.txt", 100, 50),
      file("lesson-51.txt", 100, 51),
    ]);

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected).toMatchObject([{ reason: "batch_full" }]);
  });
});
