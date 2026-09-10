import "server-only";

import { getCaptureAssetContent, saveCaptureAsset } from "@/lib/capture/assets";
import { GEMINI_IMAGE_MODEL, GEMINI_VIDEO_MODEL, hasGeminiKey } from "@/lib/config";
import {
  generateGeminiImage,
  generateGeminiVideo,
  GeminiImageGenerationError,
  GeminiVideoGenerationError,
} from "@/lib/google/ai";
import { clipVideoBytes } from "@/lib/media/clip";
import { generateOpenAIImage, OpenAIImageGenerationError } from "@/lib/openai/image";
import type { ExecutionScope } from "@/lib/security/execution-scope";
import { resolveSpecializedRuntime } from "@/lib/settings/specialized-runtime";

type Owner = {
  tenantId: string;
  actorId: string;
  executionScope: ExecutionScope;
  sourceStreamId: string;
  abortSignal?: AbortSignal;
};

export async function createImageMediaAsset(input: Owner & {
  prompt: string;
  operation: "generate" | "edit";
  sourceAssetIds?: string[];
  aspectRatio?: "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
}) {
  const sourceAssetIds = input.sourceAssetIds || [];
  if (input.operation === "edit" && !sourceAssetIds.length) throw new Error("Image editing requires at least one source image.");
  if (input.operation === "generate" && sourceAssetIds.length) throw new Error("Source images are accepted only for editing.");
  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: input.tenantId,
    actorId: input.actorId,
    scope: "image_generation",
    requiredCapability: "image",
    deploymentProvider: "google",
    deploymentModel: GEMINI_IMAGE_MODEL,
    deploymentConfigured: hasGeminiKey(),
  });
  if (
    !runtimeModel.configured ||
    (runtimeModel.provider !== "google" && runtimeModel.provider !== "openai")
  ) {
    throw new Error("Image generation does not have an active model route.");
  }
  const sources = await openSources(input, sourceAssetIds);
  if (sources.some(({ asset }) => !asset.mediaType.startsWith("image/"))) throw new Error("Image editing accepts image assets only.");
  assertSourceBytes(sources);
  const usageScope = {
    tenantId: input.tenantId,
    actorId: input.actorId,
    sourceStreamId: input.sourceStreamId,
    operation: "image_generation" as const,
    purpose: input.operation === "edit" ? "media.image.edit" : "media.image.generate",
    correlationId: input.executionScope.correlationId,
    causationId: input.executionScope.causationId || undefined,
    executionScope: input.executionScope,
    ...runtimeModel.usageReceipt,
  };
  const result = await runtimeModel.withApiKey((apiKey) => {
    const shared = {
      prompt: input.prompt,
      aspectRatio: input.aspectRatio,
      sources: sources.map(({ asset, bytes }) => ({ bytes, mimeType: asset.mediaType, filename: asset.filename })),
      model: runtimeModel.model,
      apiKey,
      abortSignal: input.abortSignal,
      usageScope,
    };
    return runtimeModel.provider === "openai"
      ? generateOpenAIImage(shared)
      : generateGeminiImage(shared);
  });
  input.abortSignal?.throwIfAborted();
  let asset;
  try {
    asset = await saveCaptureAsset({
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionScope: input.executionScope,
      filename: `${input.operation === "edit" ? "edited" : "generated"}-image-${Date.now()}.${imageExtension(result.mimeType)}`,
      mediaType: result.mimeType,
      bytes: result.bytes,
      tags: ["ai-media", input.operation === "edit" ? "edited" : "generated"],
      metadata: lineageMetadata(input.operation, runtimeModel.provider, result, sources, {
        aspectRatio: input.aspectRatio || "1:1",
      }),
    });
  } catch {
    const failure = {
      category: "upstream" as const,
      code: `${runtimeModel.provider}_image_storage_failed`,
      publicMessage: "The image was created, but the workspace could not store it.",
      suggestion: "Try again after checking workspace storage availability.",
      retryable: true,
      httpStatus: 503,
    };
    throw runtimeModel.provider === "openai"
      ? new OpenAIImageGenerationError(failure)
      : new GeminiImageGenerationError(failure);
  }
  return {
    kind: "image" as const,
    operation: input.operation,
    provider: runtimeModel.provider,
    model: result.model,
    responseId: result.responseId,
    latencyMs: result.latencyMs,
    usage: result.usage,
    sourceAssetIds: sources.map(({ asset: source }) => source.id),
    asset,
    contentUrl: `/api/capture/assets/${encodeURIComponent(asset.id)}?content=1`,
  };
}

