import { captureSegmentMediaTranscriptSchema, sha256Json } from "@/lib/capture/media-contracts";
import { recordingTurns, renderCaptureMediaKnowledge, type CaptureMediaDeferredResult, type CaptureMediaKnowledgeEnqueuer } from "@/lib/capture/media-jobs";
import { extractCaptureMediaInsights } from "@/lib/capture/media-extraction";
import { commitCaptureMediaOutput } from "@/lib/capture/media-store";
import { getCaptureSegmentAudio, markCaptureRecordingIngestQueued, saveCaptureRecordingProcessedTranscript, updateCaptureSegmentTranscription } from "@/lib/capture/recordings";
import { transcribeCaptureMediaDiarized } from "@/lib/capture/transcription";
import { claimNativeMeetingRecordingEffect, checkNativeMeetingRecordingJob, commitNativeMeetingRecordingEffect,
  holdNativeMeetingRecordingEffect, loadNativeMeetingRecordingJob, withNativeMeetingRecordingTransaction,
  type NativeMeetingRecordingJob } from "@/lib/capture/meeting-recording-native-store";
import { enqueueOperationJob, type OperationJobRecord } from "@/lib/operations/job-queue";
import { createExecutionScope, deriveExecutionScope } from "@/lib/security/execution-scope";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { CaptureIngestGuard } from "@/lib/capture/ingest-guard";

const owner = (accepted: NativeMeetingRecordingJob) => ({ tenantId: accepted.intent.scope.tenantId, actorId: accepted.intent.scope.ownerActorId,
  executionScope: accepted.executionScope, nativeAcceptanceId: accepted.acceptance.id });
function requireParent(job: OperationJobRecord, accepted: NativeMeetingRecordingJob) {
  if (job.type === "capture.media.recording.process" ? job.id !== accepted.acceptance.operationJobId
    : job.payload.nativeParentJobId !== accepted.acceptance.operationJobId) throw new Error("Native worker job does not belong to its exact processing acceptance.");
}
async function current(accepted: NativeMeetingRecordingJob, job: OperationJobRecord) {
  return withNativeMeetingRecordingTransaction(accepted.intent.scope, (sql) => checkNativeMeetingRecordingJob(sql, accepted, job));
}
function blocked(error: unknown) { return error instanceof Error && /authority|consent|source.*changed|lease/i.test(error.message); }

