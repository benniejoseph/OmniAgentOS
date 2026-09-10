import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { describe, expect, it } from "vitest";

import { clipVideoBytes } from "@/lib/media/clip";

describe("deterministic video clipping", () => {
  it("rejects non-video and unbounded ranges before starting FFmpeg", async () => {
    await expect(clipVideoBytes({
      bytes: new Uint8Array([1]),
      mediaType: "image/png",
      startSeconds: 0,
      endSeconds: 1,
    })).rejects.toThrow("not a video");

    await expect(clipVideoBytes({
      bytes: new Uint8Array([1]),
      mediaType: "video/mp4",
      startSeconds: 0,
      endSeconds: 601,
    })).rejects.toThrow("no longer than 10 minutes");
  });

  it("creates a playable bounded MP4 clip with the packaged processor", async () => {
    expect(ffmpegPath).toBeTruthy();
    const directory = await mkdtemp(path.join(tmpdir(), "asael-clip-test-"));
    const sourcePath = path.join(directory, "source.mp4");
    try {
      const generated = spawnSync(ffmpegPath as string, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=blue:s=64x64:d=1",
        "-pix_fmt",
        "yuv420p",
        "-y",
        sourcePath,
      ]);
      expect(generated.status, generated.stderr?.toString()).toBe(0);
      const source = await readFile(sourcePath);
      const clip = await clipVideoBytes({
        bytes: source,
        mediaType: "video/mp4",
        startSeconds: 0,
        endSeconds: 0.5,
      });
      expect(clip.mediaType).toBe("video/mp4");
      expect(clip.bytes.byteLength).toBeGreaterThan(0);
      expect(Buffer.from(clip.bytes).subarray(4, 8).toString("ascii")).toBe("ftyp");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
