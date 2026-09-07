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
    getCaptureRecording: vi.fn(),
    getCaptureSegmentAudio: vi.fn(),
    saveCaptureSegment: vi.fn(),
    enqueueCaptureSegmentTranscriptionJob: vi.fn(),
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
vi.mock("@/lib/capture/recordings", () => ({
  CaptureRecordingError: routeMocks.CaptureRecordingError,
  getCaptureRecording: routeMocks.getCaptureRecording,
  getCaptureSegmentAudio: routeMocks.getCaptureSegmentAudio,
  MAX_CAPTURE_SEGMENT_BYTES: 3_000_000,
  saveCaptureSegment: routeMocks.saveCaptureSegment,
}));
vi.mock("@/lib/capture/media-jobs", () => ({
  enqueueCaptureSegmentTranscriptionJob:
    routeMocks.enqueueCaptureSegmentTranscriptionJob,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  projectOperationJobStatus: routeMocks.projectOperationJobStatus,
}));

import { POST } from "@/app/api/capture/recordings/[id]/segments/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const executionScope = { version: 1, purpose: "capture.segment.queue" };
const segment = {
  id: "segment-a",
  tenantId: context.tenantId,
  actorId: context.actorId,
  recordingId: "recording-a",
  segmentIndex: 0,
  mimeType: "audio/webm",
  byteCount: 5,
  durationMs: 1_000,
  audioSha256: "a".repeat(64),
  transcript: "",
  transcriptionStatus: "pending" as const,
  metadata: {},
  createdAt: "2026-09-07T10:00:00.000Z",
  updatedAt: "2026-09-07T10:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  routeMocks.authorizeRequest.mockResolvedValue(context);
  routeMocks.captureExecutionScopeFromSecurityContext.mockReturnValue(executionScope);
  routeMocks.saveCaptureSegment.mockResolvedValue({ created: true, segment });
  routeMocks.getCaptureRecording.mockResolvedValue({
    id: "recording-a",
    language: "en-US",
  });
  routeMocks.enqueueCaptureSegmentTranscriptionJob.mockResolvedValue({
    id: "segment-job-a",
    status: "queued",
  });
  routeMocks.projectOperationJobStatus.mockReturnValue({
    id: "segment-job-a",
    status: "queued",
  });
});

describe("capture recording segment upload", () => {
  it("stores audio and returns a durable background transcription job", async () => {
    const form = new FormData();
    form.set("audio", new File(["audio"], "segment.webm", { type: "audio/webm" }));
    form.set("segmentIndex", "0");
    form.set("durationMs", "1000");
    const response = await POST(
      new Request("http://localhost/api/capture/recordings/recording-a/segments", {
        method: "POST",
        body: form,
      }),
      { params: Promise.resolve({ id: "recording-a" }) },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("location")).toBe(
      "/api/operations/jobs/segment-job-a",
    );
    expect(routeMocks.enqueueCaptureSegmentTranscriptionJob).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      recordingId: "recording-a",
      segment,
      languageHints: ["en-US"],
      executionScope,
    });
    await expect(response.json()).resolves.toMatchObject({
      segment: { id: "segment-a", transcriptionStatus: "pending" },
      job: { id: "segment-job-a", status: "queued" },
    });
  });
});
