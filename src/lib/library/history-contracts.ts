import { z } from "zod";
import { workspaceLibrarySourceAuthoritySchema } from "./contracts";

export const LIBRARY_HISTORY_CONTRACT = "asael-library-history:1" as const;
const id = z.string().min(1).max(320).regex(/^\S(?:[\s\S]*\S)?$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.string().datetime({ offset: true });
export const libraryHistoryItemIdSchema = id.regex(/^library:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$/);
export const libraryHistoryVersionIdSchema = id.regex(/^version:(capture_asset|capture_recording|capture_transcript|project_artifact|source_item):.+$/);
export const libraryHistoryListQuerySchema = z.object({
  limit: z.number().int().min(1).max(100).default(40),
  before: libraryHistoryVersionIdSchema.optional(),
  currentVersionId: libraryHistoryVersionIdSchema.optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.before) !== Boolean(value.currentVersionId)) {
    context.addIssue({ code: "custom", message: "A continuation requires both its exact version and current-head pin." });
  }
});
export const libraryHistoryReadQuerySchema = z.object({ currentVersionId: libraryHistoryVersionIdSchema.optional() }).strict();
export const libraryHistoryEntrySchema = z.object({
  versionId: libraryHistoryVersionIdSchema,
  sourceRevisionId: id.nullable(),
  sourceRevisionSha256: hash.nullable(),
  contentSha256: hash,
  byteCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().min(3).max(160),
  capturedAt: timestamp,
  ordinal: z.null(),
  current: z.boolean(),
  citationRefs: z.array(id).min(1).max(64),
  contentAvailability: z.literal("metadata_only"),
  historicalAttachmentAuthority: z.literal("none"),
}).strict().superRefine((value, context) => {
  if (value.sourceRevisionSha256 !== null && value.sourceRevisionId === null) {
    context.addIssue({ code: "custom", message: "A revision receipt requires its exact revision ID." });
  }
  if (new Set(value.citationRefs).size !== value.citationRefs.length) context.addIssue({ code: "custom", message: "Citations must be unique." });
});
const envelope = {
  schemaVersion: z.literal(1), contract: z.literal(LIBRARY_HISTORY_CONTRACT),
  libraryItemId: libraryHistoryItemIdSchema, tenantId: id,
  sourceAuthority: workspaceLibrarySourceAuthoritySchema.exclude(["mission_artifact"]), sourceId: id,
  currentVersionId: libraryHistoryVersionIdSchema,
  coverageBasis: z.enum(["retained_compatible_revisions", "current_known_version_only"]),
  authorityEffect: z.literal("none"),
  commandAttachmentPolicy: z.literal("current_library_resolution_required"),
};
export const libraryHistoryListResponseSchema = z.object({
  ...envelope, versions: z.array(libraryHistoryEntrySchema).max(100),
  coverage: z.object({
    limit: z.number().int().min(1).max(100), returned: z.number().int().min(0).max(100),
    hasMore: z.boolean(), nextBefore: libraryHistoryVersionIdSchema.nullable(), total: z.null(),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.libraryItemId !== `library:${value.sourceAuthority}:${value.sourceId}`) context.addIssue({ code: "custom", message: "Library source identity does not match." });
  const prefix = `version:${value.sourceAuthority}:${value.sourceId}:`;
  if (!value.currentVersionId.startsWith(prefix) || value.currentVersionId.length === prefix.length) context.addIssue({ code: "custom", message: "Current head must name this exact source." });
  if (value.versions.length !== value.coverage.returned || value.versions.length > value.coverage.limit ||
      (value.coverage.hasMore && value.versions.length !== value.coverage.limit) ||
      value.coverage.nextBefore !== (value.coverage.hasMore ? value.versions.at(-1)?.versionId ?? null : null)) {
    context.addIssue({ code: "custom", path: ["coverage"], message: "Coverage must describe this exact bounded page." });
  }
  if (new Set(value.versions.map((version) => version.versionId)).size !== value.versions.length) context.addIssue({ code: "custom", message: "Versions must be unique." });
  for (const version of value.versions) {
    if (version.current !== (version.versionId === value.currentVersionId) || !version.versionId.startsWith(prefix) || version.versionId.length === prefix.length ||
        (value.coverageBasis === "retained_compatible_revisions" && (version.sourceRevisionId === null || version.sourceRevisionSha256 === null || version.versionId !== `${prefix}${version.sourceRevisionId}`))) {
      context.addIssue({ code: "custom", message: "Version is not bound to this source and current head." });
    }
  }
  if (value.coverageBasis === "current_known_version_only" && (value.versions.length > 1 || value.coverage.hasMore || value.versions.some((version) => !version.current))) {
    context.addIssue({ code: "custom", message: "A source without retained revisions exposes only its current known version." });
  }
});
export const libraryHistoryReadResponseSchema = z.object({ ...envelope, version: libraryHistoryEntrySchema }).strict().superRefine((value, context) => {
  const prefix = `version:${value.sourceAuthority}:${value.sourceId}:`;
  if (value.libraryItemId !== `library:${value.sourceAuthority}:${value.sourceId}` ||
      !value.currentVersionId.startsWith(prefix) || value.currentVersionId.length === prefix.length ||
      !value.version.versionId.startsWith(prefix) || value.version.versionId.length === prefix.length ||
      value.version.current !== (value.version.versionId === value.currentVersionId) ||
      (value.coverageBasis === "retained_compatible_revisions" && (value.version.sourceRevisionId === null || value.version.sourceRevisionSha256 === null || value.version.versionId !== `${prefix}${value.version.sourceRevisionId}`)) ||
      (value.coverageBasis === "current_known_version_only" && !value.version.current)) {
    context.addIssue({ code: "custom", message: "Version is not bound to this exact readable source." });
  }
});
export type LibraryHistoryEntry = z.infer<typeof libraryHistoryEntrySchema>;
export type LibraryHistoryListQuery = z.input<typeof libraryHistoryListQuerySchema>;
export type LibraryHistoryReadQuery = z.input<typeof libraryHistoryReadQuerySchema>;
export class LibraryHistoryError extends Error {
  constructor(readonly code: "library_history_unavailable" | "library_history_changed" | "library_version_not_found", readonly status: 404 | 409, message: string) {
    super(message); this.name = "LibraryHistoryError";
  }
}
