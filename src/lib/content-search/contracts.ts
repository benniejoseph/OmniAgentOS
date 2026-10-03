import { z } from "zod";
import { contentSearchProviders } from "./model";
export * from "./model";

export const contentSearchQuerySchema = z.string().trim().min(2).max(240)
  .refine((value) => /[\p{L}\p{N}]/u.test(value), "Enter a word or number to search.");
export const searchPositionSchema = z.object({
  updatedAt: z.string().datetime(), id: z.string().min(1).max(300),
}).strict();
export type SearchPosition = z.infer<typeof searchPositionSchema>;
export type SearchPage<T> = { items: T[]; next: SearchPosition | null };
export type SearchMetadata = { id: string; title: string; updatedAt: string };
export const searchItemSchema = z.object({
  id: z.string().min(1).max(360), title: z.string().min(1).max(300),
  detail: z.string().max(300), updatedAt: z.string().datetime(),
  href: z.string().max(1600).refine((value) => /^\/app\/(command|projects|memory|capture)\?/.test(value)),
}).strict();
export type ContentSearchItem = z.infer<typeof searchItemSchema>;
export const searchGroupSchema = z.object({
  provider: z.enum(contentSearchProviders), label: z.string(), coverage: z.string(),
  status: z.enum(["ready", "unavailable"]), items: z.array(searchItemSchema).max(20),
  nextCursor: z.string().max(1800).nullable(), message: z.string().max(300).nullable(),
}).strict();
export type ContentSearchGroup = z.infer<typeof searchGroupSchema>;
export const contentSearchResponseSchema = z.object({
  query: contentSearchQuerySchema, generatedAt: z.string().datetime(),
  groups: z.array(searchGroupSchema).min(1).max(4),
  consistency: z.literal("live"),
}).strict();
export type ContentSearchResponse = z.infer<typeof contentSearchResponseSchema>;

export function searchLikePattern(query: string) {
  return `%${contentSearchQuerySchema.parse(query).replace(/[\\%_]/g, "\\$&")}%`;
}
export function searchDate(value: unknown) {
  return new Date(value instanceof Date ? value : String(value)).toISOString();
}
export function searchPage<T extends SearchMetadata>(rows: T[], limit: number): SearchPage<T> {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return { items, next: rows.length > limit && last ? { updatedAt: last.updatedAt, id: last.id } : null };
}
