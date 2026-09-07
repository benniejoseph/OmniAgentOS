import { z } from "zod";
import {
  captureMediaProcessingRequestSchema,
  captureSegmentMediaTranscriptSchema,
  mediaTurnId,
  sha256Json,
  type CaptureMediaOutput,
  type CaptureMediaProcessingRequest,
  type CaptureMediaTurn,
} from "@/lib/capture/media-contracts";
import { extractCaptureMediaInsights } from "@/lib/capture/media-extraction";
import {
  commitCaptureMediaOutput,
  getCaptureMediaHead,
  markCaptureMediaProcessingStatus,
  markCaptureMediaRawAudioDeleted,
} from "@/lib/capture/media-store";
import {
  getCaptureRecording,
  getCaptureSegmentAudio,
  markCaptureRecordingIngestQueued,
  purgeCaptureRecordingRawAudio,
  saveCaptureRecordingProcessedTranscript,
  updateCaptureSegmentTranscription,
} from "@/lib/capture/recordings";
import { transcribeCaptureMediaDiarized } from "@/lib/capture/transcription";
import type {
  CaptureRecordingDetail,
  CaptureSegment,
} from "@/lib/capture/types";
import {
  enqueueOperationJob,
  requeueOperationJobByDedupeKey,
  type OperationJobRecord,
} from "@/lib/operations/job-queue";
import {
  assertExecutionScopeTenant,
  deriveExecutionScope,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

const segmentJobRequestSchema = z.object({
  schemaVersion: z.literal(1),
  actorId: z.string().trim().min(1).max(320),
  recordingId: z.string().trim().min(1).max(200),
  segmentId: z.string().trim().min(1).max(200),
  segmentIndex: z.number().int().min(0).max(1_439),
  sourceAudioSha256: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().trim().min(1).max(120),
  languageHints: z.array(z.string().trim().min(2).max(35)).max(12),
}).strict();

const finalizationJobRequestSchema = z.object({
  processing: captureMediaProcessingRequestSchema,
  actorId: z.string().trim().min(1).max(320),
  sourceAudioManifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export type CaptureMediaDeferredResult = {
  __deferOperation: true;
  delaySeconds: number;
  reason: string;
  resourceId: string;
};

export function isCaptureMediaDeferredResult(
  value: Record<string, unknown> | CaptureMediaDeferredResult,
): value is CaptureMediaDeferredResult {
  return value.__deferOperation === true;
}

export type CaptureMediaKnowledgeEnqueuer = (input: {
  recording: CaptureRecordingDetail;
  output: CaptureMediaOutput;
  executionScope: ExecutionScope;
}) => Promise<{ id: string }>;

export async function enqueueCaptureSegmentTranscriptionJob(input: {
  tenantId: string;
  actorId: string;
  recordingId: string;
  segment: CaptureSegment;
  languageHints: string[];
  executionScope: ExecutionScope;
}) {
  requireExecutionOwner(input.tenantId, input.actorId, input.executionScope);
  const request = segmentJobRequestSchema.parse({
    schemaVersion: 1,
    actorId: input.actorId,
    recordingId: input.recordingId,
    segmentId: input.segment.id,
    segmentIndex: input.segment.segmentIndex,
    sourceAudioSha256: input.segment.audioSha256,
    mimeType: input.segment.mimeType,
    languageHints: input.languageHints,
  });
  const dedupeKey = segmentDedupeKey(request);
  const requestHash = sha256Json(request);
  const job = await enqueueOperationJob({
    tenantId: input.tenantId,
    type: "capture.media.segment.transcribe",
    dedupeKey,
    payload: {
      request,
      actorId: input.actorId,
      executionScope: input.executionScope,
      requestHash,
      progress: { stage: "queued", segmentIndex: input.segment.segmentIndex },
    },
    maxAttempts: 5,
    priority: 3,
    dedupeMode: "idempotent",
  });
  assertQueuedRequest(job, requestHash);
  if (job.status === "failed") {
    const [requeued] = await requeueOperationJobByDedupeKey(
      dedupeKey,
      "Retrying a durable media segment transcription.",
      { tenantId: input.tenantId },
    );
    return requeued || job;
  }
  return job;
}

export async function enqueueCaptureMediaProcessingJob(input: {
  tenantId: string;
  actorId: string;
  recording: CaptureRecordingDetail;
  request: CaptureMediaProcessingRequest;
  executionScope: ExecutionScope;
}) {
  requireExecutionOwner(input.tenantId, input.actorId, input.executionScope);
  const processing = captureMediaProcessingRequestSchema.parse(input.request);
  if (
    processing.recordingId !== input.recording.id ||
    input.recording.tenantId !== input.tenantId ||
    input.recording.actorId !== input.actorId
  ) {
    throw new Error("Media processing request does not match its recording owner.");
  }
  const sourceAudioManifestSha256 = captureRecordingAudioManifestSha256(
    input.recording,
  );
  const request = finalizationJobRequestSchema.parse({
    processing,
    actorId: input.actorId,
    sourceAudioManifestSha256,
  });
  const requestHash = sha256Json(request);
  const job = await enqueueOperationJob({
    tenantId: input.tenantId,
    type: "capture.media.recording.process",
    dedupeKey: `capture.media.recording:${input.recording.id}:${requestHash}`,
    payload: {
      request,
      actorId: input.actorId,
      executionScope: input.executionScope,
      requestHash,
      progress: { stage: "queued", completedSegments: 0, totalSegments: input.recording.segmentCount },
    },
    maxAttempts: 8,
    priority: 1,
    dedupeMode: "idempotent",
  });
  assertQueuedRequest(job, requestHash);
  return job;
}

export async function executeCaptureMediaSegmentJob(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
) {
  const request = segmentJobRequestSchema.parse(job.payload.request);
  const executionScope = backgroundExecutionScope(job, request.actorId,
    "capture.media.segment.transcribe.background");
  const recording = await getCaptureRecording(request.recordingId, {
    tenantId: job.tenantId,
    actorId: request.actorId,
  });
  if (!recording) throw new Error("Capture recording for media transcription was not found.");
  const segment = recording.segments.find((candidate) =>
    candidate.id === request.segmentId &&
    candidate.segmentIndex === request.segmentIndex
  );
  if (!segment || segment.audioSha256 !== request.sourceAudioSha256) {
    throw new Error("Capture media segment no longer matches its queued source digest.");
  }
  if (segment.mediaTranscript) {
    return {
      resourceId: segment.id,
      recordingId: recording.id,
      segmentIndex: segment.segmentIndex,
      transcriptSha256: segment.mediaTranscript.transcriptSha256,
      resumed: true,
    };
  }
  abortSignal.throwIfAborted();
  const audio = await getCaptureSegmentAudio(
    recording.id,
    segment.segmentIndex,
    { tenantId: job.tenantId, actorId: request.actorId },
  );
  if (audio.sha256 !== request.sourceAudioSha256) {
    throw new Error("Capture media bytes failed their queued digest check.");
  }
  const transcription = await transcribeCaptureMediaDiarized(
    new File([audio.bytes], segmentFileName(segment), { type: audio.mimeType }),
    request.languageHints,
    abortSignal,
    {
      tenantId: job.tenantId,
      actorId: request.actorId,
      sourceStreamId: `capture-recording:${recording.id}`,
      operation: "transcription",
      purpose: "capture.media.segment.transcribe.background",
      correlationId: executionScope.correlationId,
      causationId: executionScope.causationId || undefined,
      executionScope,
      credentialSource: "deployment_environment",
    },
  );
  const turns = transcription.segments.map((turn) => ({
    startMilliseconds: turn.startMilliseconds,
    endMilliseconds: turn.endMilliseconds,
    languageTag: turn.languageTag,
    speaker: turn.speakerLabel === "Unknown"
      ? { label: turn.speakerLabel, identity: "unknown" as const }
      : { label: turn.speakerLabel, identity: "diarized" as const },
    text: turn.text,
  }));
  const transcript = turns.map((turn) => turn.text).join("\n");
  const mediaTranscript = captureSegmentMediaTranscriptSchema.parse({
    schemaVersion: 1,
    recordingId: recording.id,
    segmentId: segment.id,
    segmentIndex: segment.segmentIndex,
    sourceAudioSha256: segment.audioSha256,
    transcriptSha256: sha256Json(transcript),
    model: transcription.model,
    languageTags: [...new Set(turns.map((turn) => turn.languageTag))]
      .sort((left, right) => left.localeCompare(right)),
    turns,
    transcribedAt: new Date().toISOString(),
  });
  const updated = await updateCaptureSegmentTranscription({
    tenantId: job.tenantId,
    actorId: request.actorId,
    executionScope,
    recordingId: recording.id,
    segmentIndex: segment.segmentIndex,
    status: "completed",
    transcript,
    model: transcription.model,
    mediaTranscript,
  });
  return {
    resourceId: updated.id,
    recordingId: recording.id,
    segmentIndex: updated.segmentIndex,
    transcriptSha256: mediaTranscript.transcriptSha256,
    turnCount: mediaTranscript.turns.length,
    fallbackUsed: transcription.fallbackUsed,
  };
}

export async function executeCaptureMediaProcessingJob(
  job: OperationJobRecord,
  abortSignal: AbortSignal,
  enqueueKnowledge: CaptureMediaKnowledgeEnqueuer,
): Promise<Record<string, unknown> | CaptureMediaDeferredResult> {
  const request = finalizationJobRequestSchema.parse(job.payload.request);
  const executionScope = backgroundExecutionScope(job, request.actorId,
    "capture.media.recording.process.background");
  const recording = await getCaptureRecording(request.processing.recordingId, {
    tenantId: job.tenantId,
    actorId: request.actorId,
  });
  if (!recording) throw new Error("Capture recording for media processing was not found.");
  if (
    captureRecordingAudioManifestSha256(recording) !==
      request.sourceAudioManifestSha256
  ) {
    throw new Error("Capture recording changed after media processing was queued.");
  }
  const head = await getCaptureMediaHead(recording.id, {
    tenantId: job.tenantId,
    actorId: request.actorId,
  });
  if (!head || head.operationJobId !== job.id) {
    throw new Error("Capture media processing job is no longer current.");
  }
  const pending = recording.segments.filter((segment) => !segment.mediaTranscript);
  if (pending.length) {
    for (const segment of pending.slice(0, 50)) {
      await enqueueCaptureSegmentTranscriptionJob({
        tenantId: job.tenantId,
        actorId: request.actorId,
        recordingId: recording.id,
        segment,
        languageHints: request.processing.languageHints.length
          ? request.processing.languageHints
          : [recording.language],
        executionScope,
      });
    }
    await markCaptureMediaProcessingStatus(
      recording.id,
      { tenantId: job.tenantId, actorId: request.actorId, executionScope },
      { operationJobId: job.id, status: "waiting" },
    );
    return {
      __deferOperation: true,
      delaySeconds: 15,
      reason: `Waiting for ${pending.length} durable segment transcript checkpoint(s).`,
      resourceId: recording.id,
    };
  }

  await markCaptureMediaProcessingStatus(
    recording.id,
    { tenantId: job.tenantId, actorId: request.actorId, executionScope },
    { operationJobId: job.id, status: "processing" },
  );
  const turns = recordingTurns(recording, request.processing);
  const extraction = await extractCaptureMediaInsights({
    turns,
    abortSignal,
    usageScope: {
      tenantId: job.tenantId,
      actorId: request.actorId,
      sourceStreamId: `capture-recording:${recording.id}`,
      operation: "structured_generation",
      purpose: "capture.media.insights.extract",
      correlationId: executionScope.correlationId,
      causationId: executionScope.causationId || undefined,
      executionScope,
      credentialSource: "deployment_environment",
    },
  });
  abortSignal.throwIfAborted();
  const transcriptionModels = [...new Set(recording.segments.flatMap((segment) =>
    segment.mediaTranscript?.model ? [segment.mediaTranscript.model] : []
  ))].sort();
  const output = await commitCaptureMediaOutput(
    { tenantId: job.tenantId, actorId: request.actorId, executionScope },
    job.id,
    {
      schemaVersion: 1,
      tenantId: job.tenantId,
      ownerActorId: request.actorId,
      recordingId: recording.id,
      meetingId: request.processing.meetingId,
      sourceAudioManifestSha256: request.sourceAudioManifestSha256,
      transcriptionModel: transcriptionModels.length === 1
        ? transcriptionModels[0]
        : `mixed:${sha256Json(transcriptionModels)}`,
      extractionModel: extraction.model,
      languageTags: extraction.languageTags,
      turns: extraction.turns,
      chapters: extraction.chapters,
      summary: extraction.summary,
      actionItems: extraction.actionItems,
      decisions: extraction.decisions,
      warnings: extraction.warnings,
      rawAudioRetention: request.processing.rawAudioRetention,
    },
  );
  const updatedRecording = await saveCaptureRecordingProcessedTranscript(
    recording.id,
    { tenantId: job.tenantId, actorId: request.actorId, executionScope },
    output.turns.map((turn) =>
      `[${formatTimestamp(turn.startMilliseconds)}] ${speakerName(turn)}: ${turn.text}`
    ).join("\n"),
  );
  const ingest = await enqueueKnowledge({
    recording: { ...updatedRecording, segments: recording.segments },
    output,
    executionScope,
  });
  await markCaptureRecordingIngestQueued(
    recording.id,
    { tenantId: job.tenantId, actorId: request.actorId, executionScope },
    ingest.id,
  );
  let rawAudioDeletedAt: string | undefined;
  if (request.processing.rawAudioRetention.mode === "delete_after_processing") {
    rawAudioDeletedAt = await purgeCaptureRecordingRawAudio(
      recording.id,
      { tenantId: job.tenantId, actorId: request.actorId, executionScope },
    );
    await markCaptureMediaRawAudioDeleted(
      recording.id,
      { tenantId: job.tenantId, actorId: request.actorId, executionScope },
      job.id,
      rawAudioDeletedAt,
    );
  }
  return {
    resourceId: recording.id,
    recordingId: recording.id,
    mediaRevisionId: output.mediaRevisionId,
    outputSha256: output.outputSha256,
    knowledgeIngestJobId: ingest.id,
    turnCount: output.turns.length,
    chapterCount: output.chapters.length,
    actionItemCount: output.actionItems.length,
    decisionCount: output.decisions.length,
    ...(rawAudioDeletedAt ? { rawAudioDeletedAt } : {}),
  };
}

export function captureRecordingAudioManifestSha256(
  recording: CaptureRecordingDetail,
) {
  return sha256Json(recording.segments.map((segment) => ({
    id: segment.id,
    segmentIndex: segment.segmentIndex,
    audioSha256: segment.audioSha256,
    byteCount: segment.byteCount,
    durationMs: segment.durationMs,
  })));
}

export function renderCaptureMediaKnowledge(output: CaptureMediaOutput) {
  const lines = output.turns.map((turn) =>
    `[${formatTimestamp(turn.startMilliseconds)}–${formatTimestamp(turn.endMilliseconds)}] ${speakerName(turn)} (${turn.languageTag}): ${turn.text}`
  );
  return [
    `Summary: ${output.summary.text}`,
    ...output.chapters.map((chapter) =>
      `Chapter ${formatTimestamp(chapter.startMilliseconds)}–${formatTimestamp(chapter.endMilliseconds)} — ${chapter.title}: ${chapter.text}`
    ),
    ...output.actionItems.map((item) => `Action item: ${item.text}`),
    ...output.decisions.map((item) => `Decision: ${item.text}`),
    "Transcript:",
    ...lines,
  ].join("\n\n").slice(0, 900_000);
}

function recordingTurns(
  recording: CaptureRecordingDetail,
  request: CaptureMediaProcessingRequest,
) {
  const speakerMappings = new Map(request.speakerMappings.map((mapping) => [
    mapping.speakerLabel.toLocaleLowerCase("en-US"),
    mapping,
  ]));
  const turns: CaptureMediaTurn[] = [];
  let offset = 0;
  for (const segment of recording.segments) {
    if (!segment.mediaTranscript) {
      throw new Error("Capture media segment checkpoint disappeared during finalization.");
    }
    for (const checkpointTurn of segment.mediaTranscript.turns) {
      const mapping = speakerMappings.get(
        checkpointTurn.speaker.label.toLocaleLowerCase("en-US"),
      );
      const speaker = mapping
        ? {
            label: checkpointTurn.speaker.label,
            identity: "known" as const,
            participantId: mapping.participantId,
            displayName: mapping.displayName,
          }
        : checkpointTurn.speaker;
      const turnInput = {
        segmentId: segment.id,
        segmentIndex: segment.segmentIndex,
        sourceAudioSha256: segment.audioSha256,
        startMilliseconds: offset + checkpointTurn.startMilliseconds,
        endMilliseconds: offset + checkpointTurn.endMilliseconds,
        languageTag: checkpointTurn.languageTag,
        speaker,
        text: checkpointTurn.text,
      };
      turns.push({ ...turnInput, turnId: mediaTurnId(turnInput) });
    }
    offset += segment.durationMs;
  }
  if (!turns.length) throw new Error("Capture media processing produced no transcript turns.");
  return turns;
}

function backgroundExecutionScope(
  job: OperationJobRecord,
  actorId: string,
  purpose: string,
) {
  const source = parsePersistedExecutionScope(job.payload.executionScope);
  if (!source) {
    throw new Error("Capture media job is missing its persisted execution scope.");
  }
  assertExecutionScopeTenant(source, job.tenantId);
  requireExecutionOwner(job.tenantId, actorId, source);
  return deriveExecutionScope(source, {
    executingPrincipalType: "system",
    executingPrincipalId: "background-operations-worker",
    causationId: job.id,
    purpose,
  });
}

function requireExecutionOwner(
  tenantId: string,
  actorId: string,
  executionScope: ExecutionScope,
) {
  if (
    executionScope.tenantId !== tenantId ||
    executionScope.initiatingActorId !== actorId ||
    executionScope.projectId !== null ||
    executionScope.missionId !== null
  ) {
    throw new Error("Capture media job scope does not match its owner.");
  }
}

function assertQueuedRequest(job: OperationJobRecord, requestHash: string) {
  if (job.payload.requestHash !== requestHash) {
    throw new Error("Capture media idempotency key is bound to another request.");
  }
}

function segmentDedupeKey(request: z.infer<typeof segmentJobRequestSchema>) {
  return `capture.media.segment:${request.recordingId}:${request.segmentIndex}:${request.sourceAudioSha256}`;
}

function segmentFileName(segment: CaptureSegment) {
  const extension = segment.mimeType.includes("webm")
    ? "webm"
    : segment.mimeType.includes("mpeg")
      ? "mp3"
      : segment.mimeType.includes("wav")
        ? "wav"
        : segment.mimeType.includes("ogg")
          ? "ogg"
          : "mp4";
  return `${segment.id}.${extension}`;
}

function speakerName(turn: CaptureMediaTurn) {
  return turn.speaker.displayName || `Speaker ${turn.speaker.label}`;
}

function formatTimestamp(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}
