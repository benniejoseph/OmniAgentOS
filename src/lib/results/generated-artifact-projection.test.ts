import { describe, expect, it } from "vitest";

import {
  projectResultsGeneratedArtifacts,
  resultsGeneratedArtifactDownloadUrl,
} from "@/lib/results/generated-artifact-projection";

const artifactId = `generated_artifact_${"a".repeat(48)}`;

function artifact(overrides: Record<string, unknown> = {}) {
  return {
    id: artifactId,
    kind: "presentation",
    title: "Client pitch",
    filename: "Client pitch.pptx",
    currentVersion: 2,
    projectId: null,
    missionId: null,
    workItemId: null,
    createdAt: "2026-09-19T08:00:00.000Z",
    updatedAt: "2026-09-19T08:01:00.000Z",
    current: {
      version: 2,
      status: "ready",
      mediaType:
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      byteCount: 4096,
      queuedAt: "2026-09-19T08:00:00.000Z",
      readyAt: "2026-09-19T08:01:00.000Z",
      failedAt: null,
      contentUrl: "https://untrusted.example/private-file.pptx",
    },
    ...overrides,
  };
}

describe("projectResultsGeneratedArtifacts", () => {
  it("projects a verified current version and rebuilds its download URL", () => {
    expect(projectResultsGeneratedArtifacts({ artifacts: [artifact()] })).toEqual([
      {
        id: artifactId,
        kind: "presentation",
        title: "Client pitch",
        filename: "Client pitch.pptx",
        currentVersion: 2,
        status: "ready",
        mediaType:
          "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteCount: 4096,
        createdAt: "2026-09-19T08:00:00.000Z",
        updatedAt: "2026-09-19T08:01:00.000Z",
        queuedAt: "2026-09-19T08:00:00.000Z",
        readyAt: "2026-09-19T08:01:00.000Z",
        failedAt: null,
        downloadUrl: `/api/artifacts/${artifactId}/content?version=2&download=1`,
      },
    ]);
  });

  it("keeps valid lifecycle states but never exposes downloads before ready", () => {
    const queuedId = `generated_artifact_${"b".repeat(48)}`;
    const failedId = `generated_artifact_${"c".repeat(48)}`;
    const projected = projectResultsGeneratedArtifacts({
      artifacts: [
        artifact({
          id: queuedId,
          title: "Queued brief",
          filename: "Queued brief.pptx",
          currentVersion: 1,
          current: {
            version: 1,
            status: "queued",
            mediaType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            byteCount: null,
            queuedAt: "2026-09-19T08:00:00.000Z",
            readyAt: null,
            failedAt: null,
            contentUrl: "/unexpected",
          },
        }),
        artifact({
          id: failedId,
          title: "Failed brief",
          filename: "Failed brief.pptx",
          currentVersion: 1,
          current: {
            version: 1,
            status: "failed",
            mediaType:
              "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            byteCount: null,
            queuedAt: "2026-09-19T08:00:00.000Z",
            readyAt: null,
            failedAt: "2026-09-19T08:02:00.000Z",
            contentUrl: "/unexpected",
          },
        }),
      ],
    });

    expect(projected.map(({ status, downloadUrl }) => ({ status, downloadUrl })))
      .toEqual([
        { status: "queued", downloadUrl: null },
        { status: "failed", downloadUrl: null },
      ]);
  });

  it("rejects mismatched versions, media, unsafe filenames, and malformed status data", () => {
    const cases = [
      artifact({ currentVersion: 3 }),
      artifact({
        current: {
          ...artifact().current as Record<string, unknown>,
          mediaType: "application/octet-stream",
        },
      }),
      artifact({ filename: "../Client pitch.pptx" }),
      artifact({
        current: {
          ...artifact().current as Record<string, unknown>,
          status: "ready",
          byteCount: null,
        },
      }),
      artifact({ id: "generated_artifact_not-valid" }),
    ];

    for (const candidate of cases) {
      expect(projectResultsGeneratedArtifacts({ artifacts: [candidate] })).toEqual([]);
    }
  });

  it("rejects invalid list envelopes and download identities", () => {
    expect(projectResultsGeneratedArtifacts(null)).toEqual([]);
    expect(projectResultsGeneratedArtifacts({ artifacts: {} })).toEqual([]);
    expect(() => resultsGeneratedArtifactDownloadUrl("bad", 1)).toThrow(
      "Invalid generated artifact identity.",
    );
    expect(() => resultsGeneratedArtifactDownloadUrl(artifactId, 0)).toThrow(
      "Invalid generated artifact identity.",
    );
  });
});
