import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  enqueueOperationJob: vi.fn(),
  requeueOperationJobByDedupeKey: vi.fn(),
  getCaptureRecording: vi.fn(),
  getCaptureSegmentAudio: vi.fn(),
  updateCaptureSegmentTranscription: vi.fn(),
  saveCaptureRecordingProcessedTranscript: vi.fn(),
  markCaptureRecordingIngestQueued: vi.fn(),
  purgeCaptureRecordingRawAudio: vi.fn(),
  getCaptureMediaHead: vi.fn(),
  markCaptureMediaProcessingStatus: vi.fn(),
  commitCaptureMediaOutput: vi.fn(),
  markCaptureMediaRawAudioDeleted: vi.fn(),
  transcribeCaptureMediaDiarized: vi.fn(),
  extractCaptureMediaInsights: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/job-queue")>()),
  enqueueOperationJob: mocks.enqueueOperationJob,
  requeueOperationJobByDedupeKey: mocks.requeueOperationJobByDedupeKey,
}));
vi.mock("@/lib/capture/recordings", () => ({
  getCaptureRecording: mocks.getCaptureRecording,
  getCaptureSegmentAudio: mocks.getCaptureSegmentAudio,
  updateCaptureSegmentTranscription: mocks.updateCaptureSegmentTranscription,
  saveCaptureRecordingProcessedTranscript: mocks.saveCaptureRecordingProcessedTranscript,
  markCaptureRecordingIngestQueued: mocks.markCaptureRecordingIngestQueued,
  purgeCaptureRecordingRawAudio: mocks.purgeCaptureRecordingRawAudio,
}));
vi.mock("@/lib/capture/media-store", () => ({
  getCaptureMediaHead: mocks.getCaptureMediaHead,
  markCaptureMediaProcessingStatus: mocks.markCaptureMediaProcessingStatus,
  commitCaptureMediaOutput: mocks.commitCaptureMediaOutput,
  markCaptureMediaRawAudioDeleted: mocks.markCaptureMediaRawAudioDeleted,
}));
vi.mock("@/lib/capture/transcription", () => ({
  transcribeCaptureMediaDiarized: mocks.transcribeCaptureMediaDiarized,
}));
vi.mock("@/lib/capture/media-extraction", () => ({
  extractCaptureMediaInsights: mocks.extractCaptureMediaInsights,
}));

import {
  captureRecordingAudioManifestSha256,
  executeCaptureMediaProcessingJob,
  executeCaptureMediaSegmentJob,
} from "@/lib/capture/media-jobs";
import { sha256Json } from "@/lib/capture/media-contracts";
import type { CaptureRecordingDetail } from "@/lib/capture/types";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
import { createExecutionScope } from "@/lib/security/execution-scope";

const executionScope = createExecutionScope({
  tenantId: "tenant-a",
  initiatingActorId: "actor-a",
  executingPrincipalType: "user",
  executingPrincipalId: "actor-a",
  correlationId: "correlation-a",
  purpose: "capture.media.queue",
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.markCaptureMediaProcessingStatus.mockResolvedValue({});
  mocks.enqueueOperationJob.mockImplementation(async (input) => ({
    id: "segment-job-a",
    tenantId: input.tenantId,
    type: input.type,
    status: "queued",
    payload: input.payload,
    dedupeKey: input.dedupeKey,
    priority: input.priority,
    attempt: 0,
    maxAttempts: input.maxAttempts,
    runAt: "2026-09-07T10:00:00.000Z",
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:00.000Z",
  }));
});

