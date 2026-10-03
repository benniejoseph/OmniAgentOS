import { createHash } from "node:crypto";
import { z } from "zod";
import { contentSearchProviders, contentSearchQuerySchema, searchPositionSchema, type ContentSearchProvider } from "./contracts";
import type { SecurityContext } from "@/lib/security/types";

export class ContentSearchRequestError extends Error {
  constructor(message: string, readonly code = "invalid_search", readonly status = 400) { super(message); }
}
const cursorSchema = z.object({
  version: z.literal(1), provider: z.enum(contentSearchProviders),
  query: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().regex(/^[a-f0-9]{64}$/),
  after: searchPositionSchema.nullable(), offset: z.number().int().min(0).max(10_000).nullable(),
}).strict().refine((value) => value.provider === "library"
  ? value.after === null && value.offset !== null
  : value.after !== null && value.offset === null);
export type ContentSearchCursor = z.infer<typeof cursorSchema>;
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function fingerprints(context: SecurityContext, query: string) {
  return {
    query: digest(["content-search-query:1", query]),
    owner: digest(["content-search-owner:1", context.tenantId, context.actorId, context.auth?.userId ?? null, context.role]),
  };
}
export function encodeSearchCursor(context: SecurityContext, query: string, input: Pick<ContentSearchCursor, "provider" | "after" | "offset">) {
  return Buffer.from(JSON.stringify(cursorSchema.parse({ version: 1, ...fingerprints(context, query), ...input }))).toString("base64url");
}
export type ContentSearchRequest = { query: string; limit: number; provider?: ContentSearchProvider; cursor?: ContentSearchCursor };
export function parseContentSearchRequest(url: URL, context: SecurityContext): ContentSearchRequest {
  if ([...url.searchParams.keys()].some((key) => !["q", "limit", "provider", "cursor"].includes(key)) ||
      [...new Set(url.searchParams.keys())].some((key) => url.searchParams.getAll(key).length !== 1)) {
    throw new ContentSearchRequestError("Search contains unsupported or repeated parameters.");
  }
  const query = contentSearchQuerySchema.safeParse(url.searchParams.get("q"));
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 8;
  const provider = url.searchParams.get("provider") ?? undefined;
  if (!query.success || !Number.isInteger(limit) || limit < 1 || limit > 20 ||
      (provider !== undefined && !contentSearchProviders.includes(provider as ContentSearchProvider))) {
    throw new ContentSearchRequestError("Enter 2–240 characters including a word or number, with a page size of 1–20.");
  }
  const raw = url.searchParams.get("cursor");
  let cursor: ContentSearchCursor | undefined;
  if (raw !== null) {
    try {
      if (!provider || raw.length > 1800 || !/^[A-Za-z0-9_-]+$/.test(raw)) throw new Error();
      cursor = cursorSchema.parse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
      const expected = fingerprints(context, query.data);
      if (cursor.provider !== provider || cursor.query !== expected.query || cursor.owner !== expected.owner) throw new Error();
    } catch { throw new ContentSearchRequestError("Search changed. Start this search again.", "search_cursor_changed", 409); }
  }
  return { query: query.data, limit, ...(provider ? { provider: provider as ContentSearchProvider } : {}), ...(cursor ? { cursor } : {}) };
}