export async function createVideoMediaAsset(input: Owner & {
  prompt: string;
  operation: "generate" | "edit";
  sourceAssetIds?: string[];
  aspectRatio?: "16:9" | "9:16";
  resolution?: "360p" | "720p";
}) {
  const sourceAssetIds = input.sourceAssetIds || [];
  if (input.operation === "edit" && sourceAssetIds.length !== 1) throw new Error("Video editing requires exactly one source video.");
  const runtimeModel = await resolveSpecializedRuntime({
    tenantId: input.tenantId,
    actorId: input.actorId,
    scope: "video_generation",
    requiredCapability: "video",
    deploymentProvider: "google",
    deploymentModel: GEMINI_VIDEO_MODEL,
    deploymentConfigured: hasGeminiKey(),
  });
  if (!runtimeModel.configured || runtimeModel.provider !== "google") throw new Error("Video generation does not have an active Google model route.");
  const sources = await openSources(input, sourceAssetIds);
  const invalid = input.operation === "edit"
    ? sources.some(({ asset }) => !asset.mediaType.startsWith("video/"))
    : sources.some(({ asset }) => !asset.mediaType.startsWith("image/"));
  if (invalid) throw new Error(input.operation === "edit" ? "Video editing requires one video source." : "Reference-driven video generation accepts image sources only.");
  assertSourceBytes(sources);
  const result = await runtimeModel.withApiKey((apiKey) =>
    generateGeminiVideo({
      prompt: input.prompt,
      model: runtimeModel.model,
      aspectRatio: input.aspectRatio,
      resolution: input.resolution,
      sources: sources.map(({ asset, bytes }) => ({ bytes, mimeType: asset.mediaType })),
      apiKey,
      abortSignal: input.abortSignal,
      usageScope: {
        tenantId: input.tenantId,
        actorId: input.actorId,
        sourceStreamId: input.sourceStreamId,
        operation: "video_generation",
        purpose: input.operation === "edit" ? "media.video.edit" : "media.video.generate",
        correlationId: input.executionScope.correlationId,
        causationId: input.executionScope.causationId || undefined,
        executionScope: input.executionScope,
        ...runtimeModel.usageReceipt,
      },
    })
  );
  input.abortSignal?.throwIfAborted();
  let asset;
  try {
    asset = await saveCaptureAsset({
      tenantId: input.tenantId,
      actorId: input.actorId,
      executionScope: input.executionScope,
      filename: `${input.operation === "edit" ? "edited" : "generated"}-video-${Date.now()}.${result.mimeType === "video/webm" ? "webm" : "mp4"}`,
      mediaType: result.mimeType,
      bytes: result.bytes,
      tags: ["ai-media", "video", input.operation === "edit" ? "edited" : "generated"],
      metadata: lineageMetadata(input.operation, "google", result, sources, {
        aspectRatio: input.aspectRatio || "16:9",
        resolution: input.resolution || "360p",
      }),
    });
  } catch {
    throw new GeminiVideoGenerationError({
      category: "upstream",
      code: "gemini_video_storage_failed",
      publicMessage: "The video was created, but the workspace could not store it.",
      suggestion: "Try 360p or a shorter request so the result fits the private asset limit.",
      retryable: true,
      httpStatus: 503,
    });
  }
  return {
    kind: "video" as const,
    operation: input.operation,
    provider: "google" as const,
    model: result.model,
    responseId: result.responseId,
    latencyMs: result.latencyMs,
    usage: result.usage,
    sourceAssetIds: sources.map(({ asset: source }) => source.id),
    asset,
    contentUrl: `/api/capture/assets/${encodeURIComponent(asset.id)}?content=1`,
  };
}

export async function clipVideoMediaAsset(input: Owner & {
  sourceAssetId: string;
  startSeconds: number;
  endSeconds: number;
}) {
  const source = await getCaptureAssetContent(input.sourceAssetId, input);
  const clip = await clipVideoBytes({
    bytes: source.bytes,
    mediaType: source.asset.mediaType,
    startSeconds: input.startSeconds,
    endSeconds: input.endSeconds,
    abortSignal: input.abortSignal,
  });
  const asset = await saveCaptureAsset({
    tenantId: input.tenantId,
    actorId: input.actorId,
    executionScope: input.executionScope,
    filename: `clip-${Date.now()}.${clip.extension}`,
    mediaType: clip.mediaType,
    bytes: clip.bytes,
    tags: ["media", "video", "clip"],
    metadata: {
      origin: "media_studio",
      operation: "clip",
      deterministic: true,
      sourceAssetIds: [source.asset.id],
      sourceContentSha256s: [source.asset.contentSha256],
      startSeconds: input.startSeconds,
      endSeconds: input.endSeconds,
    },
  });
  return {
    kind: "video" as const,
    operation: "clip" as const,
    provider: "deterministic" as const,
    model: "ffmpeg",
    sourceAssetIds: [source.asset.id],
    asset,
    contentUrl: `/api/capture/assets/${encodeURIComponent(asset.id)}?content=1`,
  };
}

async function openSources(input: Owner, ids: string[]) {
  return Promise.all(ids.map((id) => getCaptureAssetContent(id, {
    tenantId: input.tenantId,
    actorId: input.actorId,
  })));
}

function assertSourceBytes(sources: Array<{ bytes: Uint8Array }>) {
  const total = sources.reduce((sum, source) => sum + source.bytes.byteLength, 0);
  if (total > 16 * 1024 * 1024) throw new Error("Source media must total 16 MB or less.");
}

function lineageMetadata(
  operation: "generate" | "edit",
  provider: string,
  result: { model: string; responseId?: string },
  sources: Awaited<ReturnType<typeof openSources>>,
  detail: Record<string, unknown>,
) {
  return {
    origin: "media_studio",
    operation,
    provider,
    model: result.model,
    responseId: result.responseId,
    sourceAssetIds: sources.map(({ asset }) => asset.id),
    sourceContentSha256s: sources.map(({ asset }) => asset.contentSha256),
    ...detail,
  };
}

function imageExtension(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}
