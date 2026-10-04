import { z } from "zod";
import { createAppServiceCaller, createRequestMutationAppServiceCaller } from "@/lib/app-services/contracts";
import { processMeetingRecordingService } from "@/lib/app-services/meeting-recordings";
import { meetingRecordingProcessRequestSchema } from "@/lib/capture/meeting-recording-native-contracts";
import { showMeetingService } from "@/lib/app-services/meetings";
import { captureExecutionScopeFromSecurityContext } from "@/lib/capture/execution-scope";
import {
  captureMediaProcessingRequestSchema,
  captureRawAudioRetentionSchema,
  captureSpeakerMappingSchema,
} from "@/lib/capture/media-contracts";
import { enqueueCaptureMediaProcessingJob } from "@/lib/capture/media-jobs";
import {
  getCaptureMediaHead,
  queueCaptureMediaProcessing,
} from "@/lib/capture/media-store";
import {
  CaptureRecordingError,
  prepareCaptureRecordingMediaProcessing,
} from "@/lib/capture/recordings";
import { withDatabaseRequestScope } from "@/lib/db/client";
import { jsonBodyErrorResponse, parseJsonBody } from "@/lib/http/body";
import { requiredRequestIdempotencyKey } from "@/lib/http/idempotency-key";
import { serverErrorResponse } from "@/lib/http/errors";
import { projectOperationJobStatus } from "@/lib/operations/job-queue";
import { authorizeRequest, forbiddenResponse } from "@/lib/security/guard";
import type { SecurityContext } from "@/lib/security/types";
import { nativeRecordingFailure, privateRecordingResponse } from "../../native-processing-http";

export const runtime = "nodejs";
export const POST = withDatabaseRequestScope(POSTHandler);

const privateNoStoreHeaders = { "cache-control": "private, no-store" };
const completeRecordingSchema = z.object({
  meetingId: z.string().regex(/^meeting:[0-9a-f-]{36}$/).optional(),
  workspaceId: z.string().trim().min(1).max(240).optional(),
  languageHints: z.array(
    z.string().trim().min(2).max(35).regex(
      /^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8})*$/,
    ),
  ).max(12).default([]),
  speakerMappings: z.array(captureSpeakerMappingSchema).max(40).default([]),
  rawAudioRetention: captureRawAudioRetentionSchema.default({ mode: "retain" }),
}).strict();

