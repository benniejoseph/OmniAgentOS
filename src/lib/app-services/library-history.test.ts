import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ list: vi.fn(), exact: vi.fn() }));
vi.mock("@/lib/library/history-store", () => ({ listWorkspaceLibraryVersions: mocks.list, getWorkspaceLibraryVersion: mocks.exact }));
import { appServiceReceiptSchema, createAppServiceCaller } from "./contracts";
import { listWorkspaceLibraryVersionsService, showWorkspaceLibraryVersionService } from "./library-history";
import { getAppServiceOperationContract } from "./registry";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { LibraryHistoryError } from "@/lib/library/history-contracts";
import type { SecurityContext } from "@/lib/security/types";

const context: SecurityContext = { tenantId: "tenant-a", actorId: "owner@example.test", role: "viewer", source: "session",
  auth: { userId: "11111111-1111-4111-8111-111111111111", email: "owner@example.test", sessionId: "session-a", tenantName: "Workspace" } };
const itemId = "library:source_item:source:one", versionId = "version:source_item:source:one:revision:two";
beforeEach(() => { mocks.list.mockReset(); mocks.exact.mockReset(); });

describe("Library version application services", () => {
  it("registers two read-only operations with the current Library permission and event semantics", () => {
    for (const operation of ["app.library.versions.list", "app.library.versions.show"] as const) {
      expect(getAppServiceOperationContract(operation)).toEqual({ operation, action: "read", resourceType: "workspace_library_item",
        accessMode: "read", eventContract: "read_only:no_domain_mutation" });
    }
  });
  it("binds list reads to the authenticated canonical/legacy pair and exact bounded query", async () => {
    const data = { versions: [{ versionId }], currentVersionId: versionId, authorityEffect: "none" };
    mocks.list.mockResolvedValueOnce(data);
    const result = await listWorkspaceLibraryVersionsService(createAppServiceCaller({ context }), {
      libraryItemId: itemId, query: { limit: 1, before: versionId, currentVersionId: versionId },
    });
    expect(mocks.list).toHaveBeenCalledWith({ tenantId: context.tenantId, actorId: context.actorId, libraryItemId: itemId,
      requestActorBinding: expect.objectContaining({ canonicalActorId: `actor:${context.auth!.userId}`,
        legacyOwnerActorIds: [context.actorId], readableOwnerActorIds: [`actor:${context.auth!.userId}`, context.actorId] }) },
    { limit: 1, before: versionId, currentVersionId: versionId });
    expect(result.receipt).toMatchObject({ operation: "app.library.versions.list", accessMode: "read", resourceCount: 1,
      outcomeSha256: canonicalJsonSha256(data), idempotencyKeySha256: null });
    expect(appServiceReceiptSchema.parse(result.receipt)).toEqual(result.receipt);
  });
  it("gives exact-version reads their own receipt operation and preserves the full version identity", async () => {
    const data = { version: { versionId }, currentVersionId: versionId, authorityEffect: "none" };
    mocks.exact.mockResolvedValueOnce(data);
    const result = await showWorkspaceLibraryVersionService(createAppServiceCaller({ context }), { libraryItemId: itemId, versionId });
    expect(mocks.exact).toHaveBeenCalledWith(expect.objectContaining({ libraryItemId: itemId, versionId }), {});
    expect(result.receipt).toMatchObject({ operation: "app.library.versions.show", resourceCount: 1, outcomeSha256: canonicalJsonSha256(data) });
    expect(JSON.stringify(result.receipt)).not.toContain(versionId);
  });
  it("rejects authority overrides and an unpinned continuation before calling storage", async () => {
    for (const input of [{ libraryItemId: itemId, tenantId: "other" }, { libraryItemId: itemId, query: { before: versionId } }]) {
      await expect(listWorkspaceLibraryVersionsService(createAppServiceCaller({ context }), input)).rejects.toThrow();
    }
    expect(mocks.list).not.toHaveBeenCalled();
  });
  it("preserves current-access failures without manufacturing a successful receipt", async () => {
    const unavailable = new LibraryHistoryError("library_history_unavailable", 404, "Current source unavailable.");
    mocks.exact.mockRejectedValueOnce(unavailable);
    await expect(showWorkspaceLibraryVersionService(createAppServiceCaller({ context }), { libraryItemId: itemId, versionId }))
      .rejects.toBe(unavailable);
  });
});