export async function executeNativeMeetingRecordingSegment(job: OperationJobRecord, signal: AbortSignal) {
  const accepted = await loadNativeMeetingRecordingJob(job); requireParent(job, accepted);
  const request = job.payload.request as { segmentId?: string; segmentIndex?: number; recordingId?: string; sourceAudioSha256?: string };
  const pinned = accepted.manifest.segments.find((item) => item.id === request?.segmentId && item.segmentIndex === request.segmentIndex);
  if (!pinned || request.recordingId !== accepted.intent.scope.recordingId || request.sourceAudioSha256 !== pinned.audioSha256) throw new Error("Native segment request differs from the accepted audio manifest.");
  const value = await current(accepted, job), segment = value.recording.segments.find((item) => item.id === pinned.id)!;
  if (pinned.cachedTranscriptSha256) {
    if (!segment?.mediaTranscript || canonicalJsonSha256(segment.mediaTranscript) !== pinned.cachedTranscriptSha256) throw new Error("Reviewed transcript checkpoint changed.");
    return { resourceId: segment.id, resumed: true };
  }
  const stage = `segment:${pinned.id}`, claim = await claimNativeMeetingRecordingEffect(accepted, job, stage, {
    segment: pinned, languageHints: accepted.intent.request.languageHints,
  });
  if (claim.committed) {
    if (!segment?.mediaTranscript || canonicalJsonSha256(segment.mediaTranscript) !== claim.checkpoint.transcriptCheckpointSha256) throw new Error("Committed native transcript checkpoint is unavailable.");
    return { resourceId: segment.id, resumed: true };
  }
  try {
    signal.throwIfAborted(); await current(accepted, job);
    const audio = await getCaptureSegmentAudio(accepted.intent.scope.recordingId, pinned.segmentIndex, owner(accepted));
    if (audio.sha256 !== pinned.audioSha256) throw new Error("Accepted source audio digest changed.");
    await current(accepted, job); signal.throwIfAborted();
    const transcription = await transcribeCaptureMediaDiarized(new File([audio.bytes], `segment-${pinned.segmentIndex}`, { type: pinned.mimeType }),
      accepted.intent.request.languageHints, signal, { ...owner(accepted), sourceStreamId: `capture-recording:${accepted.intent.scope.recordingId}`,
        operation: "transcription", purpose: "capture.media.segment.transcribe.background", correlationId: accepted.executionScope.correlationId,
        causationId: job.id, credentialSource: "deployment_environment" }, { singleAttempt: true, beforeProvider: async () => { await current(accepted, job); } });
    signal.throwIfAborted();
    const turns = transcription.segments.map((turn) => ({ startMilliseconds: turn.startMilliseconds, endMilliseconds: turn.endMilliseconds,
      languageTag: turn.languageTag, speaker: { label: turn.speakerLabel, identity: turn.speakerLabel === "Unknown" ? "unknown" as const : "diarized" as const }, text: turn.text }));
    const transcript = turns.map((turn) => turn.text).join("\n");
    const checkpoint = captureSegmentMediaTranscriptSchema.parse({ schemaVersion: 1, recordingId: accepted.intent.scope.recordingId,
      segmentId: pinned.id, segmentIndex: pinned.segmentIndex, sourceAudioSha256: pinned.audioSha256, transcriptSha256: sha256Json(transcript),
      model: transcription.model, languageTags: [...new Set(turns.map((turn) => turn.languageTag))].sort((a, b) => a.localeCompare(b)), turns, transcribedAt: new Date().toISOString() });
    await withNativeMeetingRecordingTransaction(accepted.intent.scope, async (sql) => {
      await checkNativeMeetingRecordingJob(sql, accepted, job);
      await updateCaptureSegmentTranscription({ ...owner(accepted), recordingId: accepted.intent.scope.recordingId, segmentIndex: pinned.segmentIndex,
        status: "completed", transcript, model: transcription.model, mediaTranscript: checkpoint });
      await commitNativeMeetingRecordingEffect(sql, accepted, job, stage, claim.claimId, { transcriptCheckpointSha256: canonicalJsonSha256(checkpoint),
        transcriptSha256: checkpoint.transcriptSha256, segmentId: pinned.id });
    });
    return { resourceId: pinned.id, recordingId: accepted.intent.scope.recordingId, transcriptSha256: checkpoint.transcriptSha256 };
  } catch (error) { await holdNativeMeetingRecordingEffect(accepted, job, stage, claim.claimId, blocked(error)).catch(() => undefined); throw error; }
}

