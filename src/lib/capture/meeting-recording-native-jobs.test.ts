import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ load: vi.fn(), current: vi.fn(), claim: vi.fn(), commit: vi.fn(), hold: vi.fn(), audio: vi.fn(), transcribe: vi.fn(), update: vi.fn() }));
vi.mock("@/lib/capture/meeting-recording-native-store", () => ({ loadNativeMeetingRecordingJob: mocks.load, checkNativeMeetingRecordingJob: mocks.current,
  claimNativeMeetingRecordingEffect: mocks.claim, commitNativeMeetingRecordingEffect: mocks.commit, holdNativeMeetingRecordingEffect: mocks.hold,
  withNativeMeetingRecordingTransaction: (_scope: unknown, work: (sql: unknown) => unknown) => work(vi.fn()) }));
vi.mock("@/lib/capture/recordings", () => ({ getCaptureSegmentAudio: mocks.audio, updateCaptureSegmentTranscription: mocks.update,
  markCaptureRecordingIngestQueued: vi.fn(), saveCaptureRecordingProcessedTranscript: vi.fn() }));
vi.mock("@/lib/capture/transcription", () => ({ transcribeCaptureMediaDiarized: mocks.transcribe }));
import { executeNativeMeetingRecordingSegment } from "@/lib/capture/meeting-recording-native-jobs";
import { recordingFixture, recordingScope, recordingCaller } from "@/lib/capture/meeting-recording-native.test-fixtures";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import type { OperationJobRecord } from "@/lib/operations/job-queue";
const pinned = { id: "segment-1", segmentIndex: 0, mimeType: "audio/webm", audioSha256: "a".repeat(64), byteCount: 4, durationMs: 1_000, cachedTranscriptSha256: null };
const job: OperationJobRecord = { id: "segment-job", tenantId: recordingScope.tenantId, type: "capture.media.segment.transcribe", leaseOwner: "worker-1",
  status: "running", priority: 1, attempt: 1, maxAttempts: 1, runAt: "2026-10-05T10:00:00.000Z",
  createdAt: "2026-10-05T10:00:00.000Z", updatedAt: "2026-10-05T10:00:00.000Z",
  payload: { nativeParentJobId: "recording-process-job", request: { recordingId: recordingScope.recordingId, segmentId: pinned.id, segmentIndex: 0, sourceAudioSha256: pinned.audioSha256 } } };
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.load.mockResolvedValue({ ...recordingFixture(), manifest: { segments: [pinned] }, executionScope: recordingCaller().executionScope });
  mocks.current.mockResolvedValue({ recording: { segments: [{ ...pinned }] } });
  mocks.audio.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3, 4]), sha256: pinned.audioSha256 });
  mocks.claim.mockResolvedValue({ committed: false, claimId: "claim-1", checkpoint: null });
  mocks.hold.mockResolvedValue(undefined); mocks.commit.mockResolvedValue(undefined);
  mocks.transcribe.mockResolvedValue({ model: "model-test", segments: [{ startMilliseconds: 0, endMilliseconds: 1000, languageTag: "en-US", speakerLabel: "Speaker 1", text: "Reviewed transcript." }] });
});
describe("native recording once-only provider effects", () => {
  it("records uncertainty after a lost provider response and never calls it again", async () => {
    let claimed = false;
    mocks.claim.mockImplementation(async () => { if (claimed) throw new Error("A prior provider effect is unconfirmed"); claimed = true; return { committed: false, claimId: "claim-1" }; });
    mocks.transcribe.mockRejectedValue(new Error("Provider response lost"));
    await expect(executeNativeMeetingRecordingSegment(job, new AbortController().signal)).rejects.toThrow("response lost");
    await expect(executeNativeMeetingRecordingSegment(job, new AbortController().signal)).rejects.toThrow("unconfirmed");
    expect(mocks.transcribe).toHaveBeenCalledOnce(); expect(mocks.transcribe.mock.calls[0][4]).toEqual({ singleAttempt: true, beforeProvider: expect.any(Function) });
    expect(mocks.hold).toHaveBeenCalledOnce(); expect(mocks.commit).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("rechecks consent after the provider await before publishing any transcript", async () => {
    mocks.transcribe.mockImplementation(async () => { mocks.current.mockRejectedValue(new Error("Current consent changed")); return { model: "model-test",
      segments: [{ startMilliseconds: 0, endMilliseconds: 1000, languageTag: "en-US", speakerLabel: "Speaker 1", text: "Reviewed transcript." }] }; });
    await expect(executeNativeMeetingRecordingSegment(job, new AbortController().signal)).rejects.toThrow("consent changed");
    expect(mocks.transcribe).toHaveBeenCalledOnce(); expect(mocks.update).not.toHaveBeenCalled(); expect(mocks.commit).not.toHaveBeenCalled();
    expect(mocks.hold.mock.calls[0][4]).toBe(true);
  });
  it("reuses a matching committed checkpoint without reading audio or calling a provider", async () => {
    const checkpoint = { transcriptSha256: "b".repeat(64) };
    mocks.current.mockResolvedValue({ recording: { segments: [{ ...pinned, mediaTranscript: checkpoint }] } });
    mocks.claim.mockResolvedValue({ committed: true, checkpoint: { transcriptCheckpointSha256: canonicalJsonSha256(checkpoint) }, claimId: "claim-1" });
    expect(await executeNativeMeetingRecordingSegment(job, new AbortController().signal)).toMatchObject({ resumed: true, resourceId: pinned.id });
    expect(mocks.audio).not.toHaveBeenCalled(); expect(mocks.transcribe).not.toHaveBeenCalled(); expect(mocks.update).not.toHaveBeenCalled();
  });
});
