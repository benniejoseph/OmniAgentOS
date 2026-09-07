import {
  CAPTURE_AUDIO_TYPES,
} from "@/lib/capture/transcription";
import {
  CaptureRecordingError,
  getCaptureRecording,
  getCaptureSegmentAudio,
  MAX_CAPTURE_SEGMENT_BYTES,
  saveCaptureSegment,
} from "@/lib/capture/recordings";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import { enqueueCaptureSegmentTranscriptionJob } from "@/lib/capture/media-jobs";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";

export const runtime = "nodejs";
export const GET = withDatabaseRequestScope(GETHandler);
export const POST = withDatabaseRequestScope(POSTHandler);

async function GETHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({ request, action: "read", resourceType: "capture_recording", resourceId: id });
  } catch (error) {
    return forbiddenResponse(error);
  }
  try {
    const url = new URL(request.url);
    const requestedIndex = url.searchParams.get("audio");
    if (requestedIndex !== null) {
      const segmentIndex = Number(requestedIndex);
      if (!Number.isInteger(segmentIndex) || segmentIndex < 0) return Response.json({ error: "Choose a valid segment index." }, { status: 400 });
      const audio = await getCaptureSegmentAudio(id, segmentIndex, context);
      return new Response(audio.bytes, {
        headers: {
          "content-type": audio.mimeType,
          "content-length": String(audio.byteCount),
          "etag": `"${audio.sha256}"`,
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename="recording-${id}-segment-${segmentIndex}"`,
        },
      });
    }
    const recording = await getCaptureRecording(id, context);
    if (!recording) return Response.json({ error: "Recording not found." }, { status: 404 });
    return Response.json({ segments: recording.segments }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return captureErrorResponse(error);
  }
}

async function POSTHandler(request: Request, route: { params: Promise<{ id: string }> }) {
  const { id } = await route.params;
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.toLowerCase().startsWith("multipart/form-data")) return Response.json({ error: "Audio segments require multipart form data." }, { status: 415 });
  const declaredBytes = Number(request.headers.get("content-length") || 0);
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_CAPTURE_SEGMENT_BYTES + 512_000) return Response.json({ error: "Each recording segment must be 3 MB or smaller." }, { status: 413 });

  let context;
  try {
    context = await authorizeRequest({ request, action: "write.memory", resourceType: "capture_recording", resourceId: id, metadata: { operation: "append_segment", declaredBytes } });
  } catch (error) {
    return forbiddenResponse(error);
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.recording.segment.append_and_queue",
  );
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: "The audio segment could not be read." }, { status: 400 });
  }
  const audio = form.get("audio");
  if (!(audio instanceof File) || !audio.size) return Response.json({ error: "No audio segment was provided." }, { status: 400 });
  if (audio.size > MAX_CAPTURE_SEGMENT_BYTES) return Response.json({ error: "Each recording segment must be 3 MB or smaller." }, { status: 413 });
  const mimeType = audio.type.split(";", 1)[0].toLowerCase();
  if (!CAPTURE_AUDIO_TYPES.has(mimeType)) return Response.json({ error: "Unsupported audio format." }, { status: 415 });
  const rawSegmentIndex = form.get("segmentIndex");
  if (typeof rawSegmentIndex !== "string" || !rawSegmentIndex.trim()) return Response.json({ error: "A segment index is required." }, { status: 400 });
  const segmentIndex = Number(rawSegmentIndex);
  const durationMs = Number(form.get("durationMs") || 0);
  try {
    const saved = await saveCaptureSegment({
      ...context,
      executionScope,
      recordingId: id,
      segmentIndex,
      durationMs,
      mimeType,
      audio: new Uint8Array(await audio.arrayBuffer()),
      metadata: { originalName: audio.name.slice(0, 240) },
    });
    if (!saved.created && saved.segment.mediaTranscript) {
      return Response.json({ segment: saved.segment, duplicate: true }, { headers: { "cache-control": "private, no-store" } });
    }
    try {
      const recording = await getCaptureRecording(id, context);
      if (!recording) {
        throw new CaptureRecordingError(
          "Recording not found.",
          404,
          "recording_not_found",
        );
      }
      const job = await enqueueCaptureSegmentTranscriptionJob({
        tenantId: context.tenantId,
        actorId: context.actorId,
        recordingId: id,
        segment: saved.segment,
        languageHints: recording.language ? [recording.language] : [],
        executionScope,
      });
      return Response.json({
        segment: saved.segment,
        job: projectOperationJobStatus(job),
        duplicate: !saved.created,
      }, {
        status: 202,
        headers: {
          location: `/api/operations/jobs/${job.id}`,
          "retry-after": "2",
          "cache-control": "private, no-store",
        },
      });
    } catch (error) {
      return Response.json({
        segment: saved.segment,
        stored: true,
        error: error instanceof Error
          ? error.message
          : "The stored segment could not be queued for processing.",
        retryable: true,
      }, { status: 503, headers: { "cache-control": "private, no-store" } });
    }
  } catch (error) {
    return captureErrorResponse(error);
  }
}

function captureErrorResponse(error: unknown) {
  if (error instanceof CaptureRecordingError) return Response.json({ error: error.message, code: error.code }, { status: error.status });
  return Response.json({ error: error instanceof Error ? error.message : "Recording segment request failed." }, { status: 500 });
}
