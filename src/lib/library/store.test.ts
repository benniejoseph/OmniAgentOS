import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  databaseEnabled: false,
  files: new Map<string, unknown>(),
  readJsonFile: vi.fn(),
  sql: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/capture/actor-scope", () => ({
  captureActorReadOrder: vi.fn((actorId: string) => [actorId, actorId]),
}));
vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(),
  getSql: () => ({ transaction: mocks.transaction }),
  hasDatabaseUrl: () => mocks.databaseEnabled,
}));
vi.mock("@/lib/storage/json", () => ({
  readJsonFile: mocks.readJsonFile,
}));
vi.mock("@/lib/storage/paths", () => ({
  getDataPath: (...parts: string[]) => parts.join("/"),
}));

import {
  captureAssetLibraryItem,
  captureRecordingLibraryItems,
  listWorkspaceLibrary,
  missionArtifactLibraryItem,
  projectArtifactLibraryItem,
  sourceItemLibraryItem,
} from "@/lib/library/store";

const createdAt = "2026-09-07T00:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.databaseEnabled = false;
  mocks.files.clear();
  mocks.readJsonFile.mockImplementation(async (
    file: string,
    fallback: unknown,
  ) => mocks.files.get(file) || fallback);
  mocks.transaction.mockImplementation(async (
    operation: (sql: typeof mocks.sql) => unknown,
  ) => operation(mocks.sql));
});

