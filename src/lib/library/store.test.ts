import { describe, expect, it } from "vitest";
import {
  captureAssetLibraryItem,
  captureRecordingLibraryItems,
  missionArtifactLibraryItem,
  projectArtifactLibraryItem,
  sourceItemLibraryItem,
} from "@/lib/library/store";

const createdAt = "2026-09-07T00:00:00.000Z";

describe("workspace library projections", () => {
  it("projects captured images as downloadable private, cited versions", () => {
    const item = captureAssetLibraryItem({
      id: "asset-1",
      tenant_id: "tenant-1",
      actor_id: "actor-1",
      filename: "diagram.png",
      media_type: "image/png",
      byte_count: 100,
      content_sha256: "a".repeat(64),
      status: "indexed",
      extraction_status: "completed",
      tags: ["design"],
      created_at: createdAt,
      updated_at: createdAt,
    }, "actor-1");

    expect(item).toMatchObject({
      kind: "image",
      status: "ready",
      versionCount: 1,
      citationRefs: ["capture-asset:asset-1"],
      scope: { visibility: "user_private", permissionBasis: "owner" },
    });
    expect(item.openHref).toContain("download=1");
  });

  it("projects one recording and a separately citable transcript", () => {
    const items = captureRecordingLibraryItems({
      id: "recording-1",
      tenant_id: "tenant-1",
      actor_id: "actor-1",
      title: "Customer call",
      status: "ready",
      segment_count: 2,
      duration_ms: 61_000,
      byte_count: 1_000,
      transcript_preview: "The customer approved the plan.",
      source_revision_id: "revision-1",
      knowledge_content_sha256: "b".repeat(64),
      transcript_version_count: 2,
      created_at: createdAt,
      updated_at: createdAt,
    });

    expect(items.map((item) => item.kind)).toEqual(["recording", "transcript"]);
    expect(items[1]).toMatchObject({
      versionCount: 2,
      currentVersion: { versionNumber: 2, sourceRevisionId: "revision-1" },
    });
  });

  it("links generated project and mission artifacts to canonical work", () => {
    const project = projectArtifactLibraryItem({
      id: "artifact-1",
      tenant_id: "tenant-1",
      owner_actor_id: "actor-1",
      project_id: "legacy-project-1",
      project_title: "Launch",
      task_id: "legacy-task-1",
      canonical_workspace_id: "workspace:personal:actor-1",
      canonical_project_id: "project-1",
      canonical_work_item_id: "work-item-1",
      status: "verified",
      title: "Launch brief",
      content: "Verified launch brief",
      evidence_refs: ["workflow:run-1"],
      created_at: createdAt,
      updated_at: createdAt,
    });
    const mission = missionArtifactLibraryItem({
      id: "mission-artifact-1",
      tenant_id: "tenant-1",
      actor_id: "actor-1",
      mission_id: "mission-1",
      mission_title: "Research",
      canonical_workspace_id: "workspace:personal:actor-1",
      canonical_project_id: "mission-project-1",
      canonical_work_item_id: "work-item-2",
      kind: "result",
      title: "Research result",
      data: { summary: "Verified findings" },
      created_at: createdAt,
      updated_at: createdAt,
    });

    expect(project.links.map((link) => link.kind)).toEqual(expect.arrayContaining(["project", "work_item"]));
    expect(project.citationRefs).toContain("workflow:run-1");
    expect(mission.scope).toMatchObject({ visibility: "mission_shared", missionId: "mission-1" });
    expect(mission.links.map((link) => link.kind)).toContain("mission");
  });

  it("preserves connected-source revision counts, citations, and source scope", () => {
    const item = sourceItemLibraryItem({
      id: "source-1",
      tenant_id: "tenant-1",
      owner_actor_id: "actor-1",
      current_revision_id: "revision-2",
      source_kind: "calendar_event",
      connection_id: "google.calendar.primary",
      visibility: "project_shared",
      workspace_id: "workspace:personal:actor-1",
      project_id: "project-1",
      content_sha256: "c".repeat(64),
      content_byte_length: 500,
      media_type: "text/calendar",
      version_count: 2,
      knowledge_title: "Weekly planning",
      created_at: createdAt,
      updated_at: createdAt,
      revision_created_at: createdAt,
    });

    expect(item).toMatchObject({
      kind: "meeting",
      title: "Weekly planning",
      versionCount: 2,
      scope: { visibility: "project_shared", projectId: "project-1" },
    });
    expect(item.citationRefs).toEqual([
      "source-item:source-1",
      "source-revision:revision-2",
    ]);
  });

  it("labels hash-only Drive rows as metadata instead of exposing a grant id", () => {
    const item = sourceItemLibraryItem({
      id: "source-drive",
      tenant_id: "tenant-1",
      owner_actor_id: "actor-1",
      current_revision_id: "revision-drive",
      source_kind: "file",
      connection_id: "85735b1a-private-grant",
      adapter_id: "google-drive.metadata-canonical",
      content_sha256: "d".repeat(64),
      content_byte_length: 0,
      media_type: "application/x.asael-source-metadata",
      version_count: 2,
      created_at: createdAt,
      updated_at: createdAt,
      revision_created_at: createdAt,
    });

    expect(item).toMatchObject({
      title: "File from Google Drive",
      sourceLabel: "Google Drive",
      summary: "File metadata · 2 versions · source-backed",
    });
    expect(JSON.stringify(item)).not.toContain("85735b1a");
  });
});
