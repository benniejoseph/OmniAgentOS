import { z } from "zod";

import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { clipVideoMediaAsset } from "@/lib/media/operations";
import { createRequestTelemetry, recordRuntimeEventSafely } from "@/lib/observability/store";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const maxDuration = 120;
export const POST = withDatabaseRequestScope(POSTHandler);

const schema = z.object({
  sourceAssetId: z.string().trim().min(1).max(240),
  startSeconds: z.number().finite().min(0).max(86_400),
  endSeconds: z.number().finite().positive().max(86_400),
}).strict().refine((value) => value.endSeconds > value.startSeconds && value.endSeconds - value.startSeconds <= 600, {
  message: "Choose a valid clip range no longer than 10 minutes.",
  path: ["endSeconds"],
});

async function POSTHandler(request: Request) {
  let context;
  try {
    context = await authorizeRequest({ request, action: "run.agent", resourceType: "media", metadata: { operation: "clip_video" } });
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
  if (!parsed.success) return Response.json({ error: parsed.error.issues[0]?.message || "Add a valid clip request." }, { status: 400 });
  const telemetry = createRequestTelemetry(request, "media-video-clip");
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "media.video.clip.store",
    { correlationId: telemetry.correlationId },
  );
  const startedAt = Date.now();
  try {
    const result = await clipVideoMediaAsset({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      sourceStreamId: "api:media:video:clip",
      abortSignal: request.signal,
      ...parsed.data,
    });
    await recordRuntimeEventSafely({
      category: "api",
      action: "media.video.clip",
      route: "/api/media/video/clip",
      method: "POST",
      statusCode: 200,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "capture_asset",
      resourceId: result.asset.id,
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      message: "Deterministic video clip stored.",
      metadata: { ...telemetry.syntheticMetadata, ...parsed.data, byteCount: result.asset.byteCount },
    });
    return Response.json({
      operation: "clip",
      video: result.contentUrl,
      videoUrl: result.contentUrl,
      asset: {
        id: result.asset.id,
        filename: result.asset.filename,
        byteCount: result.asset.byteCount,
        storageKind: result.asset.storageKind,
        contentUrl: result.contentUrl,
      },
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const message = request.signal.aborted
      ? "Video clipping was cancelled."
      : error instanceof Error ? error.message : "Video clipping failed.";
    await recordRuntimeEventSafely({
      level: request.signal.aborted ? "info" : "error",
      category: "api",
      action: "media.video.clip",
      route: "/api/media/video/clip",
      method: "POST",
      statusCode: request.signal.aborted ? 499 : 422,
      tenantId: context.tenantId,
      actorId: context.actorId,
      resourceType: "media",
      durationMs: Date.now() - startedAt,
      requestId: telemetry.requestId,
      correlationId: telemetry.correlationId,
      message: "Video clip failed.",
      metadata: { ...telemetry.syntheticMetadata, sourceAssetId: parsed.data.sourceAssetId, outcome: "failed" },
    });
    return Response.json({ error: message }, { status: request.signal.aborted ? 499 : 422, headers: { "cache-control": "private, no-store" } });
  }
}
