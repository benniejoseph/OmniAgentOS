import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class CaptureRecordingError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 404 | 409 | 410 | 413 = 400,
      readonly code = "capture_recording_error",
    ) {
      super(message);
      this.name = "CaptureRecordingError";
    }
  }
  return {
    CaptureRecordingError,
    authorizeRequest: vi.fn(),
    captureExecutionScopeFromSecurityContext: vi.fn(),
    createAppServiceCaller: vi.fn(),
    createRequestMutationAppServiceCaller: vi.fn(),
    processMeetingRecordingService: vi.fn(),
    showMeetingService: vi.fn(),
    prepareCaptureRecordingMediaProcessing: vi.fn(),
    enqueueCaptureMediaProcessingJob: vi.fn(),
    getCaptureMediaHead: vi.fn(),
    queueCaptureMediaProcessing: vi.fn(),
    projectOperationJobStatus: vi.fn(),
  };
});

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));
vi.mock("@/lib/capture/execution-scope", () => ({
  captureExecutionScopeFromSecurityContext:
    routeMocks.captureExecutionScopeFromSecurityContext,
}));
vi.mock("@/lib/app-services/contracts", () => ({
  createAppServiceCaller: routeMocks.createAppServiceCaller,
  createRequestMutationAppServiceCaller: routeMocks.createRequestMutationAppServiceCaller,
}));
vi.mock("@/lib/app-services/meeting-recordings", () => ({ processMeetingRecordingService: routeMocks.processMeetingRecordingService }));
vi.mock("@/lib/app-services/meetings", () => ({
  showMeetingService: routeMocks.showMeetingService,
}));
vi.mock("@/lib/capture/recordings", () => ({
  CaptureRecordingError: routeMocks.CaptureRecordingError,
  prepareCaptureRecordingMediaProcessing:
    routeMocks.prepareCaptureRecordingMediaProcessing,
}));
vi.mock("@/lib/capture/media-jobs", () => ({
  enqueueCaptureMediaProcessingJob:
    routeMocks.enqueueCaptureMediaProcessingJob,
}));
vi.mock("@/lib/capture/media-store", () => ({
  getCaptureMediaHead: routeMocks.getCaptureMediaHead,
  queueCaptureMediaProcessing: routeMocks.queueCaptureMediaProcessing,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  projectOperationJobStatus: routeMocks.projectOperationJobStatus,
}));

import { POST } from "@/app/api/capture/recordings/[id]/complete/route";
import { recordingRequest } from "@/lib/capture/meeting-recording-native.test-fixtures";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const executionScope = { version: 1, purpose: "capture.recording.media.queue" };
const recording = {
  id: "recording-a",
  tenantId: context.tenantId,
  actorId: context.actorId,
  title: "Customer conversation",
  status: "processing",
  language: "en-US",
  tags: ["customer"],
  startedAt: "2026-09-06T10:00:00.000Z",
  completedAt: "2026-09-06T10:00:03.000Z",
  durationMs: 3_000,
  byteCount: 24,
  segmentCount: 1,
  transcript: "",
  source: "capture:recording:recording-a",
  metadata: {},
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:03.000Z",
  segments: [{
    id: "segment-a",
    segmentIndex: 0,
    durationMs: 3_000,
    transcript: "",
    transcriptionStatus: "pending" as const,
    audioSha256: "a".repeat(64),
    byteCount: 24,
  }],
};

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.authorizeRequest.mockResolvedValue(context);
  routeMocks.captureExecutionScopeFromSecurityContext.mockReturnValue(executionScope);
  routeMocks.createAppServiceCaller.mockReturnValue({ context });
  routeMocks.createRequestMutationAppServiceCaller.mockReturnValue({ context });
  routeMocks.prepareCaptureRecordingMediaProcessing.mockResolvedValue(recording);
  routeMocks.getCaptureMediaHead.mockResolvedValue(undefined);
  routeMocks.enqueueCaptureMediaProcessingJob.mockResolvedValue({
    id: "media-job-a",
    status: "queued",
  });
  routeMocks.queueCaptureMediaProcessing.mockResolvedValue({
    recordingId: recording.id,
    processingStatus: "queued",
    operationJobId: "media-job-a",
  });
  routeMocks.projectOperationJobStatus.mockReturnValue({
    id: "media-job-a",
    status: "queued",
  });
});

