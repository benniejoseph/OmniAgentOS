import type { TranscriptionDiarized } from "openai/resources/audio/transcriptions";
import {
  DIARIZATION_MODEL,
  TRANSCRIPTION_MODEL,
  hasGoogleMediaKey,
  hasOpenAIKey,
} from "@/lib/config";
import { transcribeGoogleAudio } from "@/lib/google/ai";
import { getOpenAIClient } from "@/lib/openai/client";
import { resolveSpecializedRuntime } from "@/lib/settings/specialized-runtime";
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

export type CaptureDiarizedTranscriptionSegment = Readonly<{
  text: string;
  startMilliseconds: number;
  endMilliseconds: number;
  speakerLabel: string;
  languageTag: string;
}>;

export async function captureTranscriptionConfigured(input?: {
  tenantId?: string;
  actorId?: string;
}) {
  if (hasGoogleMediaKey() || hasOpenAIKey()) return true;
  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: input?.tenantId,
    actorId: input?.actorId,
    scope: "audio",
    requiredCapability: "transcription",
    deploymentModel: TRANSCRIPTION_MODEL,
    deploymentConfigured: false,
  });
  return runtimeModel.configured;
}

export async function transcribeCaptureMediaDiarized(
  media: File,
  languageHints: readonly string[] = [],
  abortSignal?: AbortSignal,
  usageScope?: AiUsageScope,
) {
  const mimeType = media.type.split(";", 1)[0].toLowerCase();
  if (!CAPTURE_MEDIA_TYPES.has(mimeType)) {
    throw new Error("Unsupported audio or video format.");
  }
  const languageTag = normalizedLanguageTag(languageHints[0]) || "en-US";
  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: usageScope?.tenantId,
    actorId: usageScope?.actorId,
    scope: "audio",
    requiredCapability: "transcription",
    deploymentModel: DIARIZATION_MODEL,
    deploymentConfigured: hasOpenAIKey(),
  });
  if (!runtimeModel.configured) {
    const fallback = await transcribeCaptureMedia(
      media,
      abortSignal,
      usageScope,
    );
    return {
      ...fallback,
      fallbackUsed: true,
      segments: fallback.segments.map((segment) => ({
        ...segment,
        speakerLabel: "Unknown",
        languageTag,
      })),
    };
  }

  abortSignal?.throwIfAborted();
  const meteredUsageScope = usageScope
    ? { ...usageScope, ...runtimeModel.usageReceipt }
    : undefined;
  const startedAt = Date.now();
  try {
    const result = await runtimeModel.withApiKey((apiKey) =>
      getOpenAIClient(apiKey ? { apiKey } : undefined).audio.transcriptions.create({
        file: media,
        model: runtimeModel.model,
        response_format: "diarized_json",
        chunking_strategy: "auto",
        ...(languageHints.length === 1
          ? { language: languageTag.split("-", 1)[0].toLowerCase() }
          : {}),
      }, { signal: abortSignal })
    ) as TranscriptionDiarized;
    const durationMs = Math.max(
      1,
      Math.round(Number(result.duration || 0) * 1_000),
    );
    let segments: CaptureDiarizedTranscriptionSegment[] = result.segments
      .flatMap((segment) => {
        const text = segment.text.trim().slice(0, 24_000);
        if (!text) return [];
        const startMilliseconds = Math.max(
          0,
          Math.round(Number(segment.start) * 1_000),
        );
        const endMilliseconds = Math.min(
          durationMs,
          Math.max(
            startMilliseconds + 1,
            Math.round(Number(segment.end) * 1_000),
          ),
        );
        return [{
          text,
          startMilliseconds,
          endMilliseconds,
          speakerLabel: safeSpeakerLabel(segment.speaker),
          languageTag,
        }];
      });
    const text = result.text.trim().slice(0, 100_000);
    if (!segments.length && text) {
      segments = [{
        text,
        startMilliseconds: 0,
        endMilliseconds: durationMs,
        speakerLabel: "Unknown",
        languageTag,
      }];
    }
    if (!text || !segments.length) {
      throw new Error("No speech could be recognized in this recording.");
    }
    if (meteredUsageScope) {
      await recordAiUsageSafely({
        ...meteredUsageScope,
        status: "completed",
        provider: "openai",
        model: runtimeModel.model,
        usage: { inputBytes: media.size },
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 0,
        latencyMs: Date.now() - startedAt,
      });
    }
    return {
      text,
      model: runtimeModel.model,
      fallbackUsed: false,
      durationMs,
      segments,
    };
  } catch (error) {
    if (meteredUsageScope) {
      await recordAiUsageSafely({
        ...meteredUsageScope,
        status: "failed",
        provider: "openai",
        model: runtimeModel.model,
        usage: { inputBytes: media.size },
        providerCallCount: 1,
        attemptCount: 1,
        failedAttemptCount: 1,
        latencyMs: Date.now() - startedAt,
        failureKind: abortSignal?.aborted ? "abort" : "provider_error",
        retryable: !abortSignal?.aborted,
      });
    }
    if (abortSignal?.aborted) throw error;
    const fallback = await transcribeCaptureMedia(
      media,
      abortSignal,
      usageScope,
    );
    return {
      ...fallback,
      fallbackUsed: true,
      segments: fallback.segments.map((segment) => ({
        ...segment,
        speakerLabel: "Unknown",
        languageTag,
      })),
    };
  }
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
  const mimeType = media.type.split(";", 1)[0].toLowerCase();
  if (!CAPTURE_MEDIA_TYPES.has(mimeType)) throw new Error("Unsupported audio or video format.");

  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: usageScope?.tenantId,
    actorId: usageScope?.actorId,
    scope: "audio",
    requiredCapability: "transcription",
    deploymentModel: TRANSCRIPTION_MODEL,
    deploymentConfigured: hasOpenAIKey(),
  });
  const meteredUsageScope = usageScope
    ? { ...usageScope, ...runtimeModel.usageReceipt }
    : undefined;

  let text = "";
  let model = "";
  let fallbackUsed = false;
  let segments: CaptureTranscriptionSegment[] = [];
  let durationMs = 0;
  if (
    runtimeModel.source !== "tenant_assignment" &&
    hasGoogleMediaKey() &&
    CAPTURE_AUDIO_TYPES.has(mimeType)
  ) {
    try {
      const result = await transcribeGoogleAudio(
        media,
        abortSignal,
        meteredUsageScope,
      );
      text = result.text;
      model = result.model;
      segments = result.segments;
      durationMs = result.durationMs;
    } catch (error) {
      if (!runtimeModel.configured) throw error;
      fallbackUsed = true;
    }
  }
  if (!text && runtimeModel.configured) {
    abortSignal?.throwIfAborted();
    const startedAt = Date.now();
    try {
      const result = await runtimeModel.withApiKey((apiKey) =>
        getOpenAIClient(apiKey ? { apiKey } : undefined).audio.transcriptions.create({
          file: media,
          model: runtimeModel.model,
          response_format: "verbose_json",
          timestamp_granularities: ["segment"],
        })
      );
      text = result.text;
      model = runtimeModel.model;
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
      if (meteredUsageScope) {
        await recordAiUsageSafely({
          ...meteredUsageScope,
          status: "completed",
          provider: "openai",
          model: runtimeModel.model,
          usage: { inputBytes: media.size },
          providerCallCount: 1,
          attemptCount: 1,
          failedAttemptCount: 0,
          latencyMs: Date.now() - startedAt,
        });
      }
    } catch (error) {
      if (meteredUsageScope) {
        await recordAiUsageSafely({
          ...meteredUsageScope,
          status: "failed",
          provider: "openai",
          model: runtimeModel.model,
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
  if (!text && !runtimeModel.configured) {
    throw new Error("Audio transcription is not configured.");
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

function normalizedLanguageTag(value: string | undefined) {
  const candidate = value?.trim();
  return candidate && /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/.test(candidate)
    ? candidate
    : undefined;
}

function safeSpeakerLabel(value: string) {
  return value.trim().replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ").slice(0, 80) || "Unknown";
}
