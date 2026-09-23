import type {
  Transcription,
  TranscriptionDiarized,
  TranscriptionVerbose,
} from "openai/resources/audio/transcriptions";
import {
  DIARIZATION_MODEL,
  GOOGLE_TRANSCRIPTION_MODEL,
  TRANSCRIPTION_PROVIDER,
  TRANSCRIPTION_MODEL,
  hasGoogleMediaKey,
  hasOpenAIKey,
} from "@/lib/config";
import { transcribeGoogleAudio } from "@/lib/google/ai";
import { getOpenAIClient } from "@/lib/openai/client";
import {
  resolveSpecializedRuntime,
  type SpecializedRuntimeResolution,
} from "@/lib/settings/specialized-runtime";
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

export type CaptureTranscriptionFailure = Readonly<{
  code:
    | "transcription_not_configured"
    | "transcription_credential_rejected"
    | "transcription_model_unavailable"
    | "transcription_rate_limited"
    | "transcription_no_speech"
    | "transcription_cancelled"
    | "transcription_provider_unavailable";
  status: number;
  message: string;
  suggestion: string;
}>;

class CaptureTranscriptionRuntimeError extends Error {
  constructor(readonly failure: CaptureTranscriptionFailure) {
    super(failure.message);
    this.name = "CaptureTranscriptionRuntimeError";
  }
}

