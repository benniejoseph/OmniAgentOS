import { z } from "zod";
import { saveCaptureAsset } from "@/lib/capture/assets";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { GEMINI_IMAGE_MODEL } from "@/lib/config";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  describeGeminiImageFailure,
  generateGeminiImage,
  GeminiImageGenerationError,
  type GeminiImageFailureCategory,
} from "@/lib/google/ai";
import { parseJsonBody, jsonBodyErrorResponse } from "@/lib/http/body";
import {
  createRequestTelemetry,
  recordRuntimeEventSafely,
} from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 120;
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  prompt: z.string().trim().min(3).max(4_000),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
}).strict();

async function POSTHandler(request: Request) {
  let context;
  try { context = await authorizeRequest({ request, action: "run.agent", resourceType: "media", metadata: { operation: "generate_image" } }); }
  catch (error) { return forbiddenResponse(error); }
  const telemetry = createRequestTelemetry(request, "gemini-image");
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "media.image.capture_asset.store",
    { correlationId: telemetry.correlationId },
  );
  let body: unknown;
  try { body = await parseJsonBody(request); } catch (error) { return jsonBodyErrorResponse(error); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Add a valid image prompt and aspect ratio." }, { status: 400 });
  const startedAt = Date.now();
  try {
    const result = await generateGeminiImage({
      ...parsed.data,
      abortSignal: request.signal,
      usageScope: {
        tenantId: context.tenantId,
        actorId: context.actorId,
        sourceStreamId: "api:media:image",
        operation: "image_generation",
        purpose: "media.image.generate",
        correlationId: executionScope.correlationId,
        executionScope,
        credentialSource: "deployment_environment",
      },
    });
    request.signal.throwIfAborted();
    let asset;
    try {
      asset = await saveCaptureAsset({
        tenantId: context.tenantId,
        actorId: context.actorId,
        executionScope,
        filename: `gemini-visual-${Date.now()}.${imageExtension(result.mimeType)}`,
        mediaType: result.mimeType,
        bytes: result.bytes,
        tags: ["gemini-generated"],
        metadata: {
          origin: "gemini_visual_studio",
          model: result.model,
          responseId: result.responseId,
          aspectRatio: parsed.data.aspectRatio || "1:1",
        },
      });
    } catch {
      throw new GeminiImageGenerationError({
        category: "upstream",
        code: "gemini_image_storage_failed",
        publicMessage: "Gemini created the image, but the workspace could not store it.",
        suggestion: "Try again after checking workspace storage availability.",
        retryable: true,
        httpStatus: 503,
      });
    }
    const imageUrl = `/api/capture/assets/${encodeURIComponent(asset.id)}?content=1`;
    await recordRuntimeEventSafely({
      category: "api",
      action: "gemini.image",
      route: "/api/media/image",
      method: "POST",
      statusCode: 200,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "capture_asset",
      resourceId: asset.id,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      message: "Gemini image generation completed.",
      metadata: {
        ...telemetry.syntheticMetadata,
        outcome: "completed",
        provider: "google",
        model: result.model,
        usage: result.usage,
        responseId: result.responseId,
        aspectRatio: parsed.data.aspectRatio || "1:1",
        byteCount: asset.byteCount,
        storageKind: asset.storageKind,
      },
    });
    return Response.json({
      image: imageUrl,
      imageUrl,
      asset: {
        id: asset.id,
        filename: asset.filename,
        byteCount: asset.byteCount,
        storageKind: asset.storageKind,
        contentUrl: imageUrl,
        indexUrl: `/api/capture/assets/${encodeURIComponent(asset.id)}`,
      },
      mimeType: result.mimeType,
      model: result.model,
      responseId: result.responseId,
      latencyMs: result.latencyMs,
      requestId: telemetry.correlationId,
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const failure = request.signal.aborted
      ? describeGeminiImageFailure({ name: "AbortError" })
      : describeGeminiImageFailure(error);
    await recordRuntimeEventSafely({
      level: failureLevel(failure.category),
      category: "api",
      action: "gemini.image",
      route: "/api/media/image",
      method: "POST",
      statusCode: failure.httpStatus,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "media",
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      message: "Gemini image generation failed.",
      metadata: {
        ...telemetry.syntheticMetadata,
        outcome: "failed",
        provider: "google",
        model: GEMINI_IMAGE_MODEL,
        aspectRatio: parsed.data.aspectRatio || "1:1",
        failureCategory: failure.category,
        failureCode: failure.code,
        retryable: failure.retryable,
        providerStatus: failure.providerStatus,
      },
    });
    const headers: Record<string, string> = { "cache-control": "private, no-store" };
    if (failure.retryAfterSeconds !== undefined) {
      headers["retry-after"] = String(failure.retryAfterSeconds);
    }
    return Response.json({
      error: failure.publicMessage,
      failure: {
        category: failure.category,
        code: failure.code,
        provider: "google",
        model: GEMINI_IMAGE_MODEL,
        retryable: failure.retryable,
        suggestion: failure.suggestion,
        providerStatus: failure.providerStatus,
        retryAfterSeconds: failure.retryAfterSeconds,
        requestId: telemetry.correlationId,
      },
    }, { status: failure.httpStatus, headers });
  }
}

function imageExtension(mimeType: string) {
  if (mimeType === "image/png") return "png";
  if (mimeType === "image/webp") return "webp";
  return "jpg";
}

function failureLevel(category: GeminiImageFailureCategory) {
  if (category === "cancelled") return "info" as const;
  if (category === "quota" || category === "safety") return "warn" as const;
  return "error" as const;
}
