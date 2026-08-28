import {
  CaptureRecordingError,
  markCaptureRecordingIngestQueued,
  prepareCaptureRecordingCompletion,
} from "@/lib/capture/recordings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import {
  BackgroundJobIdempotencyConflictError,
  enqueueKnowledgeIngestJob,
} from "@/lib/operations/background-jobs";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "write.memory", resourceType: "capture_recording", resourceId: id, metadata: { operation: "complete" } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const recording = await prepareCaptureRecordingCompletion(id, context);
    if (recording.ingestJobId) {
      return Response.json({ recording, job: { id: recording.ingestJobId } }, { headers: { "cache-control": "private, no-store" } });
    }
    const job = await enqueueKnowledgeIngestJob({
      tenantId: context.tenantId,
      idempotencyKey: `capture-recording:${recording.id}`,
      request: {
        title: recording.title,
        content: recording.transcript.slice(0, 900_000),
        source: recording.source,
        sourceType: "file",
        tags: ["capture", "recording", "conversation", ...recording.tags],
        metadata: {
          captureRecordingId: recording.id,
          actorId: recording.actorId,
          durationMs: recording.durationMs,
          segmentCount: recording.segmentCount,
          failedSegmentCount: recording.segments.filter((segment) => segment.transcriptionStatus === "failed").length,
          completedAt: recording.completedAt || "",
          transcriptTruncated: recording.transcript.length > 900_000,
        },
        evidenceRefs: [`capture-recording:${recording.id}`],
      },
    });
    const updated = await markCaptureRecordingIngestQueued(recording.id, context, job.id);
    return Response.json({
      recording: updated,
      job: projectOperationJobStatus(job),
      warnings: recording.segments.filter((segment) => segment.transcriptionStatus === "failed").length
        ? [`${recording.segments.filter((segment) => segment.transcriptionStatus === "failed").length} stored audio segment(s) could not be transcribed and were not included in the RAG text.`]
        : [],
    }, {
      status: 202,
      headers: { location: `/api/operations/jobs/${job.id}`, "retry-after": "2", "cache-control": "private, no-store" },
    });
  } catch (error) {
    if (error instanceof CaptureRecordingError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
    if (error instanceof BackgroundJobIdempotencyConflictError) return Response.json({ error: error.message }, { status: 409 });
    return Response.json({ error: error instanceof Error ? error.message : "Recording could not be finalized." }, { status: 500 });
  }
}
