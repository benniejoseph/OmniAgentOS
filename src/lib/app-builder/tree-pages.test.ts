import { describe, expect, it, vi } from "vitest";
import { readBuilderTreePages } from "@/lib/app-builder/tree-pages";

describe("Builder tree pagination", () => {
  it("reads every page and stops immediately if project scope changes", async () => {
    const read = vi.fn().mockResolvedValueOnce({ entries: [{ path: "a.ts", kind: "file" }], total: 2, nextCursor: "next", truncated: true })
      .mockResolvedValueOnce({ entries: [{ path: "b.ts", kind: "file" }], total: 2, truncated: false });
    expect(await readBuilderTreePages(read, () => true)).toHaveLength(2);
    expect(read).toHaveBeenNthCalledWith(2, "next");
    read.mockClear();
    read.mockResolvedValue({ entries: [], nextCursor: "next" });
    expect(await readBuilderTreePages(read, () => false)).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("rejects incomplete, duplicate, changed and non-advancing pages", async () => {
    const file = { path: "a.ts", kind: "file" };
    for (const pages of [
      [{ entries: [file], total: 2 }],
      [{ entries: [file], nextCursor: "next" }, { entries: [file] }],
      [{ entries: [file], total: 2, nextCursor: "next" }, { entries: [], total: 3 }],
      [{ entries: [], nextCursor: "next" }],
    ]) {
      const read = vi.fn();
      pages.forEach((page) => read.mockResolvedValueOnce(page));
      await expect(readBuilderTreePages(read, () => true)).rejects.toThrow(/source tree/i);
    }
  });
});