async function POSTHandler(
  request: Request,
  route: { params: Promise<{ id: string }> },
) {
  const { id } = await route.params;
  let context;
  try {
    context = await authorizeRequest({
      request,
      action: "write.memory",
      nativeMutationCapability: "meetings.recordings.process",
      resourceType: "capture_recording",
      resourceId: id,
      metadata: { operation: "process_media" },
    });
  } catch (error) {
    return privateRecordingResponse(forbiddenResponse(error));
  }
  const byteBoundCopy = request.clone();
  let body: unknown;
  try {
    body = await parseJsonBody(request, 100_000);
  } catch (error) {
    return privateRecordingResponse(jsonBodyErrorResponse(error));
  }
  if (body && typeof body === "object" && "contract" in body) {
    try {
      if ([...new URL(request.url).searchParams].length) return Response.json({ error: "Native recording processing does not accept query parameters." }, { status: 400, headers: privateNoStoreHeaders });
      if ((await byteBoundCopy.arrayBuffer()).byteLength > 32_768) return Response.json({ error: "Native recording processing request is too large." }, { status: 413, headers: privateNoStoreHeaders });
      requiredRequestIdempotencyKey(request);
      const native = meetingRecordingProcessRequestSchema.parse(body);
      const result = await processMeetingRecordingService(createRequestMutationAppServiceCaller(request, context, {
        purpose: "api.meeting-recording.process", workspaceId: native.workspaceId, causationId: id,
      }), id, native);
      return Response.json({ ...result.data, serviceReceipt: result.receipt }, { status: result.data.replayed ? 200 : 202, headers: privateNoStoreHeaders });
    } catch (error) { return nativeRecordingFailure(error); }
  }
  if (context.source === "mobile") return Response.json({ error: "Native recording processing requires the reviewed processing contract.", code: "meeting_recording_contract_required" }, { status: 400, headers: privateNoStoreHeaders });
  const parsed = completeRecordingSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid media processing request.", details: parsed.error.flatten() },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }
  const executionScope = captureExecutionScopeFromSecurityContext(
    context,
    request,
    "capture.recording.media.queue",
  );
  try {
    await requireMeetingRecordingAuthority(
      context,
      id,
      parsed.data.meetingId,
      parsed.data.workspaceId,
      parsed.data.speakerMappings,
    );
    const recording = await prepareCaptureRecordingMediaProcessing(id, {
      ...context,
      executionScope,
    });
    const processing = captureMediaProcessingRequestSchema.parse({
      schemaVersion: 1,
      recordingId: recording.id,
      meetingId: parsed.data.meetingId,
      languageHints: parsed.data.languageHints.length
        ? parsed.data.languageHints
        : [recording.language],
      speakerMappings: parsed.data.speakerMappings,
      rawAudioRetention: parsed.data.rawAudioRetention,
    });
    const existing = await getCaptureMediaHead(recording.id, {
      tenantId: context.tenantId,
      actorId: context.actorId,
    });
    const job = await enqueueCaptureMediaProcessingJob({
      tenantId: context.tenantId,
      actorId: context.actorId,
      recording,
      request: processing,
      executionScope,
    });
    if (
      job.status === "completed" &&
      existing?.processingStatus === "ready" &&
      existing.operationJobId === job.id
    ) {
      return Response.json({
        recording,
        media: existing,
        job: projectOperationJobStatus(job),
      }, { headers: privateNoStoreHeaders });
    }
    const media = await queueCaptureMediaProcessing({
      tenantId: context.tenantId,
      actorId: context.actorId,
      executionScope,
      request: processing,
      operationJobId: job.id,
    });
    return Response.json({
      recording,
      media,
      job: projectOperationJobStatus(job),
    }, {
      status: 202,
      headers: {
        location: `/api/operations/jobs/${job.id}`,
        "retry-after": "2",
        ...privateNoStoreHeaders,
      },
    });
  } catch (error) {
    if (error instanceof CaptureRecordingError) {
      return Response.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: privateNoStoreHeaders },
      );
    }
    if (error instanceof MeetingMediaAuthorityError) {
      return Response.json(
        { error: error.message, code: "meeting_media_authority" },
        { status: 409, headers: privateNoStoreHeaders },
      );
    }
    return serverErrorResponse(error, {
      message: "Recording processing could not be queued.",
      request,
      headers: privateNoStoreHeaders,
    });
  }
}

class MeetingMediaAuthorityError extends Error {}

async function requireMeetingRecordingAuthority(
  context: SecurityContext,
  recordingId: string,
  meetingId: string | undefined,
  workspaceId: string | undefined,
  speakerMappings: z.infer<typeof captureSpeakerMappingSchema>[],
) {
  if (!meetingId) {
    if (speakerMappings.length) {
      throw new MeetingMediaAuthorityError(
        "Confirmed speaker mappings require a source-governed meeting.",
      );
    }
    return;
  }
  const result = await showMeetingService(createAppServiceCaller({ context }), {
    meetingId,
    workspaceId,
  });
  const meeting = result.data.meeting;
  if (!meeting) {
    throw new MeetingMediaAuthorityError("The selected meeting is unavailable.");
  }
  if (!meeting.sourceLinks.some((link) =>
    link.kind === "capture_recording" && link.sourceId === recordingId
  )) {
    throw new MeetingMediaAuthorityError(
      "The recording must be linked to the selected meeting before processing.",
    );
  }
  if (
    !meeting.participants.length ||
    meeting.participants.some((participant) =>
      !["granted", "not_required"].includes(participant.recordingConsent)
    )
  ) {
    throw new MeetingMediaAuthorityError(
      "Every meeting participant must explicitly permit recording.",
    );
  }
  const participants = new Map(
    meeting.participants.map((participant) => [participant.participantId, participant]),
  );
  for (const mapping of speakerMappings) {
    const participant = participants.get(mapping.participantId);
    if (!participant || participant.displayName !== mapping.displayName) {
      throw new MeetingMediaAuthorityError(
        "Confirmed speaker mappings must match a current meeting participant.",
      );
    }
  }
}
