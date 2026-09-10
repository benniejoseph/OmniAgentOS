import { describe, expect, it } from "vitest";

import {
  extractLegacyCommandMedia,
  mergeCommandMediaArtifacts,
  projectCommandMediaArtifacts,
} from "@/lib/command/media-projection";

describe("Command media projection", () => {
  it("projects only bounded private artifact metadata and ignores server URLs", () => {
    const artifacts = projectCommandMediaArtifacts({
      mediaArtifacts: [{
        executionId: "execution-1",
        sequence: 4,
        kind: "image",
        operation: "generate",
        assetId: "capture_asset_private-1",
        filename: "portrait.png",
        mediaType: "image/png",
        byteCount: 42,
        status: "stored",
        createdAt: "2026-09-10T08:00:00.000Z",
        contentUrl: "https://attacker.example/private.png",
      }],
    });

    expect(artifacts).toEqual([{
      executionId: "execution-1",
      sequence: 4,
      kind: "image",
      operation: "generate",
      assetId: "capture_asset_private-1",
      filename: "portrait.png",
      mediaType: "image/png",
      byteCount: 42,
      status: "stored",
      createdAt: "2026-09-10T08:00:00.000Z",
    }]);
    expect(JSON.stringify(artifacts)).not.toContain("attacker.example");
  });

  it("drops malformed, mismatched, and duplicate artifacts", () => {
    expect(projectCommandMediaArtifacts({ mediaArtifacts: [
      { executionId: "a", sequence: 1, kind: "image", operation: "clip", assetId: "asset-a", filename: "a.png", mediaType: "image/png", byteCount: 1, status: "stored", createdAt: "now" },
      { executionId: "b", sequence: 2, kind: "video", operation: "generate", assetId: "https://bad.example", filename: "b.mp4", mediaType: "video/mp4", byteCount: 1, status: "stored", createdAt: "now" },
      { executionId: "c", sequence: 3, kind: "video", operation: "generate", assetId: "asset-c", filename: "c.mp4", mediaType: "image/png", byteCount: 1, status: "stored", createdAt: "now" },
    ] })).toEqual([]);
  });

  it("recovers an older owner-scoped image link and removes the raw Markdown", () => {
    const result = extractLegacyCommandMedia([
      "Your image is ready.",
      "",
      "[View the supplied image](/api/capture/assets/capture_asset_abc123?token=ignored&content=1)",
    ].join("\n"));

    expect(result.content).toBe("Your image is ready.");
    expect(result.artifacts).toMatchObject([{
      kind: "image",
      operation: "generate",
      assetId: "capture_asset_abc123",
    }]);
  });

  it.each([
    "[View image](https://attacker.example/image.png)",
    "[View file](/api/capture/assets/capture_asset_a?content=1)",
    "[View image](/api/capture/assets/capture_asset_a?download=1)",
    "Prefix [View image](/api/capture/assets/capture_asset_a?content=1)",
  ])("does not promote an unsafe or ambiguous link: %s", (content) => {
    expect(extractLegacyCommandMedia(content)).toEqual({ content, artifacts: [] });
  });

  it("prefers durable metadata when a legacy link names the same asset", () => {
    const recovered = extractLegacyCommandMedia(
      "[View image](/api/capture/assets/capture_asset_same?content=1)",
    ).artifacts;
    const projected = projectCommandMediaArtifacts({ mediaArtifacts: [{
      executionId: "execution-real",
      sequence: 7,
      kind: "image",
      operation: "edit",
      assetId: "capture_asset_same",
      filename: "professional-portrait.png",
      mediaType: "image/png",
      byteCount: 1_024,
      status: "indexed",
      createdAt: "2026-09-10T08:00:00.000Z",
    }] });

    expect(mergeCommandMediaArtifacts(projected, recovered)).toEqual(projected);
  });
});
