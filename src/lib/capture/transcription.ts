import { TRANSCRIPTION_MODEL, hasGoogleMediaKey, hasOpenAIKey } from "@/lib/config";
import { transcribeGoogleAudio } from "@/lib/google/ai";
import { getOpenAIClient } from "@/lib/openai/client";
import { recordAiUsageSafely } from "@/lib/usage/ledger";
import type { AiUsageScope } from "@/lib/usage/types";

export const CAPTURE_AUDIO_TYPES = new Set([
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
]);

export const CAPTURE_VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
]);

export const CAPTURE_MEDIA_TYPES = new Set([
  ...CAPTURE_AUDIO_TYPES,
  ...CAPTURE_VIDEO_TYPES,
]);

export type CaptureTranscriptionSegment = Readonly<{
  text: string;
  startMilliseconds: number;
  endMilliseconds: number;
}>;

export function captureTranscriptionConfigured() {
  return hasGoogleMediaKey() || hasOpenAIKey();
}

export async function transcribeCaptureAudio(
  audio: File,
  abortSignal?: AbortSignal,
  usageScope?: AiUsageScope,
) {
  const mimeType = audio.type.split(";", 1)[0].toLowerCase();
  if (!CAPTURE_AUDIO_TYPES.has(mimeType)) throw new Error("Unsupported audio format.");
  return transcribeCaptureMedia(audio, abortSignal, usageScope);
}

export async function transcribeCaptureMedia(
  media: File,
  abortSignal?: AbortSignal,
  usageScope?: AiUsageScope,
) {
  if (!captureTranscriptionConfigured()) throw new Error("Voice transcription is not configured.");
  const mimeType = media.type.split(";", 1)[0].toLowerCase();
  if (!CAPTURE_MEDIA_TYPES.has(mimeType)) throw new Error("Unsupported audio or video format.");

  let text = "";
  let model = "";
  let fallbackUsed = false;
  let segments: CaptureTranscriptionSegment[] = [];
  let durationMs = 0;
  if (hasGoogleMediaKey() && CAPTURE_AUDIO_TYPES.has(mimeType)) {
    try {
      const result = await transcribeGoogleAudio(media, abortSignal, usageScope);
      text = result.text;
      model = result.model;
      segments = result.segments;
      durationMs = result.durationMs;
    } catch (error) {
      if (!hasOpenAIKey()) throw error;
      fallbackUsed = true;
    }
  }
  if (!text && hasOpenAIKey()) {
    abortSignal?.throwIfAborted();
    const startedAt = Date.now();
    try {
      const result = await getOpenAIClient().audio.transcriptions.create({
        file: media,
        model: TRANSCRIPTION_MODEL,
        response_format: "verbose_json",
        timestamp_granularities: ["segment"],
      });
      text = result.text;
      model = TRANSCRIPTION_MODEL;
      durationMs = Math.max(1, Math.round(Number(result.duration || 0) * 1_000));
      segments = (result.segments || []).flatMap((segment) => {
        const content = segment.text.trim();
        if (!content) return [];
        const startMilliseconds = Math.max(0, Math.round(segment.start * 1_000));
        const endMilliseconds = Math.min(
          durationMs,
          Math.max(startMilliseconds + 1, Math.round(segment.end * 1_000)),
        );
        return [{ text: content, startMilliseconds, endMilliseconds }];
      });
      if (!segments.length && text.trim()) {
        segments = [{
          text: text.trim(),
          startMilliseconds: 0,
          endMilliseconds: durationMs,
        }];
      }
      if (usageScope) {
        await recordAiUsageSafely({
          ...usageScope,
          status: "completed",
          provider: "openai",
          model: TRANSCRIPTION_MODEL,
          usage: { inputBytes: media.size },
          providerCallCount: 1,
          attemptCount: 1,
          failedAttemptCount: 0,
          latencyMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      if (usageScope) {
        await recordAiUsageSafely({
          ...usageScope,
          status: "failed",
          provider: "openai",
          model: TRANSCRIPTION_MODEL,
          usage: { inputBytes: media.size },
          providerCallCount: 1,
          attemptCount: 1,
          failedAttemptCount: 1,
          latencyMs: Date.now() - startedAt,
          failureKind: abortSignal?.aborted ? "abort" : "provider_error",
          retryable: !abortSignal?.aborted,
        });
      }
      throw error;
    }
  }
  text = text.trim().slice(0, 100_000);
  if (!text) throw new Error("No speech could be recognized in this recording.");
  return {
    text,
    model,
    fallbackUsed,
    durationMs: Math.max(1, durationMs),
    segments: segments.map((segment) => ({
      ...segment,
      text: segment.text.trim().slice(0, 24_000),
    })).filter((segment) => segment.text),
  };
}
