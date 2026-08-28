import { TRANSCRIPTION_MODEL, hasGoogleMediaKey, hasOpenAIKey } from "@/lib/config";
import { transcribeGoogleAudio } from "@/lib/google/ai";
import { getOpenAIClient } from "@/lib/openai/client";

export const CAPTURE_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
]);

export function captureTranscriptionConfigured() {
  return hasGoogleMediaKey() || hasOpenAIKey();
}

export async function transcribeCaptureAudio(audio: File, abortSignal?: AbortSignal) {
  if (!captureTranscriptionConfigured()) throw new Error("Voice transcription is not configured.");
  const mimeType = audio.type.split(";", 1)[0].toLowerCase();
  if (!CAPTURE_AUDIO_TYPES.has(mimeType)) throw new Error("Unsupported audio format.");

  let text = "";
  let model = "";
  let fallbackUsed = false;
  if (hasGoogleMediaKey()) {
    try {
      const result = await transcribeGoogleAudio(audio, abortSignal);
      text = result.text;
      model = result.model;
    } catch (error) {
      if (!hasOpenAIKey()) throw error;
      fallbackUsed = true;
    }
  }
  if (!text && hasOpenAIKey()) {
    abortSignal?.throwIfAborted();
    const result = await getOpenAIClient().audio.transcriptions.create({
      file: audio,
      model: TRANSCRIPTION_MODEL,
    });
    text = result.text;
    model = TRANSCRIPTION_MODEL;
  }
  text = text.trim().slice(0, 100_000);
  if (!text) throw new Error("No speech could be recognized in this recording.");
  return { text, model, fallbackUsed };
}