describe("capture recording media completion", () => {
  it("requires a stable native key, exact query and the actual bounded request bytes before dispatch", async () => {
    for (const [suffix, key, body, status] of [
      ["", "", JSON.stringify(recordingRequest), 400],
      ["?retry=true", "key", JSON.stringify(recordingRequest), 400],
      ["", "key", JSON.stringify(recordingRequest) + " ".repeat(33_000), 413],
    ] as const) {
      const response = await POST(new Request(`http://localhost/api/capture/recordings/recording-a/complete${suffix}`, { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": key }, body }), { params: Promise.resolve({ id: recording.id }) });
      expect(response.status).toBe(status); expect(response.headers.get("cache-control")).toBe("private, no-store");
    }
    expect(routeMocks.processMeetingRecordingService).not.toHaveBeenCalled(); expect(routeMocks.prepareCaptureRecordingMediaProcessing).not.toHaveBeenCalled();
  });
  it("uses the reviewed native service and capability, returning 202 first and 200 on exact replay", async () => {
    for (const replayed of [false, true]) {
      routeMocks.processMeetingRecordingService.mockResolvedValue({ data: { replayed }, receipt: { operation: "app.meetings.recordings.process" } });
      const response = await POST(new Request("http://localhost/api/capture/recordings/recording-a/complete", { method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "native-key" }, body: JSON.stringify(recordingRequest) }), { params: Promise.resolve({ id: recording.id }) });
      expect(response.status).toBe(replayed ? 200 : 202);
    }
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({ nativeMutationCapability: "meetings.recordings.process", action: "write.memory" }));
    expect(routeMocks.createRequestMutationAppServiceCaller).toHaveBeenCalledWith(expect.any(Request), context,
      { purpose: "api.meeting-recording.process", workspaceId: recordingRequest.workspaceId, causationId: recording.id });
    expect(routeMocks.prepareCaptureRecordingMediaProcessing).not.toHaveBeenCalled();
  });
  it("refuses native legacy bodies without changing ordinary web completion", async () => {
    routeMocks.authorizeRequest.mockResolvedValue({ ...context, source: "mobile" });
    const response = await POST(new Request("http://localhost/api/capture/recordings/recording-a/complete", { method: "POST" }), { params: Promise.resolve({ id: recording.id }) });
    expect(response.status).toBe(400); expect(routeMocks.prepareCaptureRecordingMediaProcessing).not.toHaveBeenCalled();
  });
  it("queues resumable processing without waiting for a segment transcript", async () => {
    const response = await POST(
      new Request("http://localhost/api/capture/recordings/recording-a/complete", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: recording.id }) },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(
      "/api/operations/jobs/media-job-a",
    );
    expect(routeMocks.enqueueCaptureMediaProcessingJob).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: context.tenantId,
        actorId: context.actorId,
        recording,
        request: expect.objectContaining({
          recordingId: recording.id,
          languageHints: ["en-US"],
          rawAudioRetention: { mode: "retain" },
        }),
      }),
    );
    await expect(response.json()).resolves.toMatchObject({
      media: { processingStatus: "queued" },
      job: { id: "media-job-a", status: "queued" },
    });
  });

  it("accepts only consented meeting participants as confirmed speakers", async () => {
    const meetingId = "meeting:11111111-1111-4111-8111-111111111111";
    routeMocks.showMeetingService.mockResolvedValue({
      data: {
        meeting: {
          meetingId,
          sourceLinks: [{ kind: "capture_recording", sourceId: recording.id }],
          participants: [{
            participantId: "participant:customer",
            displayName: "Customer",
            recordingConsent: "granted",
          }],
        },
      },
    });
    const response = await POST(
      new Request("http://localhost/api/capture/recordings/recording-a/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          meetingId,
          speakerMappings: [{
            speakerLabel: "A",
            participantId: "participant:customer",
            displayName: "Customer",
            confirmation: "user_confirmed",
          }],
          rawAudioRetention: { mode: "delete_after_processing" },
        }),
      }),
      { params: Promise.resolve({ id: recording.id }) },
    );

    expect(response.status).toBe(202);
    expect(routeMocks.showMeetingService).toHaveBeenCalledOnce();
    expect(routeMocks.enqueueCaptureMediaProcessingJob).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          meetingId,
          speakerMappings: [expect.objectContaining({ displayName: "Customer" })],
          rawAudioRetention: { mode: "delete_after_processing" },
        }),
      }),
    );
  });

  it("rejects confirmed speaker names without meeting authority", async () => {
    const response = await POST(
      new Request("http://localhost/api/capture/recordings/recording-a/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          speakerMappings: [{
            speakerLabel: "A",
            participantId: "participant:customer",
            displayName: "Customer",
            confirmation: "user_confirmed",
          }],
        }),
      }),
      { params: Promise.resolve({ id: recording.id }) },
    );

    expect(response.status).toBe(409);
    expect(routeMocks.prepareCaptureRecordingMediaProcessing).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      code: "meeting_media_authority",
    });
  });
});
