import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ current: vi.fn(), sql: vi.fn(), database: true,
  scope: vi.fn(async (_tenant: string, _actors: readonly string[], operation: () => Promise<unknown>) => operation()) }));
vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(async () => undefined), getSql: () => mocks.sql,
  hasDatabaseUrl: () => mocks.database, runWithDatabaseActorScope: mocks.scope,
}));
vi.mock("./store", () => ({ getWorkspaceLibraryItem: mocks.current }));
import type { WorkspaceLibraryItem } from "./contracts";
import { getWorkspaceLibraryVersion, listWorkspaceLibraryVersions } from "./history-store";

const actorId = "owner@example.test", authUserId = "11111111-1111-4111-8111-111111111111";
const canonicalActorId = `actor:${authUserId}`;
const sourceId = "source:item/with:colons";
const input = { tenantId: "tenant-a", actorId, libraryItemId: `library:source_item:${sourceId}`,
  requestActorBinding: { version: 1 as const, kind: "auth_user" as const, authUserId, canonicalActorId,
    legacyOwnerActorIds: [actorId], readableOwnerActorIds: [canonicalActorId, actorId] } };
const versionId = (id: string) => `version:source_item:${sourceId}:${id}`;
function current(): WorkspaceLibraryItem {
  return { schemaVersion: 1, id: input.libraryItemId, tenantId: input.tenantId, kind: "file", sourceAuthority: "source_item",
    sourceId, title: "Private current title", summary: "Current content stays outside history", sourceLabel: "Drive", status: "ready", tags: [],
    scope: { visibility: "user_private", ownerActorId: canonicalActorId, workspaceId: null, projectId: null, missionId: null, workItemId: null, permissionBasis: "owner" },
    currentVersion: { versionId: versionId("revision:current"), versionNumber: 8, contentSha256: "a".repeat(64), byteCount: 14,
      mediaType: "text/plain", sourceRevisionId: "revision:current", createdAt: "2026-10-01T00:00:00.000Z" },
    versionCount: 8, citationRefs: ["source-revision:revision:current"], links: [], openHref: null,
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
}
const row = (id: string, hash = "b".repeat(64)) => ({ id, source_revision_sha256: "c".repeat(64), content_sha256: hash,
  content_byte_length: 14, media_type: "text/plain", captured_at: "2026-09-01T00:00:00.000Z" });
const window = (versions = [row("revision:current", "a".repeat(64))]) => ({ current_count: "1", current_revision_id: "revision:current",
  current_content_sha256: "a".repeat(64), cursor_valid: true, versions });
beforeEach(() => {
  mocks.database = true;
  mocks.current.mockReset().mockResolvedValue(current());
  mocks.sql.mockReset().mockResolvedValue([window()]);
  mocks.scope.mockClear();
});

describe("authorized Library history reads", () => {
  it("retains exact immutable receipts while omitting titles, content and invented ordinals", async () => {
    mocks.sql.mockResolvedValueOnce([window([row("revision:older")])]);
    const result = await getWorkspaceLibraryVersion({ ...input, versionId: versionId("revision:older") });
    expect(result.version).toMatchObject({ versionId: versionId("revision:older"), sourceRevisionId: "revision:older", current: false,
      sourceRevisionSha256: "c".repeat(64), contentSha256: "b".repeat(64), ordinal: null, historicalAttachmentAuthority: "none" });
    expect(JSON.stringify(result)).not.toContain("Private current title");
    expect(JSON.stringify(result)).not.toContain("Current content stays outside history");
    expect(mocks.scope).toHaveBeenCalledWith(input.tenantId, [canonicalActorId, actorId], expect.any(Function));
    expect(mocks.current).toHaveBeenCalledWith({ ...input, versionId: versionId("revision:older") });
  });
  it("uses one lookahead row and an exact source-bound continuation, with no invented total", async () => {
    mocks.sql.mockResolvedValueOnce([window([row("revision:current", "a".repeat(64)), row("revision:middle"), row("revision:old")])]);
    const result = await listWorkspaceLibraryVersions(input, { limit: 2 });
    expect(result.versions.map((entry) => entry.sourceRevisionId)).toEqual(["revision:current", "revision:middle"]);
    expect(result.coverage).toEqual({ limit: 2, returned: 2, hasMore: true, nextBefore: versionId("revision:middle"), total: null });
    mocks.sql.mockResolvedValueOnce([window([row("revision:old")])]);
    const next = await listWorkspaceLibraryVersions(input, { limit: 2, before: result.coverage.nextBefore!, currentVersionId: result.currentVersionId });
    expect(next.versions.map((entry) => entry.sourceRevisionId)).toEqual(["revision:old"]);
    expect(next.coverage).toMatchObject({ hasMore: false, nextBefore: null });
  });
  it("rejects a stale current pin before attempting the second read", async () => {
    await expect(listWorkspaceLibraryVersions(input, { before: versionId("revision:old"), currentVersionId: versionId("revision:prior") }))
      .rejects.toMatchObject({ code: "library_history_changed", status: 409 });
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("does not trust first-phase visibility after deletion, revocation or retention expiry", async () => {
    for (const second of [[], [{ ...window(), current_count: "0" }], [{ ...window(), current_content_sha256: null }]]) {
      mocks.sql.mockResolvedValueOnce(second);
      await expect(getWorkspaceLibraryVersion({ ...input, versionId: versionId("revision:current") }))
        .rejects.toMatchObject({ code: "library_history_unavailable", status: 404 });
    }
  });
  it("rejects a head replacement or hash replacement between visibility and historical selection", async () => {
    for (const change of [{ current_revision_id: "revision:replacement" }, { current_content_sha256: "f".repeat(64) }]) {
      mocks.sql.mockResolvedValueOnce([{ ...window(), ...change }]);
      await expect(getWorkspaceLibraryVersion({ ...input, versionId: versionId("revision:current") }))
        .rejects.toMatchObject({ code: "library_history_changed", status: 409 });
    }
  });
  it("does not fall back when an exact historical version is absent or a cursor is no longer compatible", async () => {
    mocks.sql.mockResolvedValueOnce([window([])]);
    await expect(getWorkspaceLibraryVersion({ ...input, versionId: versionId("revision:missing") }))
      .rejects.toMatchObject({ code: "library_version_not_found", status: 404 });
    mocks.sql.mockResolvedValueOnce([{ ...window([]), cursor_valid: false }]);
    await expect(listWorkspaceLibraryVersions(input, { before: versionId("revision:expired"), currentVersionId: versionId("revision:current") }))
      .rejects.toMatchObject({ code: "library_history_changed", status: 409 });
  });
  it("does not split colon-bearing identities or accept another source's exact version", async () => {
    await expect(getWorkspaceLibraryVersion({ ...input, versionId: "version:source_item:other:revision:current" }))
      .rejects.toMatchObject({ code: "library_version_not_found" });
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("rejects cross-tenant, cross-source and unrelated physical-owner current projections", async () => {
    for (const item of [null, { ...current(), tenantId: "tenant-other" }, { ...current(), id: "library:source_item:other" },
      { ...current(), scope: { ...current().scope, ownerActorId: "unrelated@example.test" } }]) {
      mocks.current.mockResolvedValueOnce(item);
      await expect(listWorkspaceLibraryVersions(input)).rejects.toMatchObject({ code: "library_history_unavailable" });
    }
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("keeps malformed canonical bindings on the existing exact-actor compatibility path", async () => {
    mocks.current.mockResolvedValueOnce({ ...current(), scope: { ...current().scope, ownerActorId: actorId } });
    await listWorkspaceLibraryVersions({ ...input, requestActorBinding: { ...input.requestActorBinding, authUserId: "malformed" } });
    expect(mocks.scope).toHaveBeenCalledWith(input.tenantId, [actorId, actorId], expect.any(Function));
  });
  it("exposes only each original's known version and never infers a history from versionCount", async () => {
    for (const sourceAuthority of ["capture_asset", "capture_recording", "project_artifact"] as const) {
      const item = current(), key = `version:${sourceAuthority}:original:content`;
      Object.assign(item, { sourceAuthority, sourceId: "original", id: `library:${sourceAuthority}:original` });
      item.currentVersion = { ...item.currentVersion, versionId: key, sourceRevisionId: null };
      mocks.current.mockResolvedValue(item);
      const bound = { ...input, libraryItemId: item.id };
      expect(await listWorkspaceLibraryVersions(bound)).toMatchObject({ coverageBasis: "current_known_version_only",
        versions: [{ versionId: key, ordinal: null, current: true }], coverage: { returned: 1, hasMore: false, total: null } });
      await expect(getWorkspaceLibraryVersion({ ...bound, versionId: `version:${sourceAuthority}:original:missing` }))
        .rejects.toMatchObject({ code: "library_version_not_found" });
    }
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("keeps local transcript fallback truthful when no immutable revision database is available", async () => {
    mocks.database = false;
    const result = await listWorkspaceLibraryVersions(input);
    expect(result).toMatchObject({ coverageBasis: "current_known_version_only", versions: [{ sourceRevisionSha256: null, current: true }] });
    expect(mocks.sql).not.toHaveBeenCalled();
  });
  it("fails closed on oversized, malformed or ambiguous SQL results", async () => {
    for (const invalid of [{ ...window(), current_count: "2" }, { ...window(), versions: "not-an-array" },
      window([row("revision:a"), row("revision:b"), row("revision:c")]), window([{ ...row("revision:current"), content_sha256: "bad" }])]) {
      mocks.sql.mockResolvedValueOnce([invalid]);
      await expect(listWorkspaceLibraryVersions(input, { limit: 1 })).rejects.toThrow();
    }
  });
});
