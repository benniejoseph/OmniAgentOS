import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { voiceConversationProviderConfigurationSchema, type VoiceConversationProviderConfiguration } from "./conversation-contracts";

export const CONVERSATION_WORK_TOOL = {
  type: "function" as const,
  name: "ask_asael",
  description: "Delegate the user's request to Asael's work agent. Use this for research, saved information, any app action, and every request to operate the selected device: open a browser or website, search YouTube and play a video, navigate Asael, or operate a Mac app. Use it for every task-status or stuck-task question; during active work the app reads the existing task without starting another one. A pause is not evidence that the user must clarify or approve anything. An explicit follow-up to continue or try another approach is an action request: delegate it now, without asking whether to proceed again. Preserve the latest user's wording, names, numbers and destinations; Asael verifies any earlier goal against saved human requests. Asking for autonomy does not release an existing approval hold. Call this before saying that you cannot do the task or giving manual instructions. Asael checks actual capabilities and required approvals. A completed run means the attempt ended; report the result's actual achievement or blocker and never invent completion.",
  parameters: { type: "object", properties: { request: { type: "string", minLength: 1, maxLength: 8000 } },
    required: ["request"], additionalProperties: false },
};

// Ignore provider-added defaults, but retain the entire function description
// and parameter schema. Array order and nested schema values are significant.
const providerSessionSchema = z.object({
  type: z.literal("realtime"),
  model: z.string().min(1).max(240),
  instructions: z.string().min(1),
  tools: z.tuple([z.object({
    type: z.literal("function"), name: z.literal("ask_asael"),
    description: z.string().min(1), parameters: z.record(z.string(), z.unknown()),
  })]),
  tool_choice: z.literal("auto"),
  output_modalities: z.tuple([z.literal("audio")]),
  audio: z.object({
    input: z.object({
      transcription: z.object({ model: z.literal("gpt-4o-mini-transcribe") }),
      turn_detection: z.object({ type: z.literal("server_vad"), create_response: z.literal(true), interrupt_response: z.literal(true) }),
    }),
    output: z.object({ voice: z.literal("cedar") }),
  }),
});

/** A configured undated alias may resolve to its dated snapshot, never vice versa. */
export function conversationProviderModelMatches(expected: string, actual: string): boolean {
  return actual === expected || (!/-\d{4}-\d{2}-\d{2}$/.test(expected) &&
    actual.startsWith(`${expected}-`) && /^\d{4}-\d{2}-\d{2}$/.test(actual.slice(expected.length + 1)));
}

export function conversationProviderConfiguration(session: unknown): VoiceConversationProviderConfiguration | undefined {
  const parsed = providerSessionSchema.safeParse(session);
  if (!parsed.success) return undefined;
  const data = parsed.data;
  return voiceConversationProviderConfigurationSchema.parse({
    schemaVersion: 1,
    instructionsSha256: createHash("sha256").update(data.instructions, "utf8").digest("hex"),
    toolsSha256: canonicalJsonSha256(data.tools),
    model: data.model,
    voice: data.audio.output.voice,
    transcriptionModel: data.audio.input.transcription.model,
    turnDetection: data.audio.input.turn_detection.type,
    createResponse: data.audio.input.turn_detection.create_response,
    interruptResponse: data.audio.input.turn_detection.interrupt_response,
    toolChoice: data.tool_choice,
    outputModalities: data.output_modalities,
  });
}

export function conversationProviderConfigurationMatches(
  expected: VoiceConversationProviderConfiguration, actual: VoiceConversationProviderConfiguration,
): boolean {
  return conversationProviderModelMatches(expected.model, actual.model) &&
    canonicalJsonSha256({ ...expected, model: actual.model }) === canonicalJsonSha256(actual);
}

export const conversationProviderConfigurationSha256 = canonicalJsonSha256;
