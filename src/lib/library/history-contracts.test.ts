import { describe, expect, it } from "vitest";
import {
  LIBRARY_HISTORY_CONTRACT, libraryHistoryEntrySchema, libraryHistoryListQuerySchema,
  libraryHistoryListResponseSchema, libraryHistoryReadQuerySchema, libraryHistoryReadResponseSchema,
} from "./history-contracts";

const version = (revision: string, current = false) => ({
  versionId: `version:source_item:source:with:colons:${revision}`,
  sourceRevisionId: revision, sourceRevisionSha256: "a".repeat(64), contentSha256: "b".repeat(64),
  byteCount: 12, mediaType: "text/plain", capturedAt: "2026-10-01T00:00:00.000Z", ordinal: null,
  current, citationRefs: [`source-revision:${revision}`], contentAvailability: "metadata_only",
  historicalAttachmentAuthority: "none",
});
const envelope = {
  schemaVersion: 1, contract: LIBRARY_HISTORY_CONTRACT, libraryItemId: "library:source_item:source:with:colons",
  tenantId: "tenant-a", sourceAuthority: "source_item", sourceId: "source:with:colons",
  currentVersionId: version("revision:current").versionId, coverageBasis: "retained_compatible_revisions",
  authorityEffect: "none", commandAttachmentPolicy: "current_library_resolution_required",
};
const page = () => ({ ...envelope, versions: [version("revision:current", true), version("revision:older")],
  coverage: { limit: 2, returned: 2, hasMore: true, nextBefore: version("revision:older").versionId, total: null } });

describe("Library retained-version contracts", () => {
  it("keeps full colon-bearing identities and metadata-only authority explicit", () => {
    expect(libraryHistoryListResponseSchema.parse(page())).toEqual(page());
    const exact = { ...envelope, version: version("revision:older") };
    expect(libraryHistoryReadResponseSchema.parse(exact)).toEqual(exact);
  });
  it("requires an exact head pin for every continuation and bounds page size", () => {
    expect(libraryHistoryListQuerySchema.parse({})).toEqual({ limit: 40 });
    expect(libraryHistoryListQuerySchema.parse({ limit: 100, before: version("revision:older").versionId,
      currentVersionId: envelope.currentVersionId }).limit).toBe(100);
    for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { before: version("revision:older").versionId },
      { currentVersionId: envelope.currentVersionId }, { tenantId: "other" }]) {
      expect(libraryHistoryListQuerySchema.safeParse(query).success).toBe(false);
    }
    expect(libraryHistoryReadQuerySchema.safeParse({ before: version("revision:older").versionId }).success).toBe(false);
  });
  it("rejects fabricated ordinals, archived-byte availability and historical attach authority", () => {
    for (const change of [{ ordinal: 1 }, { contentAvailability: "available" }, { historicalAttachmentAuthority: "attach" },
      { downloadUrl: "/private/file" }, { byteCount: Number.MAX_SAFE_INTEGER + 1 }]) {
      expect(libraryHistoryEntrySchema.safeParse({ ...version("revision:older"), ...change }).success).toBe(false);
    }
  });
  it("rejects cross-source current heads even on an empty page", () => {
    expect(libraryHistoryListResponseSchema.safeParse({ ...page(), currentVersionId: "version:source_item:other:head",
      versions: [], coverage: { limit: 2, returned: 0, hasMore: false, nextBefore: null, total: null } }).success).toBe(false);
  });
  it("rejects a revision receipt paired with a different exact version or missing revision hash", () => {
    for (const change of [{ sourceRevisionId: "revision:other" }, { sourceRevisionSha256: null },
      { sourceRevisionId: null }, { versionId: "version:source_item:other:revision:older" }]) {
      expect(libraryHistoryReadResponseSchema.safeParse({ ...envelope, version: { ...version("revision:older"), ...change } }).success).toBe(false);
    }
  });
  it("rejects incoherent page counts, duplicate rows and a cursor not naming the final row", () => {
    const valid = page();
    for (const invalid of [{ ...valid, coverage: { ...valid.coverage, returned: 1 } },
      { ...valid, coverage: { ...valid.coverage, limit: 3 } },
      { ...valid, coverage: { ...valid.coverage, nextBefore: envelope.currentVersionId } },
      { ...valid, coverage: { ...valid.coverage, total: 9 } },
      { ...valid, versions: [valid.versions[1], valid.versions[1]] }]) {
      expect(libraryHistoryListResponseSchema.safeParse(invalid).success).toBe(false);
    }
  });
  it("rejects false current flags and duplicate or excessive citation references", () => {
    expect(libraryHistoryReadResponseSchema.safeParse({ ...envelope, version: version("revision:older", true) }).success).toBe(false);
    for (const citationRefs of [[], ["same", "same"], Array.from({ length: 65 }, (_, index) => `citation:${index}`)]) {
      expect(libraryHistoryEntrySchema.safeParse({ ...version("revision:older"), citationRefs }).success).toBe(false);
    }
  });
  it("permits only the known current version for a source without retained revision metadata", () => {
    const current = { ...version("revision:current", true), sourceRevisionSha256: null };
    const known = { ...envelope, coverageBasis: "current_known_version_only", version: current };
    expect(libraryHistoryReadResponseSchema.safeParse(known).success).toBe(true);
    expect(libraryHistoryReadResponseSchema.safeParse({ ...known, version: version("revision:older") }).success).toBe(false);
    expect(libraryHistoryListResponseSchema.safeParse({ ...page(), coverageBasis: "current_known_version_only" }).success).toBe(false);
  });
});
