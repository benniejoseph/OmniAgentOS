import { describe, expect, it } from "vitest";
import { parseWorkspaceLibraryItem } from "@/lib/library/contracts";

const validItem = {
  schemaVersion: 1,
  id: "library:capture_asset:asset-1",
  tenantId: "tenant-1",
  kind: "file",
  sourceAuthority: "capture_asset",
  sourceId: "asset-1",
  title: "Quarterly plan.pdf",
  summary: "Indexed captured file",
  sourceLabel: "Capture",
  status: "ready",
  tags: ["planning"],
  scope: {
    visibility: "user_private",
    ownerActorId: "actor-1",
    workspaceId: "workspace:personal:actor-1",
    projectId: null,
    missionId: null,
    workItemId: null,
    permissionBasis: "owner",
  },
  currentVersion: {
    versionId: "version:asset-1:one",
    versionNumber: 1,
    contentSha256: "a".repeat(64),
    byteCount: 42,
    mediaType: "application/pdf",
    sourceRevisionId: null,
    createdAt: "2026-09-07T00:00:00.000Z",
  },
  versionCount: 1,
  citationRefs: ["capture-asset:asset-1"],
  links: [{ kind: "source", id: "asset-1", label: "Captured file", href: "/app/capture" }],
  openHref: "/api/capture/assets/asset-1?content=1",
  createdAt: "2026-09-07T00:00:00.000Z",
  updatedAt: "2026-09-07T00:00:00.000Z",
} as const;

describe("workspace library contracts", () => {
  it("accepts a versioned, cited, explicitly scoped item", () => {
    expect(parseWorkspaceLibraryItem(validItem)).toMatchObject({
      sourceAuthority: "capture_asset",
      versionCount: 1,
    });
  });

  it("rejects shared assets without their required scope", () => {
    expect(() => parseWorkspaceLibraryItem({
      ...validItem,
      scope: { ...validItem.scope, visibility: "project_shared", projectId: null },
    })).toThrow(/require a project/i);
  });

  it("rejects duplicate citations and invalid version ordering", () => {
    expect(() => parseWorkspaceLibraryItem({
      ...validItem,
      versionCount: 1,
      currentVersion: { ...validItem.currentVersion, versionNumber: 2 },
      citationRefs: ["capture-asset:asset-1", "capture-asset:asset-1"],
    })).toThrow();
  });
});
