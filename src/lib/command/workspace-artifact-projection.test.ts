import { describe, expect, it } from "vitest";

import {
  commandWorkspaceArtifactUrl,
  projectCommandWorkspaceArtifactState,
  projectCommandWorkspaceArtifacts,
} from "@/lib/command/workspace-artifact-projection";

const documentId = "1aBcDeFgHiJkLmNoPqRsTuVwXyZ_12345";

describe("Command Google Workspace artifact projection", () => {
  it("projects verified metadata and discards an untrusted provider URL", () => {
    const artifacts = projectCommandWorkspaceArtifacts({
      workspaceArtifacts: [{
        executionId: "execution-1",
        sequence: 4,
        provider: "google_workspace",
        kind: "document",
        resourceId: documentId,
        title: "Service Cloud proposal",
        openUrl: "https://attacker.example/steal",
        createdAt: "2026-09-19T09:30:00.000Z",
      }],
    });

    expect(artifacts).toEqual([{
      executionId: "execution-1",
      sequence: 4,
      provider: "google_workspace",
      kind: "document",
      resourceId: documentId,
      title: "Service Cloud proposal",
      createdAt: "2026-09-19T09:30:00.000Z",
    }]);
    expect(JSON.stringify(artifacts)).not.toContain("attacker.example");
  });

  it("drops malformed, forged, duplicate, and unbounded rows", () => {
    expect(projectCommandWorkspaceArtifacts({ workspaceArtifacts: [
      { executionId: "execution-1", sequence: 0, provider: "other", kind: "document", resourceId: documentId, title: "Wrong provider", createdAt: "2026-09-19T09:30:00.000Z" },
      { executionId: "execution-2", sequence: 1, provider: "google_workspace", kind: "archive", resourceId: documentId, title: "Wrong kind", createdAt: "2026-09-19T09:30:00.000Z" },
      { executionId: "execution-3", sequence: 2, provider: "google_workspace", kind: "document", resourceId: "https://attacker.example", title: "Bad identity", createdAt: "2026-09-19T09:30:00.000Z" },
      { executionId: "execution-4", sequence: 3, provider: "google_workspace", kind: "document", resourceId: documentId, title: "Good", createdAt: "2026-09-19T09:30:00.000Z" },
      { executionId: "execution-5", sequence: 4, provider: "google_workspace", kind: "document", resourceId: documentId, title: "Duplicate", createdAt: "2026-09-19T09:30:00.000Z" },
      { executionId: "execution-6", sequence: 100_001, provider: "google_workspace", kind: "presentation", resourceId: "1AnotherValidResourceId_987654", title: "Too late", createdAt: "2026-09-19T09:30:00.000Z" },
    ] })).toEqual([{
      executionId: "execution-4",
      sequence: 3,
      provider: "google_workspace",
      kind: "document",
      resourceId: documentId,
      title: "Good",
      createdAt: "2026-09-19T09:30:00.000Z",
    }]);
  });

  it("derives only canonical Google editor URLs", () => {
    expect(commandWorkspaceArtifactUrl("document", documentId)).toBe(
      `https://docs.google.com/document/d/${documentId}/edit`,
    );
    expect(commandWorkspaceArtifactUrl("spreadsheet", documentId)).toBe(
      `https://docs.google.com/spreadsheets/d/${documentId}/edit`,
    );
    expect(commandWorkspaceArtifactUrl("presentation", documentId)).toBe(
      `https://docs.google.com/presentation/d/${documentId}/edit`,
    );
    expect(() => commandWorkspaceArtifactUrl("document", "https://attacker.example"))
      .toThrow();
  });

  it("keeps pending and projection outages explicit", () => {
    expect(projectCommandWorkspaceArtifactState({ workspaceArtifactState: "pending" }))
      .toBe("pending");
    expect(projectCommandWorkspaceArtifactState({ workspaceArtifactState: "unavailable" }))
      .toBe("unavailable");
    expect(projectCommandWorkspaceArtifactState({ workspaceArtifactState: "provider_error" }))
      .toBe("none");
  });
});
