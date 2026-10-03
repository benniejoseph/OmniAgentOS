import { describe, expect, it } from "vitest";
import { contentSearchQuerySchema, searchLikePattern } from "./contracts";
import { encodeSearchCursor, parseContentSearchRequest } from "./cursor";
import { searchContext, searchTimestamp, searchThreadId } from "./test-fixtures";
const url = (query: string) => new URL(`https://asael.example/api/content-search?${query}`);

describe("scoped content search requests", () => {
  it("bounds queries and excludes punctuation-only retrieval", () => {
    expect(contentSearchQuerySchema.parse("  Quarterly report  ")).toBe("Quarterly report");
    for (const query of ["", "a", "___ % \\", "a".repeat(241)]) expect(contentSearchQuerySchema.safeParse(query).success).toBe(false);
    expect(searchLikePattern("a_%\\")).toBe("%a\\_\\%\\\\%");
    expect(parseContentSearchRequest(url("q=report"), searchContext)).toEqual({ query: "report", limit: 8 });
    for (const suffix of ["&limit=21", "&limit=0", "&limit=8.5", "&q=extra", "&actor=other", "&provider=all"]) {
      expect(() => parseContentSearchRequest(url(`q=report${suffix}`), searchContext)).toThrow();
    }
  });
  it("binds each page to provider, exact query, owner, tenant and role", () => {
    const cursor = encodeSearchCursor(searchContext, "report", { provider: "conversations", after: { id: searchThreadId, updatedAt: searchTimestamp }, offset: null });
    const href = url(`q=report&provider=conversations&cursor=${cursor}`);
    expect(parseContentSearchRequest(href, searchContext).cursor?.after?.updatedAt).toBe(searchTimestamp);
    for (const changed of [{ ...searchContext, tenantId: "other" }, { ...searchContext, actorId: "other" }, { ...searchContext, role: "viewer" as const }]) {
      expect(() => parseContentSearchRequest(href, changed)).toThrow("Search changed");
    }
    for (const changed of [url(`q=other&provider=conversations&cursor=${cursor}`), url(`q=report&provider=memory&cursor=${cursor}`), url(`q=report&cursor=${cursor}`)]) {
      expect(() => parseContentSearchRequest(changed, searchContext)).toThrow("Search changed");
    }
  });
  it("rejects malformed/cross-kind cursors and bounds the Library window", () => {
    expect(() => encodeSearchCursor(searchContext, "report", { provider: "library", after: null, offset: 10_001 })).toThrow();
    expect(() => encodeSearchCursor(searchContext, "report", { provider: "memory", after: null, offset: 8 })).toThrow();
    expect(() => parseContentSearchRequest(url("q=report&provider=library&cursor=%%%"), searchContext)).toThrow();
    const cursor = encodeSearchCursor(searchContext, "report", { provider: "library", after: null, offset: 16 });
    expect(parseContentSearchRequest(url(`q=report&provider=library&cursor=${cursor}`), searchContext).cursor?.offset).toBe(16);
  });
});
