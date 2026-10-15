import { z } from "zod";

/** Server-only provenance, retained with the original run across approvals. */
export const voiceTaskBindingSchema = z.object({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1).max(200),
  actorId: z.string().min(1).max(200),
  sessionId: z.string().uuid(),
  conversationId: z.string().uuid(),
  userInputItemId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  userTurnId: z.string().uuid(),
  requestId: z.string().min(1).max(240),
  objective: z.string().min(1).max(8000),
  transcriptSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expiresAt: z.string().datetime(),
}).strict();

export type VoiceTaskBinding = z.infer<typeof voiceTaskBindingSchema>;
export type VoiceTaskPolicy = {
  voiceRiskThreshold?: 0 | 1;
  voiceTaskBinding?: VoiceTaskBinding;
};

/** Removing the extra voice hold does not approve a tool. The governed
 * executor must still prove its narrow task coverage and current policy. */
export function voiceForcesToolReview(policy: VoiceTaskPolicy | undefined, risk: number, toolId?: string) {
  if (policy?.voiceRiskThreshold === undefined || risk <= policy.voiceRiskThreshold) return false;
  const binding = voiceTaskBindingSchema.safeParse(policy.voiceTaskBinding);
  return !(policy.voiceRiskThreshold === 1 && risk === 2 &&
    toolId?.startsWith("local.macos.") && binding.success &&
    Date.parse(binding.data.expiresAt) > Date.now());
}

export function voiceTaskObjective(policy: VoiceTaskPolicy | undefined, ordinaryObjective: string) {
  // Never derive voice authority from the realtime model's rewritten request.
  if (policy?.voiceRiskThreshold === undefined) return ordinaryObjective;
  return voiceTaskBindingSchema.safeParse(policy.voiceTaskBinding).data?.objective ?? "";
}
