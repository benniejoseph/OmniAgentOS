import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { STUDIO_CAPABILITIES } from "@/lib/studio/capabilities";
import type { StudioAsset, StudioGraph } from "@/lib/studio/contracts";
import { createStudioNode } from "@/lib/studio/templates";
import { SavedRunResults, StudioInspector, StudioResultsGallery } from "./inspector";

const image: StudioAsset = {
  id: "capture_asset_image",
  filename: "provider-request-123-very-technical.jpg",
  mediaType: "image/jpeg",
  byteCount: 1024,
  contentSha256: "image-hash",
  width: 1376,
  height: 768,
  origin: "studio",
};
const video: StudioAsset = {
  ...image,
  id: "capture_asset_video",
  filename: "provider-video-456.mp4",
  mediaType: "video/mp4",
  durationSeconds: 10.005,
  width: 1280,
  height: 720,
};

describe("Studio focused editing and results", () => {
  it("mounts only the selected media preview while preserving access to other results", () => {
    const onReuse = vi.fn();
    const html = renderToStaticMarkup(createElement(StudioResultsGallery, {
      assets: [image, video, { ...video, id: "capture_asset_video_two" }],
      disabled: false,
      onReuse,
    }));

    expect(html).toContain("Image 1 · 1376 × 768");
    expect(html).toContain("Video 1 · 1280 × 720 · 10 sec");
    expect(html).toContain("Video 2");
    expect(html.match(/<img\b/g)).toHaveLength(1);
    expect(html).not.toContain("<video");
    expect(html).toContain("Preview next result");
    expect(html).toContain("/api/capture/assets/capture_asset_image?content=1&amp;download=1");
    expect(onReuse).not.toHaveBeenCalled();
  });

  it("starts with the saved downstream choice and keeps graph selection explicit", () => {
    const onSelect = vi.fn();
    const html = renderToStaticMarkup(createElement(StudioResultsGallery, {
      assets: [image, video],
      disabled: true,
      onReuse: vi.fn(),
      selection: {
        nodeId: "generator",
        selectedOutputId: video.id,
        selectableOutputIds: [image.id, video.id],
        onSelect,
      },
    }));

    expect(html.match(/<video\b/g)).toHaveLength(1);
    expect(html).not.toContain("<img");
    expect(html).toContain('name="output-generator"');
    expect(html).toMatch(/type="radio"[^>]*disabled=""[^>]*checked=""/);
    expect(html).toContain("Used in the next step");
    expect(html).toContain("Previewing another result keeps this choice unchanged.");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps history lazy and preserves the original filename inside file details", () => {
    const history = renderToStaticMarkup(createElement(SavedRunResults, {
      assets: [image, video], disabled: false, onReuse: vi.fn(),
    }));
    expect(history).not.toContain("<img");
    expect(history).not.toContain("<video");
    const gallery = renderToStaticMarkup(createElement(StudioResultsGallery, {
      assets: [image], disabled: false, onReuse: vi.fn(),
    }));
    expect(gallery).toContain('<h4>Image 1</h4>');
    expect(gallery).toContain('<summary>File details</summary>');
    expect(gallery).toContain(image.filename);
    expect(gallery).toContain(image.contentSha256);
  });

  it("puts connected content before collapsed fallback, settings and connection editing", () => {
    const prompt = createStudioNode("prompt", "prompt", 0, 0);
    prompt.title = "Product scene";
    prompt.config.prompt = "A perfume bottle on dark marble";
    const node = createStudioNode("image", "image", 300, 0);
    node.config.prompt = "Unused fallback idea";
    const graph: StudioGraph = {
      schemaVersion: 1,
      nodes: [prompt, node],
      edges: [{ id: "e", source: "prompt", sourcePort: "text", target: "image", targetPort: "prompt", order: 0 }],
    };
    const html = renderToStaticMarkup(createElement(StudioInspector, {
      node,
      graph,
      capabilities: [...STUDIO_CAPABILITIES],
      assets: [],
      historicalAssets: [],
      selectableOutputIds: [],
      stale: false,
      upstreamResults: {},
      staleNodeIds: new Set<string>(),
      issues: [],
      disabled: false,
      busy: false,
      onNode: vi.fn(),
      onGraph: vi.fn(),
      onUpload: vi.fn(),
      onReuse: vi.fn(),
      onRun: vi.fn(),
      onNotice: vi.fn(),
    }));

    expect(html).toContain("Prompt from <strong>Product scene</strong>");
    expect(html.indexOf("A perfume bottle on dark marble")).toBeLessThan(html.indexOf("Advanced settings"));
    expect(html.indexOf("Fallback prompt")).toBeGreaterThan(html.indexOf("Advanced settings"));
    expect(html.indexOf("Step name")).toBeGreaterThan(html.indexOf("Step settings"));
    expect(html).not.toMatch(/<details[^>]+open/);
    expect(html.match(/>Generate image</g)).toHaveLength(1);
    expect(html).toContain("<summary>Add direction (optional)</summary>");
    expect(html).toContain("Review &amp; run this step");
    expect(html).toContain("Run step only");
    expect(html).toContain("Run to here");
    expect(html).toContain("Regenerate");
  });

  it.each(["image", "video"] as const)("keeps saved %s direction visible when the step opens", (type) => {
    const node = createStudioNode(type, "generator", 0, 0);
    node.config.instruction = "Keep the product in focus";
    const html = renderToStaticMarkup(createElement(StudioInspector, {
      node,
      graph: { schemaVersion: 1, nodes: [node], edges: [] },
      capabilities: [...STUDIO_CAPABILITIES],
      assets: [], historicalAssets: [], selectableOutputIds: [],
      stale: false, upstreamResults: {}, staleNodeIds: new Set<string>(),
      issues: [], disabled: false, busy: false,
      onNode: vi.fn(), onGraph: vi.fn(), onUpload: vi.fn(), onReuse: vi.fn(),
      onRun: vi.fn(), onNotice: vi.fn(),
    }));

    if (type === "image") {
      expect(html).toMatch(/<details[^>]+open=""><summary>Add direction \(optional\)<\/summary>/);
    } else {
      expect(html.indexOf("Motion and direction")).toBeLessThan(html.indexOf("<details"));
    }
    expect(html).toContain("Keep the product in focus</textarea>");
  });
});