export async function captureTranscriptionConfigured(input?: {
  tenantId?: string;
  actorId?: string;
}) {
  const deployment = captureDeploymentRoute("audio/wav");
  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: input?.tenantId,
    actorId: input?.actorId,
    scope: "audio",
    requiredCapability: "transcription",
    deploymentProvider: deployment.provider,
    deploymentModel: deployment.model,
    deploymentConfigured: deployment.credentialConfigured,
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
    scope: "audio_diarization",
    requiredCapability: "transcription",
    deploymentModel: DIARIZATION_MODEL,
    deploymentConfigured: hasOpenAIKey(),
  });
  if (!runtimeModel.configured || runtimeModel.provider !== "openai") {
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

  const deployment = captureDeploymentRoute(mimeType);
  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: usageScope?.tenantId,
    actorId: usageScope?.actorId,
    scope: "audio",
    requiredCapability: "transcription",
    deploymentProvider: deployment.provider,
    deploymentModel: deployment.model,
    deploymentConfigured: deployment.credentialConfigured,
  });
  if (!runtimeModel.configured) {
    throw new CaptureTranscriptionRuntimeError(
      transcriptionConfigurationFailure(runtimeModel),
    );
  }
  const meteredUsageScope = usageScope
    ? { ...usageScope, ...runtimeModel.usageReceipt }
    : undefined;

  let text = "";
  let model = "";
  let fallbackUsed = false;
  let segments: CaptureTranscriptionSegment[] = [];
  let durationMs = 0;
  let activeProvider = runtimeModel.provider;
  let activeModel = runtimeModel.model;
  let withActiveApiKey = runtimeModel.withApiKey;
  if (runtimeModel.configured && runtimeModel.provider === "google") {
    try {
      const result = await runtimeModel.withApiKey((apiKey) =>
        transcribeGoogleAudio({
          audio: media,
          model: runtimeModel.model,
          apiKey,
          abortSignal,
          usageScope: meteredUsageScope,
        })
      );
      text = result.text;
      model = result.model;
      segments = result.segments;
      durationMs = result.durationMs;
    } catch (error) {
      if (
        runtimeModel.source === "tenant_assignment" ||
        !hasOpenAIKey() ||
        !TRANSCRIPTION_MODEL
      ) throw error;
      fallbackUsed = true;
      activeProvider = "openai";
      activeModel = TRANSCRIPTION_MODEL;
      withActiveApiKey = (operation) => operation(undefined);
    }
  }
  if (!text && runtimeModel.configured && activeProvider === "openai") {
    abortSignal?.throwIfAborted();
    const startedAt = Date.now();
    try {
      const result = await withActiveApiKey(async (apiKey) => {
        const transcriptions = getOpenAIClient(
          apiKey ? { apiKey } : undefined,
        ).audio.transcriptions;
        if (openAiTranscriptionSupportsVerboseJson(activeModel)) {
          return transcriptions.create(
            {
              file: media,
              model: activeModel,
              response_format: "verbose_json",
              timestamp_granularities: ["segment"],
            },
            { signal: abortSignal },
          );
        }
        return transcriptions.create(
          {
            file: media,
            model: activeModel,
            response_format: "json",
          },
          { signal: abortSignal },
        );
      }) as Transcription | TranscriptionVerbose;
      text = result.text;
      model = activeModel;
      durationMs = openAiTranscriptionDurationMs(result);
      const verboseSegments = "segments" in result
        ? result.segments || []
        : [];
      segments = verboseSegments.flatMap((segment) => {
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
          model: activeModel,
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
          model: activeModel,
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

export function describeCaptureTranscriptionFailure(
  error: unknown,
): CaptureTranscriptionFailure {
  if (error instanceof CaptureTranscriptionRuntimeError) return error.failure;
  const candidate = error as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    message?: unknown;
  } | undefined;
  const name = String(candidate?.name || "");
  const status = Number(candidate?.status);
  const code = String(candidate?.code || "").toLowerCase();
  const message = String(candidate?.message || "").toLowerCase();

  if (name === "AbortError") {
    return {
      code: "transcription_cancelled",
      status: 408,
      message: "Voice transcription was interrupted before it finished.",
      suggestion: "Keep the app open and try recording again.",
    };
  }
  if (
    status === 401 ||
    status === 403 ||
    code === "invalid_api_key" ||
    message.includes("api key not valid") ||
    message.includes("permission_denied")
  ) {
    return {
      code: "transcription_credential_rejected",
      status: 503,
      message: "The transcription provider rejected the credential selected in Settings.",
      suggestion: "Reconnect that provider in Settings, refresh its models, and re-save the transcription route.",
    };
  }
  if (
    status === 429 ||
    code.includes("rate_limit") ||
    message.includes("resource_exhausted") ||
    message.includes("quota")
  ) {
    return {
      code: "transcription_rate_limited",
      status: 429,
      message: "The selected transcription provider has reached its current usage limit.",
      suggestion: "Wait for the limit to reset or choose another transcription route in Settings.",
    };
  }
  if (
    status === 400 ||
    status === 404 ||
    status === 422 ||
    code === "model_not_found" ||
    message.includes("model not found") ||
    message.includes("selected google speech model is invalid")
  ) {
    return {
      code: "transcription_model_unavailable",
      status: 503,
      message: "The transcription model selected in Settings is not available for this provider.",
      suggestion: "Refresh the provider model list and save a model with audio transcription support.",
    };
  }
  if (
    message === "no speech could be recognized in this recording." ||
    message === "google speech could not recognize this recording."
  ) {
    return {
      code: "transcription_no_speech",
      status: 422,
      message: "No clear speech was detected in this recording.",
      suggestion: "Move closer to the microphone, reduce background noise, and try again.",
    };
  }
  return {
    code: "transcription_provider_unavailable",
    status: 502,
    message: "The selected transcription provider could not complete this recording.",
    suggestion: "Try again. If it continues, reconnect the provider or select another transcription model in Settings.",
  };
}

function transcriptionConfigurationFailure(
  runtimeModel: SpecializedRuntimeResolution,
): CaptureTranscriptionFailure {
  return {
    code: "transcription_not_configured",
    status: 503,
    message: runtimeModel.warning ||
      "Voice transcription does not have an active model route.",
    suggestion: runtimeModel.source === "tenant_assignment"
      ? "Open Settings → Models, validate the selected provider, and re-save Audio transcription."
      : "Open Settings → Models and assign Audio transcription, or explicitly configure both the deployment credential and transcription model.",
  };
}

function captureDeploymentRoute(mimeType: string): {
  provider: "openai" | "google";
  model: string;
  credentialConfigured: boolean;
} {
  const supportsGoogle = CAPTURE_AUDIO_TYPES.has(mimeType);
  const openAiReady = hasOpenAIKey() && Boolean(TRANSCRIPTION_MODEL);
  const googleReady = supportsGoogle && hasGoogleMediaKey() &&
    Boolean(GOOGLE_TRANSCRIPTION_MODEL);
  if (TRANSCRIPTION_PROVIDER === "google" && supportsGoogle) {
    return {
      provider: "google",
      model: GOOGLE_TRANSCRIPTION_MODEL,
      credentialConfigured: hasGoogleMediaKey(),
    };
  }
  if (TRANSCRIPTION_PROVIDER === "openai") {
    return {
      provider: "openai",
      model: TRANSCRIPTION_MODEL,
      credentialConfigured: hasOpenAIKey(),
    };
  }
  if (googleReady && !openAiReady) {
    return {
      provider: "google",
      model: GOOGLE_TRANSCRIPTION_MODEL,
      credentialConfigured: true,
    };
  }
  if (openAiReady && !googleReady) {
    return {
      provider: "openai",
      model: TRANSCRIPTION_MODEL,
      credentialConfigured: true,
    };
  }
  return {
    provider: "openai",
    model: "",
    credentialConfigured: hasOpenAIKey() ||
      (supportsGoogle && hasGoogleMediaKey()),
  };
}

function openAiTranscriptionSupportsVerboseJson(model: string) {
  return model.trim().toLowerCase() === "whisper-1";
}

function openAiTranscriptionDurationMs(
  result: Transcription | TranscriptionVerbose,
) {
  if ("duration" in result && Number.isFinite(result.duration)) {
    return Math.max(1, Math.round(result.duration * 1_000));
  }
  const usage = result.usage;
  if (usage?.type === "duration" && Number.isFinite(usage.seconds)) {
    return Math.max(1, Math.round(usage.seconds * 1_000));
  }
  // GPT transcription models intentionally return the compact JSON contract,
  // which does not promise media duration or timestamps. The text remains
  // canonical; callers receive one bounded segment instead of invented timing.
  return 1;
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
