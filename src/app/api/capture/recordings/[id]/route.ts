import { z } from "zod";
import {
  CaptureRecordingError,
  CaptureRecordingReadConflictError,
  getCaptureRecording,
  getCaptureRecordingMetadataForRequest,
  updateCaptureRecording,
} from "@/lib/capture/recordings";
import { deleteCaptureRecordingWithKnowledge } from "@/lib/capture/deletion";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { cancelOperationJobByDedupeKey, getOperationJob } from "@/lib/operations/job-queue";
import { canonicalRequestActorBindingFromSecurityContext } from "@/lib/security/canonical-actor";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);
const privateNoStoreHeaders = { "cache-control": "private, no-store" };

const updateRecordingSchema = z.object({
  title: z.string().trim().min(1).max(240).optional(),
  language: z.string().trim().max(35).optional(),
  tags: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
}).strict().refine((body) => Object.keys(body).length > 0, "Add at least one change.");

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "capture_recording", resourceId: id });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const readableOwnerScope =
    new URL(request.url).searchParams.get("ownerScope") === "readable";
  try {
    const recording = readableOwnerScope
      ? await getCaptureRecordingMetadataForRequest(id, {
          tenantId: context.tenantId,
          actorId: context.actorId,
          requestActorBinding:
            canonicalRequestActorBindingFromSecurityContext(context),
        })
      : await getCaptureRecording(id, context);
    if (!recording) {
      return Response.json(
        { error: "Recording not found." },
        {
          status: 404,
          ...(readableOwnerScope ? { headers: privateNoStoreHeaders } : {}),
        },
      );
    }
    return Response.json({
      recording,
      requestReadContracts: {
        captureRecordingDetail: readableOwnerScope
          ? "readable_v1"
          : "exact_v1",
      },
    }, { headers: privateNoStoreHeaders });
  } catch (error) {
    return readableOwnerScope
      ? captureRecordingMetadataReadErrorResponse(error)
      : captureErrorResponse(error);
  }
}

async function PATCHHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "write.memory", resourceType: "capture_recording", resourceId: id, metadata: { operation: "update" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.recording.update",
  );
  let body: unknown;
  try {
    body = await parseJsonBody(request);
  } catch (error) {
    return jsonBodyErrorResponse(error);
  }
  const parsed = updateRecordingSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid recording details.", details: parsed.error.flatten() }, { status: 400 });
  try {
    return Response.json({
      recording: await updateCaptureRecording(
        id,
        { ...context, executionScope },
        parsed.data,
      ),
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return captureErrorResponse(error);
  }
}

async function DELETEHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "write.memory", resourceType: "capture_recording", resourceId: id, riskLevel: 3, metadata: { operation: "delete" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.recording.delete",
  );
  try {
    const recording = await getCaptureRecording(id, context);
    if (!recording) return Response.json({ error: "Recording not found." }, { status: 404 });
    if (recording.ingestJobId) {
      const job = await getOperationJob(recording.ingestJobId, { tenantId: context.tenantId });
      if (job?.dedupeKey) await cancelOperationJobByDedupeKey(job.dedupeKey, "Captured recording deleted by its owner.", { tenantId: context.tenantId });
    }
    const forgotten = await deleteCaptureRecordingWithKnowledge(recording, {
      ...context,
      executionScope,
    });
    return Response.json({ deleted: true, forgotten }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return captureErrorResponse(error);
  }
}

function captureErrorResponse(error: unknown) {
  if (error instanceof CaptureRecordingError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return Response.json({ error: error instanceof Error ? error.message : "Capture recording request failed." }, { status: 500 });
}

function captureRecordingMetadataReadErrorResponse(error: unknown) {
  if (error instanceof CaptureRecordingReadConflictError) {
    return Response.json(
      { error: "Capture recording metadata could not be resolved safely." },
      { status: 409, headers: privateNoStoreHeaders },
    );
  }
  if (error instanceof CaptureRecordingError) {
    return Response.json(
      { error: error.message, code: error.code },
      { status: error.status, headers: privateNoStoreHeaders },
    );
  }
  console.error(
    "Capture recording metadata read failed.",
    error instanceof Error ? error.name : "UnknownError",
  );
  return Response.json(
    { error: "Capture recording metadata is temporarily unavailable." },
    { status: 503, headers: privateNoStoreHeaders },
  );
}
