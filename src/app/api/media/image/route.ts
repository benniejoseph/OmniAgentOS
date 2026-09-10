import { z } from "zod";

import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { describeGeminiImageFailure, GeminiImageGenerationError } from "@/lib/google/ai";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createImageMediaAsset } from "@/lib/media/operations";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { describeOpenAIImageFailure, OpenAIImageGenerationError } from "@/lib/openai/image";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 120;
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  prompt: z.string().trim().min(3).max(4_000),
  aspectRatio: z.enum(["1:1", "16:9", "9:16", "4:3", "3:4"]).optional(),
  operation: z.enum(["generate", "edit"]).default("generate"),
  sourceAssetIds: z.array(z.string().trim().min(1).max(240)).max(4).default([]),
}).strict().superRefine((value, context) => {
  if (value.operation === "edit" && !value.sourceAssetIds.length) context.addIssue({ code: "custom", path: ["sourceAssetIds"], message: "Image editing requires at least one source image." });
  if (value.operation === "generate" && value.sourceAssetIds.length) context.addIssue({ code: "custom", path: ["sourceAssetIds"], message: "Source images are accepted only for editing." });
});

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "media", metadata: { operation: "image" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Add a valid image request." }, { status: 400 });
  const telemetry = createRequestTelemetry(request, "media-image");
  const executionScope = captureExecutionScopeFromSecurityContext(context, request, "media.image.capture_asset.store", { correlationId: telemetry.correlationId });
  const startedAt = Date.now();
  try {
    const result = await createImageMediaAsset({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      sourceStreamId: "api:media:image",
      abortSignal: request.signal,
      ...parsed.data,
    });
    await recordMediaEvent({ context, telemetry, result, startedAt, statusCode: 200 });
    return Response.json({
      image: result.contentUrl,
      imageUrl: result.contentUrl,
      operation: result.operation,
      provider: result.provider,
      model: result.model,
      responseId: result.responseId,
      latencyMs: result.latencyMs,
      requestId: telemetry.correlationId,
      sourceAssetIds: result.sourceAssetIds,
      asset: publicAsset(result.asset, result.contentUrl),
    }, { headers: privateHeaders() });
  } catch (error) {
    const failure = imageFailure(error, request.signal.aborted);
    await recordRuntimeEventSafely({
      level: failure.category === "cancelled" ? "info" : failure.category === "quota" || failure.category === "safety" ? "warn" : "error",
      category: "api",
      action: `media.image.${parsed.data.operation}`,
      route: "/api/media/image",
      method: "POST",
      statusCode: failure.httpStatus,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "media",
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      message: `Image ${parsed.data.operation} failed.`,
      metadata: { ...telemetry.syntheticMetadata, outcome: "failed", failureCategory: failure.category, failureCode: failure.code },
    });
    return Response.json({ error: failure.publicMessage, failure: { ...failure, requestId: telemetry.correlationId } }, {
      status: failure.httpStatus,
      headers: { ...privateHeaders(), ...(failure.retryAfterSeconds !== undefined ? { "retry-after": String(failure.retryAfterSeconds) } : {}) },
    });
  }
}

async function recordMediaEvent(input: {
  context: { tenantId: string; actorId: string };
  telemetry: ReturnType<typeof createRequestTelemetry>;
  result: Awaited<ReturnType<typeof createImageMediaAsset>>;
  startedAt: number;
  statusCode: number;
}) {
  await recordRuntimeEventSafely({
    category: "api",
    action: `media.image.${input.result.operation}`,
    route: "/api/media/image",
    method: "POST",
    statusCode: input.statusCode,
    tenantId: input.context.tenantId,
    actorId: input.context.actorId,
    resourceType: "capture_asset",
    resourceId: input.result.asset.id,
    durationMs: Date.now() - input.startedAt,
    requestId: input.telemetry.requestId,
    correlationId: input.telemetry.correlationId,
    message: `Image ${input.result.operation} completed.`,
    metadata: { ...input.telemetry.syntheticMetadata, outcome: "completed", provider: input.result.provider, model: input.result.model, sourceAssetIds: input.result.sourceAssetIds, byteCount: input.result.asset.byteCount },
  });
}

function imageFailure(error: unknown, aborted: boolean) {
  if (error instanceof OpenAIImageGenerationError) return describeOpenAIImageFailure(aborted ? { name: "AbortError" } : error);
  if (error instanceof GeminiImageGenerationError) return describeGeminiImageFailure(aborted ? { name: "AbortError" } : error);
  const message = error instanceof Error ? error.message : "The image request failed.";
  const configuration = message.includes("active model route");
  return {
    category: configuration ? "configuration" as const : "upstream" as const,
    code: configuration ? "image_model_route_unavailable" : "image_request_invalid",
    publicMessage: message,
    suggestion: configuration ? "Assign and validate an image model in Settings." : "Check the source image and request, then try again.",
    retryable: configuration,
    httpStatus: configuration ? 503 : 400,
  };
}

function publicAsset(asset: Awaited<ReturnType<typeof createImageMediaAsset>>["asset"], contentUrl: string) {
  return { id: asset.id, filename: asset.filename, byteCount: asset.byteCount, storageKind: asset.storageKind, contentUrl, indexUrl: `/api/capture/assets/${encodeURIComponent(asset.id)}` };
}

function privateHeaders() {
  return { "cache-control": "private, no-store" };
}