export async function executeNativeMeetingRecordingProcessing(job: OperationJobRecord, signal: AbortSignal,
  enqueueKnowledge: CaptureMediaKnowledgeEnqueuer): Promise<Record<string, unknown> | CaptureMediaDeferredResult> {
  const accepted = await loadNativeMeetingRecordingJob(job); requireParent(job, accepted);
  const request = job.payload.request as { processing?: unknown; actorId?: string; sourceAudioManifestSha256?: string };
  const processing = { schemaVersion: 1 as const, recordingId: accepted.intent.scope.recordingId, meetingId: accepted.intent.scope.meetingId,
    languageHints: accepted.intent.request.languageHints, speakerMappings: accepted.intent.request.speakerMappings, rawAudioRetention: accepted.intent.request.rawAudioRetention };
  if (request.actorId !== accepted.intent.scope.ownerActorId || request.sourceAudioManifestSha256 !== accepted.acceptance.sourceAudioManifestSha256 ||
    canonicalJsonSha256(request.processing) !== canonicalJsonSha256(processing)) throw new Error("Native finalization request differs from its accepted intent.");
  const value = await current(accepted, job), recording = value.recording;
  const pending = recording.segments.filter((segment) => !segment.mediaTranscript);
  if (pending.length) {
    await withNativeMeetingRecordingTransaction(accepted.intent.scope, async (sql) => {
      await checkNativeMeetingRecordingJob(sql, accepted, job);
      for (const segment of pending.slice(0, 50)) {
        const segmentRequest = { schemaVersion: 1, actorId: accepted.intent.scope.ownerActorId, recordingId: recording.id,
          segmentId: segment.id, segmentIndex: segment.segmentIndex, sourceAudioSha256: segment.audioSha256,
          mimeType: segment.mimeType, languageHints: processing.languageHints };
        const child = await enqueueOperationJob({ tenantId: job.tenantId, type: "capture.media.segment.transcribe",
          dedupeKey: `${accepted.acceptance.id}:segment:${segment.id}`, maxAttempts: 1, priority: 3, dedupeMode: "idempotent",
          payload: { actorId: accepted.intent.scope.ownerActorId, nativeAcceptanceId: accepted.acceptance.id, nativeParentJobId: job.id,
            request: segmentRequest, requestHash: canonicalJsonSha256(segmentRequest), executionScope: deriveExecutionScope(accepted.executionScope, { purpose: "capture.media.segment.transcribe.background" }) } }, { sql });
        if (["failed", "canceled", "quarantined"].includes(child.status)) throw new Error("A native transcription is unconfirmed; automatic restart is unavailable.");
      }
    });
    return { __deferOperation: true, delaySeconds: 15, reason: "Waiting for exact native transcript checkpoints.", resourceId: recording.id };
  }
  // Every completed transcript must be either part of the reviewed snapshot or
  // the exact result checkpoint of this acceptance's single segment attempt.
  await withNativeMeetingRecordingTransaction(accepted.intent.scope, async (sql) => {
    await checkNativeMeetingRecordingJob(sql, accepted, job);
    const effects = await sql`SELECT stage,checkpoint FROM omni_meeting_recording_processing_effects WHERE acceptance_id=${accepted.acceptance.id} AND state='committed'`;
    for (const segment of recording.segments) {
      const pinned = accepted.manifest.segments.find((item) => item.id === segment.id);
      const digest = canonicalJsonSha256(segment.mediaTranscript);
      const completed = effects.find((item) => item.stage === `segment:${segment.id}`)?.checkpoint as { transcriptCheckpointSha256?: string } | undefined;
      if (!pinned || digest !== (pinned.cachedTranscriptSha256 ?? completed?.transcriptCheckpointSha256)) throw new Error("A transcript lacks its exact reviewed or accepted checkpoint.");
    }
  });
  const turns = recordingTurns(recording, processing);
  const claim = await claimNativeMeetingRecordingEffect(accepted, job, "extract", { turnsSha256: canonicalJsonSha256(turns), processing });
  if (claim.committed) {
    const now = await current(accepted, job);
    if (!now.head?.output || now.head.output.outputSha256 !== claim.checkpoint.outputSha256 || now.recording.ingestJobId !== claim.checkpoint.knowledgeIngestJobId) throw new Error("Committed media checkpoint is unavailable.");
    return { resourceId: recording.id, ...claim.checkpoint, resumed: true };
  }
  try {
    await current(accepted, job); signal.throwIfAborted();
    const extraction = await extractCaptureMediaInsights({ turns, abortSignal: signal, singleAttempt: true, beforeProvider: async () => { await current(accepted, job); },
      usageScope: { ...owner(accepted), sourceStreamId: `capture-recording:${recording.id}`, operation: "structured_generation",
        purpose: "capture.media.insights.extract", correlationId: accepted.executionScope.correlationId, causationId: job.id, credentialSource: "deployment_environment" } });
    signal.throwIfAborted();
    return await withNativeMeetingRecordingTransaction(accepted.intent.scope, async (sql) => {
      await checkNativeMeetingRecordingJob(sql, accepted, job);
      const models = [...new Set(recording.segments.map((segment) => segment.mediaTranscript!.model))].sort();
      const mediaOwner = { tenantId: job.tenantId,actorId: accepted.intent.scope.canonicalActorId,
        executionScope: createExecutionScope({ ...accepted.executionScope,initiatingActorId: accepted.intent.scope.canonicalActorId }) };
      const output = await commitCaptureMediaOutput(mediaOwner, job.id, { schemaVersion: 1, tenantId: job.tenantId,
        ownerActorId: accepted.intent.scope.canonicalActorId, recordingId: recording.id, meetingId: processing.meetingId,
        sourceAudioManifestSha256: accepted.acceptance.sourceAudioManifestSha256, transcriptionModel: models.length === 1 ? models[0] : `mixed:${sha256Json(models)}`,
        extractionModel: extraction.model, languageTags: extraction.languageTags, turns: extraction.turns, chapters: extraction.chapters,
        summary: extraction.summary, actionItems: extraction.actionItems, decisions: extraction.decisions, warnings: extraction.warnings, rawAudioRetention: processing.rawAudioRetention });
      const updated = await saveCaptureRecordingProcessedTranscript(recording.id, owner(accepted), output.turns.map((turn) =>
        `[${turn.startMilliseconds}ms] ${turn.speaker.displayName ?? turn.speaker.label}: ${turn.text}`).join("\n"));
      const knowledge = await enqueueKnowledge({ recording: { ...updated, segments: recording.segments }, output,
        executionScope: accepted.executionScope, nativeAcceptanceId: accepted.acceptance.id, nativeParentJobId: job.id });
      await markCaptureRecordingIngestQueued(recording.id, owner(accepted), knowledge.id);
      const checkpoint = { mediaRevisionId: output.mediaRevisionId, outputSha256: output.outputSha256, knowledgeIngestJobId: knowledge.id };
      await commitNativeMeetingRecordingEffect(sql, accepted, job, "extract", claim.claimId, checkpoint);
      return { resourceId: recording.id, ...checkpoint };
    });
  } catch (error) { await holdNativeMeetingRecordingEffect(accepted, job, "extract", claim.claimId, blocked(error)).catch(() => undefined); throw error; }
}

