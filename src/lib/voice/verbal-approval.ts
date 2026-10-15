import { z } from "zod";

/** Deliberately whole-utterance: quoted, qualified, compound and changed
 * instructions cannot turn an incidental yes into an approval. */
export function verbalApprovalDecision(text: string): "approve" | "reject" | undefined {
  const value = text.toLowerCase().trim().replace(/[.!?,]+$/g, "").trim().replace(/\s+/g, " ");
  if (["yes", "yes please", "approve", "i approve", "approve this action", "yes approve this action", "go ahead"].includes(value)) return "approve";
  if (["no", "no thanks", "reject", "i reject", "reject this action", "do not do that", "don't do that", "cancel this action"].includes(value)) return "reject";
  return undefined;
}

const sessionFields = {
  sessionId: z.string().uuid(), conversationId: z.string().uuid(), runId: z.string().uuid(),
};
export const voiceApprovalReviewSchema = z.object({
  kind: z.literal("tool"),
  voiceReview: z.discriminatedUnion("operation", [
    z.object({ operation: z.literal("prepare"), ...sessionFields }).strict(),
    z.object({ operation: z.literal("present"), ...sessionFields,
      actionSha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  ]),
}).strict();
export const voiceApprovalProofSchema = z.object({
  ...sessionFields,
  presentationId: z.string().uuid(),
  userInputItemId: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
}).strict();
export type VoiceApprovalReview = z.infer<typeof voiceApprovalReviewSchema>["voiceReview"];
export type VoiceApprovalProof = z.infer<typeof voiceApprovalProofSchema>;

export class VerbalApprovalGate {
  private presentation?: { id: string; expiresAt: number };
  private speechPresentation?: string;
  private itemId?: string;
  present(id: string, expiresAt: string) {
    this.clear();
    this.presentation = { id, expiresAt: Date.parse(expiresAt) };
  }
  speechStarted() {
    this.speechPresentation = this.presentation && this.presentation.expiresAt > Date.now() ? this.presentation.id : undefined;
    this.itemId = undefined;
  }
  committed(id: string) { this.itemId = this.speechPresentation === this.presentation?.id ? id : undefined; }
  consume(id: string, text: string) {
    const decision = verbalApprovalDecision(text);
    if (!decision && this.itemId === id) { this.clear(); return undefined; }
    if (!decision || !this.presentation || !(this.presentation.expiresAt > Date.now()) || this.itemId !== id ||
        this.speechPresentation !== this.presentation.id) return undefined;
    const result = { presentationId: this.presentation.id, decision };
    this.clear();
    return result;
  }
  clear() { this.presentation = undefined; this.speechPresentation = undefined; this.itemId = undefined; }
}
