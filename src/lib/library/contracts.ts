import { z } from "zod";

export const WORKSPACE_LIBRARY_SCHEMA_VERSION = 1 as const;

export const workspaceLibraryKindSchema = z.enum([
  "document",
  "spreadsheet",
  "presentation",
  "file",
  "image",
  "audio",
  "video",
  "recording",
  "transcript",
  "email",
  "meeting",
  "message",
  "webpage",
  "record",
  "generated_artifact",
]);

export const workspaceLibrarySourceAuthoritySchema = z.enum([
  "capture_asset",
  "capture_recording",
  "capture_transcript",
  "project_artifact",
  "mission_artifact",
  "source_item",
]);

const idSchema = z.string().trim().min(1).max(320);
const optionalIdSchema = idSchema.nullable();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const timestampSchema = z.string().datetime({ offset: true });

export const workspaceLibraryScopeSchema = z.object({
  visibility: z.enum([
    "user_private",
    "mission_shared",
    "project_shared",
    "workspace_shared",
  ]),
  ownerActorId: idSchema,
  workspaceId: optionalIdSchema,
  projectId: optionalIdSchema,
  missionId: optionalIdSchema,
  workItemId: optionalIdSchema,
  permissionBasis: z.enum(["owner", "workspace_member", "project_member"]),
}).strict().superRefine((scope, context) => {
  if (scope.visibility === "workspace_shared" && !scope.workspaceId) {
    context.addIssue({ code: "custom", path: ["workspaceId"], message: "Workspace-shared assets require a workspace." });
  }
  if (scope.visibility === "project_shared" && !scope.projectId) {
    context.addIssue({ code: "custom", path: ["projectId"], message: "Project-shared assets require a project." });
  }
  if (scope.visibility === "mission_shared" && !scope.missionId) {
    context.addIssue({ code: "custom", path: ["missionId"], message: "Mission-shared assets require a mission." });
  }
});

export const workspaceLibraryVersionSchema = z.object({
  versionId: idSchema,
  versionNumber: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  contentSha256: sha256Schema,
  byteCount: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  mediaType: z.string().trim().min(3).max(160),
  sourceRevisionId: optionalIdSchema,
  createdAt: timestampSchema,
}).strict();

export const workspaceLibraryLinkSchema = z.object({
  kind: z.enum([
    "source",
    "workspace",
    "project",
    "work_item",
    "mission",
    "knowledge_document",
  ]),
  id: idSchema,
  label: z.string().trim().min(1).max(240),
  href: z.string().trim().startsWith("/").max(2_048).nullable(),
}).strict();

export const workspaceLibraryItemSchema = z.object({
  schemaVersion: z.literal(WORKSPACE_LIBRARY_SCHEMA_VERSION),
  id: idSchema,
  tenantId: idSchema,
  kind: workspaceLibraryKindSchema,
  sourceAuthority: workspaceLibrarySourceAuthoritySchema,
  sourceId: idSchema,
  title: z.string().trim().min(1).max(240),
  summary: z.string().trim().max(600),
  sourceLabel: z.string().trim().min(1).max(120),
  status: z.enum(["processing", "ready", "failed", "unsupported"]),
  tags: z.array(z.string().trim().min(1).max(80)).max(50),
  scope: workspaceLibraryScopeSchema,
  currentVersion: workspaceLibraryVersionSchema,
  versionCount: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  citationRefs: z.array(idSchema).min(1).max(64),
  links: z.array(workspaceLibraryLinkSchema).max(16),
  openHref: z.string().trim().startsWith("/").max(2_048).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
}).strict().superRefine((item, context) => {
  if (item.currentVersion.versionNumber > item.versionCount) {
    context.addIssue({ code: "custom", path: ["versionCount"], message: "Current version exceeds the version count." });
  }
  if (new Set(item.citationRefs).size !== item.citationRefs.length) {
    context.addIssue({ code: "custom", path: ["citationRefs"], message: "Citation references must be unique." });
  }
});

export type WorkspaceLibraryKind = z.infer<typeof workspaceLibraryKindSchema>;
export type WorkspaceLibraryItem = z.infer<typeof workspaceLibraryItemSchema>;
export type WorkspaceLibraryScope = z.infer<typeof workspaceLibraryScopeSchema>;

export function parseWorkspaceLibraryItem(value: unknown) {
  return Object.freeze(workspaceLibraryItemSchema.parse(value));
}

export function parseWorkspaceLibraryItems(values: readonly unknown[]) {
  return Object.freeze(values.map(parseWorkspaceLibraryItem));
}
