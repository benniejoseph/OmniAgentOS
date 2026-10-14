import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";

const mocks = vi.hoisted(() => ({ asset: vi.fn(), extraction: vi.fn() }));
vi.mock("@/lib/capture/assets", () => ({
  getCaptureAssetForRequest: mocks.asset,
  getCaptureAssetExtractionForRequest: mocks.extraction,
  getCaptureAssetContentForRequest: vi.fn(),
}));
import { hydrateCommandFileContext } from "./file-context-hydrator";

const file: WorkspaceLibraryItem = {
  schemaVersion: 1, id: "library:capture_asset:brief", tenantId: "tenant-a", kind: "document", sourceAuthority: "capture_asset", sourceId: "brief",
  title: "Aster Vale brief", summary: "Pilot acceptance", sourceLabel: "Capture", status: "ready", tags: [],
  scope: { visibility: "user_private", ownerActorId: "owner", workspaceId: null, projectId: null, missionId: null, workItemId: null, permissionBasis: "owner" },
  currentVersion: { versionId: "version:brief", versionNumber: 1, contentSha256: "a".repeat(64), byteCount: 1_000, mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", sourceRevisionId: "revision:brief", createdAt: "2026-10-13T00:00:00Z" },
  versionCount: 1, citationRefs: ["capture-asset:brief"], links: [], openHref: "/app/capture", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-13T00:00:00Z",
};

describe("attached Capture content continuation", () => {
  beforeEach(() => {
    mocks.asset.mockReset().mockResolvedValue({ status: "indexed", contentSha256: file.currentVersion.contentSha256 });
    mocks.extraction.mockReset().mockResolvedValue({ evidenceAvailable: true,
      receipt: { receiptSha256: "b".repeat(64), contentSha256: "c".repeat(64) },
      units: [{ evidenceUnitId: "unit:brief", knowledgeChunkId: "chunk:brief", label: "Acceptance", locator: { kind: "text_span" }, content: "Acceptance criteria " + "x".repeat(700) }],
    });
  });

  it("gives a truncated attached excerpt an exact governed page request without granting authority", async () => {
    const result = await hydrateCommandFileContext({ context: { tenantId: "tenant-a", actorId: "owner", role: "operator", source: "session" }, file, query: "acceptance", maxCharacters: 300 });
    expect(result.pin.truncated).toBe(true);
    expect(result.promptContext.furtherContent).toEqual({
      toolId: "app.library.show", input: { libraryItemId: file.id, contentPage: { versionId: "version:brief", contentSha256: "a".repeat(64), extractionReceiptSha256: "b".repeat(64) } },
      coverage: expect.stringContaining("grants no tool authority"),
    });
    expect(result.citationSources[0].citationId).toBe("knowledge:chunk:brief");
    expect(mocks.asset).toHaveBeenCalledWith("brief", expect.objectContaining({ tenantId: "tenant-a", actorId: "owner" }));
  });

  it("does not ask for another read when all extracted content already fits", async () => {
    const result = await hydrateCommandFileContext({ context: { tenantId: "tenant-a", actorId: "owner", role: "operator", source: "session" }, file, query: "acceptance", maxCharacters: 2_000 });
    expect(result.pin.truncated).toBe(false);
    expect(result.promptContext).not.toHaveProperty("furtherContent");
  });
});
