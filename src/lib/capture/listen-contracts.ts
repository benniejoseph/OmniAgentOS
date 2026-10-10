import { z } from "zod";

export const LISTEN_PROCESSING_TERMS = "listen-processing:1" as const;
export const listenTimeZoneSchema = z.string().min(1).max(80).refine(value => {
  try { new Intl.DateTimeFormat("en", { timeZone: value }); return true; } catch { return false; }
}, "Choose a valid time zone.");
export const listenGrantRequestSchema = z.object({
  action: z.enum(["issue", "revoke"]),
  timeZone: listenTimeZoneSchema.default("Asia/Kolkata"),
}).strict();
export const listenStartSchema = z.object({
  action: z.literal("start"), sourceKey: z.string().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/),
  sourceKind: z.enum(["listen", "call"]), title: z.string().trim().min(1).max(240),
  recordedAt: z.string().datetime({ offset: true }), timeZone: listenTimeZoneSchema,
  contextCategory: z.enum(["personal", "work", "unfiled"]).default("unfiled"),
  projectId: z.string().trim().min(1).max(200).optional(),
}).strict().refine(value => !value.projectId || value.contextCategory === "work", "A client belongs in Work.");
export const listenRecordingIdSchema = z.string().regex(/^capture_recording_[a-f0-9]{48}$/);
export const listenIngestRequestSchema = z.union([
  listenStartSchema,
  z.object({ action: z.literal("complete"), recordingId: listenRecordingIdSchema,
    segmentCount: z.number().int().min(1).max(1440) }).strict(),
  z.object({ action: z.literal("status"), recordingId: listenRecordingIdSchema }).strict(),
]);
export const listenSegmentFieldsSchema = z.object({
  action: z.literal("segment"), recordingId: listenRecordingIdSchema,
  segmentIndex: z.coerce.number().int().min(0).max(1439),
  durationMs: z.coerce.number().int().min(1).max(600000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const grantSchema = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{64}$/), expiresAt: z.string().datetime(),
  ingestUrl: z.string().url(), ownerId: z.string(), tenantId: z.string(), canonicalUserId: z.string(),
  deviceId: z.string(), role: z.string(), deploymentId: z.string().url(), apiOrigin: z.string().url(),
  terms: z.literal(LISTEN_PROCESSING_TERMS) }).strict();
const conversationSchema = z.object({ id: listenRecordingIdSchema, title: z.string(), sourceKind: z.enum(["listen", "call"]),
  recordedAt: z.string().datetime(), createdAt: z.string().datetime(), status: z.enum(["recording", "processing", "ready", "failed"]),
  durationMs: z.number().int().nonnegative(), summary: z.string(), category: z.enum(["personal", "work", "unfiled"]),
  projectId: z.string().nullable(), actionCount: z.number().int().nonnegative(), error: z.string().nullable() }).strict();
export const nativeListenSchemas = {
  NativeListenGrantRequest: listenGrantRequestSchema,
  NativeListenGrantResponse: z.union([z.object({ grant: grantSchema }).strict(), z.object({ revoked: z.literal(true) }).strict()]),
  NativeListenIngestRequest: listenIngestRequestSchema,
  NativeListenSegmentRequest: z.object({ action: z.literal("segment"), recordingId: listenRecordingIdSchema,
    segmentIndex: z.string().regex(/^\d{1,4}$/), durationMs: z.string().regex(/^\d{1,6}$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), audio: z.string().meta({ format: "binary" }) }).strict(),
  NativeListenIngestResponse: z.object({ recordingId: listenRecordingIdSchema, status: conversationSchema.shape.status,
    error: z.string().nullable(), receivedSegments: z.number().int().nonnegative(), duplicate: z.boolean().optional() }).strict(),
  NativeListenConversationListResponse: z.object({ conversations: z.array(conversationSchema).max(50) }).strict(),
  NativeListenConversationResponse: z.object({ conversation: conversationSchema.extend({ transcript: z.string(),
    media: z.record(z.string(), z.unknown()).nullable(), clientContext: z.object({
      status: z.enum(["not_requested", "pending", "linked", "needs_attention"]), message: z.string() }).strict() }).strict() }).strict(),
};
export type ListenStart = z.infer<typeof listenStartSchema>;

export class ListenError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); this.name = "ListenError"; }
}
