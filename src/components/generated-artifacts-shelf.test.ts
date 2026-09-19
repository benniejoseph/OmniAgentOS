import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GeneratedArtifactsShelfView } from "@/components/generated-artifacts-shelf";
import type { ResultsGeneratedArtifact } from "@/lib/results/generated-artifact-projection";

const artifactId = `generated_artifact_${"d".repeat(48)}`;
const ready: ResultsGeneratedArtifact = {
  id: artifactId,
  kind: "presentation",
  title: "AIforce client pitch",
  filename: "AIforce client pitch.pptx",
  currentVersion: 1,
  status: "ready",
  mediaType:
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  byteCount: 12_288,
  createdAt: "2026-09-19T08:00:00.000Z",
  updatedAt: "2026-09-19T08:01:00.000Z",
  queuedAt: "2026-09-19T08:00:00.000Z",
  readyAt: "2026-09-19T08:01:00.000Z",
  failedAt: null,
  downloadUrl: `/api/artifacts/${artifactId}/content?version=1&download=1`,
};

describe("GeneratedArtifactsShelfView", () => {
  it("renders ready files with the same-origin download action", () => {
    const html = renderToStaticMarkup(createElement(GeneratedArtifactsShelfView, {
      items: [ready],
      state: "ready",
      onRetry: () => undefined,
    }));

    expect(html).toContain("Created files");
    expect(html).toContain("AIforce client pitch");
    expect(html).toContain("Presentation · v1 · 12 KB");
    expect(html).toContain(
      `/api/artifacts/${artifactId}/content?version=1&amp;download=1`,
    );
    expect(html).toContain("Download");
  });

  it("shows lifecycle status without a download action before a file is ready", () => {
    const queued: ResultsGeneratedArtifact = {
      ...ready,
      id: `generated_artifact_${"e".repeat(48)}`,
      title: "Queued pitch",
      status: "queued",
      byteCount: null,
      readyAt: null,
      downloadUrl: null,
    };
    const failed: ResultsGeneratedArtifact = {
      ...queued,
      id: `generated_artifact_${"f".repeat(48)}`,
      title: "Failed pitch",
      status: "failed",
      failedAt: "2026-09-19T08:02:00.000Z",
    };
    const html = renderToStaticMarkup(createElement(GeneratedArtifactsShelfView, {
      items: [queued, failed],
      state: "ready",
      onRetry: () => undefined,
    }));

    expect(html).toContain("Queued");
    expect(html).toContain("Failed");
    expect(html).toContain("Preparing");
    expect(html).toContain("Needs retry");
    expect(html).not.toContain("Download");
  });

  it("renders an actionable empty state", () => {
    const html = renderToStaticMarkup(createElement(GeneratedArtifactsShelfView, {
      items: [],
      state: "ready",
      onRetry: () => undefined,
    }));

    expect(html).toContain("No created files yet");
    expect(html).toContain('href="/app/command"');
    expect(html).toContain("Create with Asael");
  });
});
