import { z } from "zod";
import { csmSourceLinkSchema } from "./contracts";

export const CSM_ROLE_CONTEXT_LIMITS = Object.freeze({ textCharacters: 20_000, sourceCount: 50 });
export const csmRoleWriteSchema = z.object({
  text: z.string().trim().max(CSM_ROLE_CONTEXT_LIMITS.textCharacters),
  expectedRevision: z.string().trim().min(1).max(320).nullable(),
}).strict();

export const csmRoleSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("csm_role_context"),
  text: z.string().max(CSM_ROLE_CONTEXT_LIMITS.textCharacters),
  sourceLinks: z.array(csmSourceLinkSchema).max(CSM_ROLE_CONTEXT_LIMITS.sourceCount),
  requestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().refine((value) => new Set(value.sourceLinks.map((link) => link.libraryItemId)).size === value.sourceLinks.length,
  "Role sources must be unique.");
export type CsmRoleSnapshot = z.infer<typeof csmRoleSnapshotSchema>;