describe("workspace library facets", () => {
  it("counts every searched kind before applying the requested kind", async () => {
    mocks.files.set("capture-assets.json", { assets: [
      {
        id: "asset-document",
        tenantId: "tenant-1",
        actorId: "actor-1",
        filename: "ICT liquidity notes.txt",
        mediaType: "text/plain",
        byteCount: 120,
        contentSha256: "1".repeat(64),
        status: "indexed",
        extractionStatus: "completed",
        tags: ["ict"],
        metadata: {},
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "asset-image",
        tenantId: "tenant-1",
        actorId: "actor-1",
        filename: "ICT liquidity map.png",
        mediaType: "image/png",
        byteCount: 240,
        contentSha256: "2".repeat(64),
        status: "indexed",
        extractionStatus: "completed",
        tags: ["ict"],
        metadata: {},
        createdAt,
        updatedAt: createdAt,
      },
      {
        id: "asset-unmatched",
        tenantId: "tenant-1",
        actorId: "actor-1",
        filename: "Holiday photo.png",
        mediaType: "image/png",
        byteCount: 360,
        contentSha256: "3".repeat(64),
        status: "indexed",
        extractionStatus: "completed",
        tags: ["personal"],
        metadata: {},
        createdAt,
        updatedAt: createdAt,
      },
    ] });

    const result = await listWorkspaceLibrary({
      tenantId: "tenant-1",
      actorId: "actor-1",
      query: "ICT liquidity",
      kinds: ["image"],
      limit: 10,
    });

    expect(result.items.map((item) => item.kind)).toEqual(["image"]);
    expect(result).toMatchObject({
      total: 1,
      totalIsLowerBound: false,
      nextOffset: null,
      countsByKind: { document: 1, image: 1 },
      countsAreLowerBound: false,
    });
  });

  it("keeps an older requested kind reachable beyond the neutral facet window", async () => {
    const documents = Array.from({ length: 130 }, (_, index) => ({
      id: `asset-document-${String(index).padStart(3, "0")}`,
      tenantId: "tenant-1",
      actorId: "actor-1",
      filename: `Recent note ${index}.txt`,
      mediaType: "text/plain",
      byteCount: 120,
      contentSha256: "a".repeat(64),
      status: "indexed",
      extractionStatus: "completed",
      tags: ["notes"],
      metadata: {},
      createdAt,
      updatedAt: "2026-09-08T00:00:00.000Z",
    }));
    mocks.files.set("capture-assets.json", { assets: [
      ...documents,
      {
        id: "asset-older-image",
        tenantId: "tenant-1",
        actorId: "actor-1",
        filename: "Older visual map.png",
        mediaType: "image/png",
        byteCount: 240,
        contentSha256: "b".repeat(64),
        status: "indexed",
        extractionStatus: "completed",
        tags: ["visual"],
        metadata: {},
        createdAt,
        updatedAt: "2026-09-01T00:00:00.000Z",
      },
    ] });

    const result = await listWorkspaceLibrary({
      tenantId: "tenant-1",
      actorId: "actor-1",
      kinds: ["image"],
      limit: 10,
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "library:capture_asset:asset-older-image",
    ]);
    expect(result.countsByKind).toEqual({ document: 130, image: 1 });
    expect(result.countsAreLowerBound).toBe(false);
    expect(result.nextOffset).toBeNull();
  });

  it("keeps database facet bounds separate and never hydrates full capture bodies", async () => {
    mocks.databaseEnabled = true;
    mocks.sql.mockResolvedValue([{
      capture_rows: [],
      recording_rows: [],
      project_rows: [],
      mission_rows: [],
      source_rows: [],
      result_window_full: false,
      facet_window_full: true,
    }]);

    const result = await listWorkspaceLibrary({
      tenantId: "tenant-1",
      actorId: "actor-1",
      kinds: ["image"],
      limit: 10,
    });

    const statement = (mocks.sql.mock.calls[0]?.[0] as readonly string[])
      .join("?");
    expect(result).toMatchObject({
      total: 0,
      totalIsLowerBound: false,
      countsAreLowerBound: true,
    });
    expect(statement).toContain("WITH capture_result_ids AS MATERIALIZED");
    expect(statement).toContain("LEFT(recording.transcript, 600)");
    expect(statement).not.toContain("SELECT asset.*");
    expect(statement).not.toContain("SELECT recording.*");
  });

  it("applies project and search scope before computing cross-kind facets", async () => {
    mocks.files.set("projects.json", {
      projects: [
        { id: "project-1", tenantId: "tenant-1", actorId: "actor-1", title: "Launch" },
        { id: "project-2", tenantId: "tenant-1", actorId: "actor-1", title: "Archive" },
      ],
      tasks: [],
      artifacts: [{
          id: "artifact-in-project",
          tenantId: "tenant-1",
          projectId: "project-1",
          status: "verified",
          title: "Launch brief",
          content: "Launch research",
          evidenceRefs: [],
          createdAt,
          updatedAt: createdAt,
        }, {
          id: "artifact-outside-project",
          tenantId: "tenant-1",
          projectId: "project-2",
          status: "verified",
          title: "Launch archive",
          content: "Launch research",
          evidenceRefs: [],
          createdAt,
          updatedAt: createdAt,
        }],
    });
    mocks.files.set("missions.json", {
      missions: [{
        id: "mission-1",
        tenantId: "tenant-1",
        actorId: "actor-1",
        title: "Launch research",
      }],
      tasks: [],
      attempts: [],
      artifacts: [{
        id: "mission-image",
        tenantId: "tenant-1",
        actorId: "actor-1",
        missionId: "mission-1",
        canonical_project_id: "project-1",
        kind: "image",
        title: "Launch map",
        data: { summary: "Launch research diagram" },
        mimeType: "image/png",
        createdAt,
        updatedAt: createdAt,
      }],
    });

    const result = await listWorkspaceLibrary({
      tenantId: "tenant-1",
      actorId: "actor-1",
      projectId: "project-1",
      query: "launch",
      kinds: ["image"],
      limit: 10,
    });

    expect(result.items.map((item) => item.id)).toEqual([
      "library:mission_artifact:mission-image",
    ]);
    expect(result.countsByKind).toEqual({
      generated_artifact: 1,
      image: 1,
    });
    expect(result.total).toBe(1);
  });
});

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
