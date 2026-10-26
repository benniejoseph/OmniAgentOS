import type { AppBuilderTreeEntry } from "@/lib/app-builder/contracts";

type TreePage = { entries: AppBuilderTreeEntry[]; nextCursor?: string; total?: number; truncated?: boolean };

/** Complete one stable bounded tree; callers can stop when the selected project changes. */
export async function readBuilderTreePages(readPage: (cursor?: string) => Promise<TreePage>, isCurrent: () => boolean) {
  const entries: AppBuilderTreeEntry[] = [];
  const cursors = new Set<string>();
  const paths = new Set<string>();
  let cursor: string | undefined;
  let total: number | undefined;
  for (let pageIndex = 0; pageIndex < 60; pageIndex++) {
    const page = await readPage(cursor);
    if (!isCurrent()) return undefined;
    if (!Array.isArray(page.entries) || page.entries.length > 500 || (page.total !== undefined && (!Number.isInteger(page.total) || page.total < 0 || page.total > 30_000 || (total !== undefined && total !== page.total)))) {
      throw new Error("The source tree changed or exceeded its page boundary. Refresh it to continue.");
    }
    total = page.total ?? total;
    for (const entry of page.entries) {
      if (!entry || typeof entry.path !== "string" || paths.has(entry.path)) throw new Error("The source tree returned duplicate or invalid entries. Refresh it to continue.");
      paths.add(entry.path);
      entries.push(entry);
    }
    if (!page.nextCursor) {
      if (page.truncated || (total !== undefined && entries.length !== total)) throw new Error("The source tree response is incomplete. Refresh it to continue.");
      return entries;
    }
    if (!page.entries.length || cursors.has(page.nextCursor)) throw new Error("The source tree cursor did not advance. Refresh it to continue.");
    cursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new Error("The source tree exceeds the reviewed page boundary.");
}