describe("capture media background jobs", () => {
  it("resumes from a durable segment transcript checkpoint", async () => {
    const recording = recordingFixture(true);
    mocks.getCaptureRecording.mockResolvedValue(recording);
    const segment = recording.segments[0];
    const job = operationJob("capture.media.segment.transcribe", {
      schemaVersion: 1,
      actorId: "actor-a",
      recordingId: recording.id,
      segmentId: segment.id,
      segmentIndex: segment.segmentIndex,
      sourceAudioSha256: segment.audioSha256,
      mimeType: segment.mimeType,
      languageHints: ["en-US"],
    });

    await expect(executeCaptureMediaSegmentJob(
      job,
      new AbortController().signal,
    )).resolves.toMatchObject({
      resourceId: segment.id,
      resumed: true,
      transcriptSha256: sha256Json("Hello there."),
    });
    expect(mocks.getCaptureSegmentAudio).not.toHaveBeenCalled();
    expect(mocks.transcribeCaptureMediaDiarized).not.toHaveBeenCalled();
  });

  it("defers finalization and queues only missing segment checkpoints", async () => {
    const recording = recordingFixture(false);
    mocks.getCaptureRecording.mockResolvedValue(recording);
    mocks.getCaptureMediaHead.mockResolvedValue({ operationJobId: "job-a" });
    const job = operationJob("capture.media.recording.process", {
      processing: {
        schemaVersion: 1,
        recordingId: recording.id,
        languageHints: ["en-US"],
        speakerMappings: [],
        rawAudioRetention: { mode: "retain" },
      },
      actorId: "actor-a",
      sourceAudioManifestSha256: captureRecordingAudioManifestSha256(recording),
    });

    await expect(executeCaptureMediaProcessingJob(
      job,
      new AbortController().signal,
      vi.fn(),
    )).resolves.toMatchObject({
      __deferOperation: true,
      resourceId: recording.id,
      delaySeconds: 15,
    });
    expect(mocks.enqueueOperationJob).toHaveBeenCalledOnce();
    expect(mocks.enqueueOperationJob).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: "tenant-a",
      type: "capture.media.segment.transcribe",
      dedupeMode: "idempotent",
    }));
    expect(mocks.markCaptureMediaProcessingStatus).toHaveBeenCalledWith(
      recording.id,
      expect.objectContaining({ tenantId: "tenant-a", actorId: "actor-a" }),
      { operationJobId: "job-a", status: "waiting" },
    );
    expect(mocks.extractCaptureMediaInsights).not.toHaveBeenCalled();
  });
});

function recordingFixture(withCheckpoint: boolean): CaptureRecordingDetail {
  const audioSha256 = "a".repeat(64);
  return {
    id: "capture_recording_a",
    tenantId: "tenant-a",
    actorId: "actor-a",
    title: "Product sync",
    status: "processing",
    language: "en-US",
    tags: ["product"],
    startedAt: "2026-09-07T10:00:00.000Z",
    completedAt: "2026-09-07T10:01:00.000Z",
    durationMs: 60_000,
    byteCount: 128,
    segmentCount: 1,
    transcript: "",
    source: "capture:recording:capture_recording_a",
    metadata: {},
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:01:00.000Z",
    segments: [{
      id: "capture_segment_a",
      tenantId: "tenant-a",
      actorId: "actor-a",
      recordingId: "capture_recording_a",
      segmentIndex: 0,
      mimeType: "audio/webm",
      byteCount: 128,
      durationMs: 60_000,
      audioSha256,
      transcript: "",
      transcriptionStatus: withCheckpoint ? "completed" : "pending",
      ...(withCheckpoint ? {
        mediaTranscript: {
          schemaVersion: 1,
          recordingId: "capture_recording_a",
          segmentId: "capture_segment_a",
          segmentIndex: 0,
          sourceAudioSha256: audioSha256,
          transcriptSha256: sha256Json("Hello there."),
          model: "gpt-4o-transcribe-diarize",
          languageTags: ["en-US"],
          turns: [{
            startMilliseconds: 0,
            endMilliseconds: 2_000,
            languageTag: "en-US",
            speaker: { label: "A", identity: "diarized" },
            text: "Hello there.",
          }],
          transcribedAt: "2026-09-07T10:01:00.000Z",
        },
      } : {}),
      metadata: {},
      createdAt: "2026-09-07T10:00:00.000Z",
      updatedAt: "2026-09-07T10:01:00.000Z",
    }],
  };
}

function operationJob(
  type: OperationJobRecord["type"],
  request: Record<string, unknown>,
): OperationJobRecord {
  return {
    id: "job-a",
    tenantId: "tenant-a",
    type,
    status: "running",
    payload: { request, actorId: "actor-a", executionScope },
    priority: 1,
    attempt: 1,
    maxAttempts: 5,
    runAt: "2026-09-07T10:00:00.000Z",
    lockedAt: "2026-09-07T10:00:00.000Z",
    leaseOwner: "worker-a",
    leaseExpiresAt: "2026-09-07T10:05:00.000Z",
    createdAt: "2026-09-07T10:00:00.000Z",
    updatedAt: "2026-09-07T10:00:00.000Z",
  };
}
