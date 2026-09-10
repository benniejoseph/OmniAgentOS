import { z } from "zod";

import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  describeGeminiVideoFailure,
  GeminiVideoGenerationError,
} from "@/lib/google/ai";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { createVideoMediaAsset } from "@/lib/media/operations";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 120;
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  prompt: z.string().trim().min(3).max(4_000),
  operation: z.enum(["generate", "edit"]).default("generate"),
  sourceAssetIds: z.array(z.string().trim().min(1).max(240)).max(2).default([]),
  aspectRatio: z.enum(["16:9", "9:16"]).default("16:9"),
  resolution: z.enum(["360p", "720p"]).default("360p"),
}).strict().superRefine((value, context) => {
  if (value.operation === "edit" && value.sourceAssetIds.length !== 1) context.addIssue({ code: "custom", path: ["sourceAssetIds"], message: "Video editing requires exactly one source video." });
});

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "media", metadata: { operation: "video" } });
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
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Add a valid video request." }, { status: 400 });
  const telemetry = createRequestTelemetry(request, "media-video");
  const executionScope = captureExecutionScopeFromSecurityContext(context, request, "media.video.capture_asset.store", { correlationId: telemetry.correlationId });
  const startedAt = Date.now();
  try {
    const result = await createVideoMediaAsset({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      sourceStreamId: "api:media:video",
      abortSignal: request.signal,
      ...parsed.data,
    });
    await recordRuntimeEventSafely({
      category: "api",
      action: `media.video.${result.operation}`,
      route: "/api/media/video",
      method: "POST",
      statusCode: 200,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "capture_asset",
      resourceId: result.asset.id,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      message: `Video ${result.operation} completed.`,
      metadata: { ...telemetry.syntheticMetadata, outcome: "completed", provider: result.provider, model: result.model, sourceAssetIds: result.sourceAssetIds, byteCount: result.asset.byteCount },
    });
    return Response.json({
      video: result.contentUrl,
      videoUrl: result.contentUrl,
      operation: result.operation,
      provider: result.provider,
      model: result.model,
      responseId: result.responseId,
      latencyMs: result.latencyMs,
      requestId: telemetry.correlationId,
      sourceAssetIds: result.sourceAssetIds,
      asset: { id: result.asset.id, filename: result.asset.filename, byteCount: result.asset.byteCount, storageKind: result.asset.storageKind, contentUrl: result.contentUrl, indexUrl: `/api/capture/assets/${encodeURIComponent(result.asset.id)}` },
    }, { headers: privateHeaders() });
  } catch (error) {
    const failure = request.signal.aborted || error instanceof GeminiVideoGenerationError
      ? describeGeminiVideoFailure(request.signal.aborted ? { name: "AbortError" } : error)
      : plainFailure(error instanceof Error ? error : new Error("The video request failed."));
    await recordRuntimeEventSafely({
      level: failure.category === "cancelled" ? "info" : failure.category === "quota" || failure.category === "safety" ? "warn" : "error",
      category: "api",
      action: `media.video.${parsed.data.operation}`,
      route: "/api/media/video",
      method: "POST",
      statusCode: failure.httpStatus,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "media",
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      message: `Video ${parsed.data.operation} failed.`,
      metadata: { ...telemetry.syntheticMetadata, outcome: "failed", failureCategory: failure.category, failureCode: failure.code },
    });
    return Response.json({ error: failure.publicMessage, failure: { ...failure, provider: "google", requestId: telemetry.correlationId } }, {
      status: failure.httpStatus,
      headers: { ...privateHeaders(), ...(failure.retryAfterSeconds !== undefined ? { "retry-after": String(failure.retryAfterSeconds) } : {}) },
    });
  }
}

function plainFailure(error: Error) {
  const configuration = error.message.includes("active Google model route");
  return {
    category: configuration ? "configuration" as const : "upstream" as const,
    code: configuration ? "video_model_route_unavailable" : "video_request_invalid",
    publicMessage: error.message,
    suggestion: configuration ? "Assign and validate a Google video model in Settings." : "Check the source media and request, then try again.",
    retryable: configuration,
    httpStatus: configuration ? 503 : 400,
    retryAfterSeconds: undefined,
  };
}

function privateHeaders() {
  return { "cache-control": "private, no-store" };
}