export type NativeRecordingIngestGuard = NonNullable<CaptureIngestGuard["nativeRecording"]>;
export async function executeNativeMeetingRecordingKnowledge<T extends Record<string, unknown>>(job: OperationJobRecord, signal: AbortSignal,
  work: (guard: NativeRecordingIngestGuard, recheck: () => Promise<void>) => Promise<T>) {
  const accepted = await loadNativeMeetingRecordingJob(job); requireParent(job, accepted);
  const value = await current(accepted, job);
  if (value.recording.ingestJobId !== job.id || !value.head?.output) throw new Error("Native Knowledge job is not the exact current output projection.");
  const request = job.payload.request as { title?: unknown; source?: unknown; content?: unknown; metadata?: Record<string, unknown>; evidenceRefs?: unknown };
  const output = value.head.output;
  const evidenceRefs = [...new Set([output.mediaRevisionId, ...output.summary.citations.map((citation) => citation.turnId)])].slice(0, 100);
  if (request.title !== value.recording.title || request.source !== value.recording.source || request.content !== renderCaptureMediaKnowledge(output) ||
    request.metadata?.captureRecordingId !== value.recording.id || request.metadata?.mediaRevisionId !== output.mediaRevisionId ||
    request.metadata?.outputSha256 !== output.outputSha256 || canonicalJsonSha256(request.evidenceRefs) !== canonicalJsonSha256(evidenceRefs)) {
    throw new Error("Native Knowledge request differs from the exact committed media output.");
  }
  const claim = await claimNativeMeetingRecordingEffect(accepted, job, "knowledge", { outputSha256: value.head.output.outputSha256, request: job.payload.request });
  if (claim.committed) return { resourceId: accepted.intent.scope.recordingId, ...claim.checkpoint, resumed: true };
  const guard = { acceptanceId: accepted.acceptance.id, claimId: claim.claimId, jobId: job.id, leaseOwner: job.leaseOwner ?? "" };
  try {
    const recheck = async () => { signal.throwIfAborted(); await current(accepted, job); };
    await recheck(); const result = await work(guard, recheck); await recheck();
    const documentId = typeof result.documentId === "string" ? result.documentId : typeof result.resourceId === "string" ? result.resourceId : null;
    if (!documentId) throw new Error("Knowledge completion did not return its exact document receipt.");
    await withNativeMeetingRecordingTransaction(accepted.intent.scope, (sql) => commitNativeMeetingRecordingEffect(sql, accepted, job, "knowledge", claim.claimId, { documentId }));
    return result;
  } catch (error) { await holdNativeMeetingRecordingEffect(accepted, job, "knowledge", claim.claimId, blocked(error)).catch(() => undefined); throw error; }
}
