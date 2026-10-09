import { z } from "zod";
import { commandContextReferencesSchema } from "@/lib/command/composer-context-contract";
import { CONTEXT_SCOPE_IDS } from "@/lib/rag/context-scope";
import { REALTIME_PROVIDER_ERROR_CODE_PATTERN } from "@/lib/voice/realtime-error";

const opaqueId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const mode = z.enum(["orchestrate", "research", "execute", "learn"]);
// Wire shape only. Continuous sessions reject query-bound selection locks;
// importing their server-only verifier here would break the browser bundle.
const contextSelectionRequestSchema = z.object({
  query: z.string().trim().min(1).max(4000),
  evidenceIds: z.array(z.string().trim().min(1).max(200).regex(/^(?:memory|knowledge|graph):[^\s]+$/)).max(24),
  lockToken: z.string().min(80).max(24_000).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
}).strict();
export const voiceConversationCommandContextSchema = z.object({
  agentId: opaqueId,
  projectId: opaqueId.optional(),
  mode,
  contextScope: z.enum(CONTEXT_SCOPE_IDS),
  contextReferences: commandContextReferencesSchema,
  contextSelection: contextSelectionRequestSchema.optional(),
}).strict();

export const voiceConversationStartRequestSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().uuid().optional(),
  conversationId: z.string().uuid().optional(),
  reconnectAttempt: z.number().int().min(0).max(3).default(0),
  agentId: opaqueId.default("atlas"),
  projectId: opaqueId.optional(),
  mode: mode.default("orchestrate"),
  contextScope: z.enum(CONTEXT_SCOPE_IDS).default("session"),
  contextReferences: commandContextReferencesSchema.default([]),
  contextSelection: contextSelectionRequestSchema.optional(),
  language: z.string().trim().toLowerCase().regex(/^[a-z]{2}$/).optional(),
  providerConsent: z.literal(true),
  continuousConsent: z.literal(true),
  audioRetention: z.literal("not_stored_by_asael"),
  transcriptRetention: z.literal("conversation_history"),
}).strict().superRefine((value, context) => {
  if (value.reconnectAttempt > 0 && (!value.sessionId || !value.conversationId)) {
    context.addIssue({ code: "custom", message: "Reconnects need the existing voice conversation.", path: ["sessionId"] });
  }
  if (value.contextScope === "project" && !value.projectId) {
    context.addIssue({ code: "custom", message: "Choose a project for project context.", path: ["projectId"] });
  }
});

export const voiceConversationStartResponseSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  clientSecret: z.string().min(4).max(4096).regex(/^ek_[A-Za-z0-9._:@/+~-]+$/),
  clientSecretExpiresAt: z.number().int().positive(),
  transportUrl: z.literal("https://api.openai.com/v1/realtime/calls"),
  provider: z.literal("openai"),
  model: z.string().min(1).max(240),
  language: z.string().min(2).max(4),
  agentName: z.string().min(1).max(120),
  voice: z.literal("cedar"),
  turnDetection: z.literal("server_vad"),
  audioRetention: z.literal("not_stored_by_asael"),
  transcriptRetention: z.literal("conversation_history"),
  reconnectAttempt: z.number().int().min(0).max(3),
  expiresAt: z.string().datetime(),
  commandContext: voiceConversationCommandContextSchema,
}).strict();

export const voiceConversationFinishRequestSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  outcome: z.enum(["ended", "failed"]),
  durationMilliseconds: z.number().int().min(0).max(60 * 60_000),
  turnCount: z.number().int().min(0).max(10_000),
  reconnectCount: z.number().int().min(0).max(3),
  providerErrorCode: z.string().regex(REALTIME_PROVIDER_ERROR_CODE_PATTERN).optional(),
}).strict();
export const voiceConversationFinishResponseSchema = z.object({ recorded: z.literal(true) }).strict();

export type VoiceConversationStartRequest = z.infer<typeof voiceConversationStartRequestSchema>;
export type VoiceConversationStartResponse = z.infer<typeof voiceConversationStartResponseSchema>;
export type VoiceConversationCommandContext = z.infer<typeof voiceConversationCommandContextSchema>;
export type VoiceConversationFinishRequest = z.infer<typeof voiceConversationFinishRequestSchema>;
