import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ submit: vi.fn(), read: vi.fn(), review: vi.fn() }));
vi.mock("@/lib/capture/meeting-recording-native-store", () => ({ submitNativeMeetingRecording: mocks.submit, readNativeMeetingRecording: mocks.read, reviewNativeMeetingRecording: mocks.review }));
import { inspectMeetingRecordingProcessingService, processMeetingRecordingService } from "@/lib/app-services/meeting-recordings";
import { recordingCaller, recordingFixture, recordingRequest, recordingScope } from "@/lib/capture/meeting-recording-native.test-fixtures";
beforeEach(() => { for (const mock of Object.values(mocks)) mock.mockReset(); });
describe("native recording service authority", () => {
  it("derives only the exact queue purpose and validates the compact accepted result", async () => {
    const fixture = recordingFixture(); mocks.submit.mockResolvedValue({ acceptance: fixture.acceptance, processing: fixture.processing, replayed: false });
    const result = await processMeetingRecordingService(recordingCaller(), recordingScope.recordingId, recordingRequest);
    expect(result.data.acceptance).toEqual(fixture.acceptance);
    expect(mocks.submit.mock.calls[0][0].authority).toMatchObject({ scope: recordingScope, executionScope: { purpose: "capture.recording.media.queue",
      workspaceId: recordingScope.workspaceId, initiatingActorId: recordingScope.ownerActorId, causationId: recordingScope.recordingId } });
  });
  it("exact read uses current viewer authority and performs no mutation", async () => {
    const fixture = recordingFixture(); mocks.read.mockResolvedValue({ acceptance: fixture.acceptance, processing: fixture.processing });
    const caller = recordingCaller(false);
    const result = await inspectMeetingRecordingProcessingService({ ...caller, context: { ...caller.context, role: "viewer" } }, recordingScope.recordingId,
      fixture.intent.keySha256, { workspaceId: recordingScope.workspaceId, meetingId: recordingScope.meetingId });
    expect(result.data.acceptance).toEqual(fixture.acceptance); expect(mocks.submit).not.toHaveBeenCalled(); expect(mocks.review).not.toHaveBeenCalled();
  });
  it("rejects canonical-owner substitution, purpose and workspace mismatch before storage", async () => {
    const caller = recordingCaller();
    for (const bad of [{ ...caller, context: { ...caller.context, actorId: recordingScope.canonicalActorId } },
      { ...caller, executionScope: { ...caller.executionScope!, purpose: "capture.recording.media.queue" } },
      { ...caller, executionScope: { ...caller.executionScope!, workspaceId: "workspace:other" } }]) {
      await expect(processMeetingRecordingService(bad, recordingScope.recordingId, recordingRequest)).rejects.toMatchObject({ status: 403 });
    }
    expect(mocks.submit).not.toHaveBeenCalled();
  });
});
