import { describe, expect, it } from "vitest";
import {
  workspaceLibraryKindLabel,
  workspaceLibraryQueryHref,
  workspaceLibraryVersionSize,
} from "@/components/workspace-library";

describe("workspace library UI helpers", () => {
  it("builds a bounded repeatable kind query without leaking undefined scope", () => {
    expect(workspaceLibraryQueryHref({
      query: " launch plan ",
      kinds: ["image", "transcript", "image"],
      projectId: "project-1",
      limit: 500,
    })).toBe("/api/library?q=launch+plan&kind=image&kind=transcript&project=project-1&limit=100");
    expect(workspaceLibraryQueryHref({
      kinds: ["email"],
      limit: 25,
      offset: 50,
    })).toBe("/api/library?kind=email&limit=25&offset=50");
  });

  it("uses human labels for canonical kinds", () => {
    expect(workspaceLibraryKindLabel("generated_artifact")).toBe("Generated");
    expect(workspaceLibraryKindLabel("spreadsheet")).toBe("Spreadsheet");
  });

  it("does not present hash-only source metadata as a zero-byte file", () => {
    expect(workspaceLibraryVersionSize({
      versionId: "version-1",
      versionNumber: 1,
      contentSha256: "a".repeat(64),
      byteCount: 0,
      mediaType: "application/x.asael-source-metadata",
      sourceRevisionId: "revision-1",
      createdAt: "2026-09-08T00:00:00.000Z",
    })).toBe("Metadata only");
  });
});
