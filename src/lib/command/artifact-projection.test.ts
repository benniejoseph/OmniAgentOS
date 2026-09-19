import { describe, expect, it } from "vitest";

import {
  commandArtifactContentUrl,
  projectCommandFileArtifactState,
  projectCommandFileArtifacts,
} from "@/lib/command/artifact-projection";

const artifactId = `generated_artifact_${"a".repeat(48)}`;

describe("Command file artifact projection", () => {
  it("projects bounded presentation metadata and discards an untrusted URL", () => {
    const artifacts = projectCommandFileArtifacts({
      fileArtifacts: [{
        executionId: "execution-1",
        sequence: 3,
        artifactId,
        version: 2,
        kind: "presentation",
        title: "Service Cloud proposal",
        filename: "service-cloud-proposal.pptx",
        mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        byteCount: 42_000,
        status: "ready",
        createdAt: "2026-09-19T09:30:00.000Z",
        slideCount: 8,
        theme: "aurora",
        contentUrl: "https://attacker.example/private.pptx",
      }],
    });

    expect(artifacts).toEqual([{
      executionId: "execution-1",
      sequence: 3,
      artifactId,
      version: 2,
      kind: "presentation",
      title: "Service Cloud proposal",
      filename: "service-cloud-proposal.pptx",
      mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      byteCount: 42_000,
      status: "ready",
      createdAt: "2026-09-19T09:30:00.000Z",
      slideCount: 8,
      theme: "aurora",
    }]);
    expect(JSON.stringify(artifacts)).not.toContain("attacker.example");
  });

  it("drops malformed identities, media types, filenames, and non-ready rows", () => {
    expect(projectCommandFileArtifacts({ fileArtifacts: [
      { executionId: "a", sequence: 0, artifactId: "bad", version: 1, kind: "presentation", title: "A", filename: "a.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", byteCount: 1, status: "ready", createdAt: "2026-09-19T09:30:00Z" },
      { executionId: "b", sequence: 1, artifactId, version: 1, kind: "presentation", title: "B", filename: "../b.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", byteCount: 1, status: "ready", createdAt: "2026-09-19T09:30:00Z" },
      { executionId: "c", sequence: 2, artifactId, version: 1, kind: "presentation", title: "C", filename: "c.pptx", mediaType: "application/pdf", byteCount: 1, status: "ready", createdAt: "2026-09-19T09:30:00Z" },
      { executionId: "d", sequence: 3, artifactId, version: 1, kind: "presentation", title: "D", filename: "d.pptx", mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation", byteCount: 1, status: "rendering", createdAt: "2026-09-19T09:30:00Z" },
    ] })).toEqual([]);
  });

  it("derives only same-origin content routes from a verified identity", () => {
    expect(commandArtifactContentUrl(artifactId, 2)).toBe(
      `/api/artifacts/${artifactId}/content?version=2`,
    );
    expect(commandArtifactContentUrl(artifactId, 2, { download: true })).toBe(
      `/api/artifacts/${artifactId}/content?version=2&download=1`,
    );
    expect(() => commandArtifactContentUrl("https://attacker.example", 1)).toThrow();
  });

  it("keeps projection outages explicit without accepting arbitrary states", () => {
    expect(projectCommandFileArtifactState({ fileArtifactState: "unavailable" }))
      .toBe("unavailable");
    expect(projectCommandFileArtifactState({ fileArtifactState: "provider_error" }))
      .toBe("none");
  });
});
