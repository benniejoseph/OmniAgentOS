import { z } from "zod";

/**
 * The reviewed realtime voice declaration a client attaches to one command.
 * The web route and the native contract share it so both clients get one
 * voice policy. The server never trusts it alone; see `command-gate.ts`.
 */
export const voiceCommandInputSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.literal("realtime_voice"),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  provider: z.literal("openai"),
  confidenceBand: z.enum(["high", "low", "unavailable", "edited"]),
  confidenceMean: z.number().min(0).max(1).optional(),
  confidenceMinimum: z.number().min(0).max(1).optional(),
  confidenceSampleCount: z.number().int().min(0).max(10_000),
  reviewMethod: z.enum(["send_button", "explicit_checkbox"]),
  reviewAttested: z.literal(true),
}).strict();

export type VoiceCommandInput = z.infer<typeof voiceCommandInputSchema>;
