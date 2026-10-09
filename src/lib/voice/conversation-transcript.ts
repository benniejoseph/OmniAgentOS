import { z } from "zod";

/** Client-observed captions, never provider-authenticated action evidence. */
export const conversationVoiceTurnsRequestSchema = z.object({
  schemaVersion: z.literal(2),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  turns: z.array(z.object({
    itemId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    role: z.enum(["user", "assistant"]),
    text: z.string().trim().min(1).max(12_000),
    interrupted: z.boolean().default(false),
  }).strict()).min(1).max(4),
}).strict();

export const conversationVoiceTurnsResponseSchema = z.object({
  recorded: z.literal(true),
  turnIds: z.array(z.string().uuid()).min(1).max(4),
}).strict();

export type ConversationVoiceTurnsRequest = z.infer<typeof conversationVoiceTurnsRequestSchema>;
