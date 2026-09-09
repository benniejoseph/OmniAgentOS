import "server-only";

import { getOpenAIClient } from "@/lib/openai/client";
import type { VersionedVoiceProfile } from "@/lib/voice/profile";

export async function createOpenAISpeechStream(input: {
  text: string;
  profile: VersionedVoiceProfile;
  apiKey?: string;
  signal?: AbortSignal;
}) {
  const response = await getOpenAIClient(
    input.apiKey ? { apiKey: input.apiKey } : undefined,
  ).audio.speech.create({
    input: input.text,
    model: input.profile.model,
    voice: input.profile.voice,
    instructions: input.profile.instructions,
    response_format: "pcm",
    stream_format: "audio",
  }, {
    signal: input.signal,
    maxRetries: 0,
    timeout: 120_000,
  });
  if (!response.body) {
    throw new Error("OpenAI returned no speech audio stream.");
  }
  return response.body;
}
