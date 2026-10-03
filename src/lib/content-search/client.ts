import type { ContentSearchResponse } from "./contracts";
import { contentSearchProviders } from "./model";

/** Search is mounted in the global shell: its display boundary must not pull
 * the server schema runtime into every route. Storage still uses contracts.ts. */
export function parseContentSearchQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const query = value.trim();
  return query.length >= 2 && query.length <= 240 && /[\p{L}\p{N}]/u.test(query) ? query : undefined;
}
function record(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === null || prototype === Object.prototype) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}
function text(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum;
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 19) === value.slice(0, 19);
}
export function parseContentSearchResponse(value: unknown): ContentSearchResponse | undefined {
  try {
    if (!record(value, ["query", "generatedAt", "groups", "consistency"])) return undefined;
    const query = parseContentSearchQuery(value.query);
    if (!query || !timestamp(value.generatedAt) || value.consistency !== "live" || !Array.isArray(value.groups)
      || value.groups.length < 1 || value.groups.length > 4) return undefined;
    for (const group of value.groups) {
      if (!record(group, ["provider", "label", "coverage", "status", "items", "nextCursor", "message"])
        || !contentSearchProviders.some((provider) => provider === group.provider)
        || typeof group.label !== "string" || typeof group.coverage !== "string"
        || (group.status !== "ready" && group.status !== "unavailable")
        || !Array.isArray(group.items) || group.items.length > 20
        || (group.nextCursor !== null && !text(group.nextCursor, 0, 1800))
        || (group.message !== null && !text(group.message, 0, 300))) return undefined;
      for (const item of group.items) {
        if (!record(item, ["id", "title", "detail", "updatedAt", "href"])
          || !text(item.id, 1, 360) || !text(item.title, 1, 300) || !text(item.detail, 0, 300)
          || !timestamp(item.updatedAt) || !text(item.href, 0, 1600)
          || !/^\/app\/(command|projects|memory|capture)\?/.test(item.href)) return undefined;
      }
    }
    return { ...value, query } as ContentSearchResponse;
  } catch { return undefined; }
}
