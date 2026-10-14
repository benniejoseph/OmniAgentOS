import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import { createAppServiceCaller } from "./contracts";

const mocks = vi.hoisted(() => ({ item: vi.fn(), asset: vi.fn(), extraction: vi.fn() }));
vi.mock("@/lib/library/store", () => ({ getWorkspaceLibraryItem: mocks.item, listWorkspaceLibrary: vi.fn() }));
vi.mock("@/lib/capture/assets", () => ({ getCaptureAssetForRequest: mocks.asset, getCaptureAssetExtractionForRequest: mocks.extraction }));
import { showWorkspaceLibraryItemService } from "./library";

const context = { tenantId: "tenant-a", actorId: "owner@example.test", role: "operator" as const, source: "session" as const,
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-a", tenantName: "Workspace" } };
const item = { id: "library:capture_asset:brief", tenantId: "tenant-a", status: "ready", sourceAuthority: "capture_asset", sourceId: "brief",
  currentVersion: { versionId: "version-1", contentSha256: "a".repeat(64), sourceRevisionId: "revision-1" },
  links: [{ kind: "knowledge_document", id: "knowledge-1" }],
} as WorkspaceLibraryItem;
// This is the exact request retained in an attached-file disclosure before an approval pause.
const pinnedRequest = { libraryItemId: item.id, contentPage: { versionId: "version-1", contentSha256: "a".repeat(64), extractionReceiptSha256: "c".repeat(64) } };

describe("resumed attached-source requests retain current authorization", () => {
  beforeEach(() => {
    mocks.item.mockReset(); mocks.asset.mockReset(); mocks.extraction.mockReset();
  });

  it("refuses a previously pinned source after its current access was revoked", async () => {
    mocks.item.mockResolvedValue(undefined);
    await expect(showWorkspaceLibraryItemService(createAppServiceCaller({ context }), pinnedRequest))
      .rejects.toMatchObject({ code: "library_content_unavailable" });
    expect(mocks.item).toHaveBeenCalledWith(expect.objectContaining({ tenantId: context.tenantId, actorId: context.actorId,
      libraryItemId: item.id, requestActorBinding: expect.objectContaining({ canonicalActorId: `actor:${context.auth.userId}` }) }));
    expect(mocks.asset).not.toHaveBeenCalled();
  });

  it("refuses stale version pins before opening Capture content", async () => {
    mocks.item.mockResolvedValue({ ...item, currentVersion: { ...item.currentVersion, versionId: "version-2" } });
    await expect(showWorkspaceLibraryItemService(createAppServiceCaller({ context }), pinnedRequest))
      .rejects.toMatchObject({ code: "library_content_changed" });
    expect(mocks.asset).not.toHaveBeenCalled();
  });

  it("rechecks access after extraction rather than returning newly revoked source text", async () => {
    mocks.item.mockResolvedValueOnce(item).mockResolvedValueOnce(undefined);
    mocks.asset.mockResolvedValue({ status: "indexed", contentSha256: "a".repeat(64), knowledgeDocumentId: "knowledge-1" });
    mocks.extraction.mockResolvedValue({ evidenceAvailable: true, receipt: { contentSha256: "b".repeat(64), receiptSha256: "c".repeat(64) },
      units: [{ knowledgeChunkId: "chunk-1", content: "Do not disclose revoked text." }] });
    await expect(showWorkspaceLibraryItemService(createAppServiceCaller({ context }), pinnedRequest))
      .rejects.toMatchObject({ code: "library_content_changed" });
    expect(mocks.item).toHaveBeenCalledTimes(2);
  });

  it("refuses a new extraction after approval even when the binary version and digest did not change", async () => {
    mocks.item.mockResolvedValue({ ...item, currentVersion: { ...item.currentVersion, sourceRevisionId: "revision-reindexed" } });
    mocks.asset.mockResolvedValue({ status: "indexed", contentSha256: "a".repeat(64), knowledgeDocumentId: "knowledge-1" });
    mocks.extraction.mockResolvedValue({ evidenceAvailable: true, receipt: { contentSha256: "d".repeat(64), receiptSha256: "e".repeat(64) },
      units: [{ knowledgeChunkId: "chunk-reindexed", content: "New extraction must not replace the paused source." }] });
    await expect(showWorkspaceLibraryItemService(createAppServiceCaller({ context }), pinnedRequest))
      .rejects.toMatchObject({ code: "library_content_changed" });
    expect(mocks.item).toHaveBeenCalledOnce();
    expect(mocks.extraction).toHaveBeenCalledOnce();
  });
});
