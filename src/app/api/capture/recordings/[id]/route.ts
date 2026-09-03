import { z } from "zod";
import {
  CaptureRecordingError,
  deleteCaptureRecording,
  getCaptureRecording,
  updateCaptureRecording,
} from "@/lib/capture/recordings";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { deleteKnowledgeDocumentsBySourcePrefix } from "@/lib/rag/store";
import { cancelOperationJobByDedupeKey, getOperationJob } from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const PATCH = withDatabaseRequestScope(PATCHHandler);
export const DELETE = withDatabaseRequestScope(DELETEHandler);

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
  try {
    const recording = await getCaptureRecording(id, context);
    if (!recording) return Response.json({ error: "Recording not found." }, { status: 404 });
    return Response.json({ recording }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return captureErrorResponse(error);
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
    const forgotten = await deleteKnowledgeDocumentsBySourcePrefix(recording.source, { tenantId: context.tenantId });
    await deleteCaptureRecording(id, { ...context, executionScope });
    return Response.json({ deleted: true, forgotten }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return captureErrorResponse(error);
  }
}

function captureErrorResponse(error: unknown) {
  if (error instanceof CaptureRecordingError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return Response.json({ error: error instanceof Error ? error.message : "Capture recording request failed." }, { status: 500 });
}
