import "server-only";

import { getOpenAIClient } from "@/lib/openai/client";

export const REALTIME_TRANSCRIPTION_MODEL = "gpt-4o-mini-transcribe";
export const REALTIME_TRANSPORT_URL = "https://api.openai.com/v1/realtime/calls";
export const REALTIME_AUDIO_RETENTION = "not_stored_by_asael" as const;
export const REALTIME_TRANSCRIPT_RETENTION = "command_draft_until_sent" as const;

export async function issueRealtimeTranscriptionSecret(input: {
  language?: string;
}) {
  const result = await getOpenAIClient().realtime.clientSecrets.create({
    expires_after: {
      anchor: "created_at",
      seconds: 60,
    },
    session: {
      type: "transcription",
      include: ["item.input_audio_transcription.logprobs"],
      audio: {
        input: {
          noise_reduction: { type: "near_field" },
          transcription: {
            model: REALTIME_TRANSCRIPTION_MODEL,
            ...(input.language ? { language: input.language } : {}),
          },
          turn_detection: {
            type: "server_vad",
            create_response: false,
            interrupt_response: false,
            prefix_padding_ms: 300,
            silence_duration_ms: 650,
            threshold: 0.5,
          },
        },
      },
    },
  }, {
    maxRetries: 0,
    timeout: 15_000,
  });

  if (
    result.session.type !== "transcription" ||
    typeof result.value !== "string" ||
    !result.value.startsWith("ek_")
  ) {
    throw new Error("OpenAI returned an invalid realtime transcription credential.");
  }

  return {
    clientSecret: result.value,
    clientSecretExpiresAt: result.expires_at,
    providerSessionId: result.session.id,
    providerSessionExpiresAt: result.session.expires_at,
    model: REALTIME_TRANSCRIPTION_MODEL,
  };
}
