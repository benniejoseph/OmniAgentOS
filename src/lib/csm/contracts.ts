import { z } from "zod";

const id = z.string().trim().min(1).max(320);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Use a valid calendar date.");

/** Working role and plan notes describe the client; they grant no permissions. */
export const clientProfileSchema = z.object({
  role: z.enum(["secondary", "lead"]).default("secondary"),
  successPlan: z.enum(["unknown", "standard", "premier", "signature"]).default("unknown"),
  leadCsm: z.string().trim().max(240).default(""),
  customerGoals: z.string().trim().max(4_000).default(""),
  successPath: z.string().trim().max(4_000).default(""),
  stakeholders: z.string().trim().max(4_000).default(""),
  nextReviewDate: date.optional(),
}).strict();
export type ClientProfile = z.infer<typeof clientProfileSchema>;

export const csmSourceLinkSchema = z.object({
  libraryItemId: id,
  versionId: id,
  contentSha256: digest,
}).strict();
export type CsmSourceLink = z.infer<typeof csmSourceLinkSchema>;

export const csmProfileWriteSchema = z.object({
  profile: clientProfileSchema,
  expectedRevision: id.nullable(),
}).strict();
export const csmSourceWriteSchema = z.object({
  libraryItemId: id,
  versionId: id.optional(),
  contentSha256: digest.optional(),
  expectedRevision: id.nullable(),
}).strict();
export const csmSourceDeleteSchema = z.object({
  libraryItemId: id,
  expectedRevision: id.nullable(),
}).strict();

export const csmSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("csm_project_context"),
  projectId: id,
  profile: clientProfileSchema,
  sourceLinks: z.array(csmSourceLinkSchema).max(50),
  requestSha256: digest,
}).strict().refine((value) => new Set(value.sourceLinks.map((link) => link.libraryItemId)).size === value.sourceLinks.length,
  "Client sources must be unique.");
export type CsmSnapshot = z.infer<typeof csmSnapshotSchema>;

export class CsmError extends Error {
  constructor(message: string, readonly status: 403 | 404 | 409 | 503) {
    super(message);
    this.name = "CsmError";
  }
}
