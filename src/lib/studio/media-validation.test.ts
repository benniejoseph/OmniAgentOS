import { describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/demo.json";

// Turbopack can serialize the build-root path even when tracing the actual binary.
vi.mock("ffmpeg-static", () => ({
  default: "/ROOT/node_modules/ffmpeg-static/ffmpeg",
}));
import { validateStudioMedia } from "./assets";

describe("Studio packaged media validation", () => {
  it("decodes stored video with the runtime binary when the bundled path is unavailable", async () => {
    const bytes = Buffer.from(fixtures["video.mp4"], "base64");
    const result = await validateStudioMedia(bytes, "video/mp4");
    expect(result.mediaType).toBe("video/mp4");
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.durationSeconds).toBe(3);
  });
});
