import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => {
  class CaptureRecordingError extends Error {
    constructor(
      message: string,
      readonly status: 400 | 404 | 409 | 413 = 400,
      readonly code = "capture_recording_error",
    ) {
      super(message);
      this.name = "CaptureRecordingError";
    }
  }
  class BackgroundJobIdempotencyConflictError extends Error {}
  return {
    CaptureRecordingError,
    BackgroundJobIdempotencyConflictError,
    authorizeRequest: vi.fn(),
    captureExecutionScopeFromSecurityContext: vi.fn(),
    prepareCaptureRecordingCompletion: vi.fn(),
    enqueueKnowledgeIngestJob: vi.fn(),
    markCaptureRecordingIngestQueued: vi.fn(),
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
  prepareCaptureRecordingCompletion:
    routeMocks.prepareCaptureRecordingCompletion,
  markCaptureRecordingIngestQueued:
    routeMocks.markCaptureRecordingIngestQueued,
}));

vi.mock("@/lib/operations/background-jobs", () => ({
  BackgroundJobIdempotencyConflictError:
    routeMocks.BackgroundJobIdempotencyConflictError,
  enqueueKnowledgeIngestJob: routeMocks.enqueueKnowledgeIngestJob,
}));

vi.mock("@/lib/operations/job-queue", () => ({
  projectOperationJobStatus: routeMocks.projectOperationJobStatus,
}));

import { POST } from "@/app/api/capture/recordings/[id]/complete/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
};
const executionScope = { version: 1, purpose: "capture.recording.complete_and_index" };
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
  segmentCount: 2,
  transcript: "Opening\n\nClosing",
  source: "capture:recording:recording-a",
  metadata: {},
  createdAt: "2026-09-06T10:00:00.000Z",
  updatedAt: "2026-09-06T10:00:03.000Z",
  segments: [
    {
      segmentIndex: 0,
      durationMs: 1_000,
      transcript: "Opening",
      transcriptionStatus: "completed" as const,
    },
    {
      segmentIndex: 1,
      durationMs: 2_000,
      transcript: "Closing",
      transcriptionStatus: "completed" as const,
    },
  ],
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.captureExecutionScopeFromSecurityContext
    .mockReset()
    .mockReturnValue(executionScope);
  routeMocks.prepareCaptureRecordingCompletion
    .mockReset()
    .mockResolvedValue(recording);
  routeMocks.enqueueKnowledgeIngestJob.mockReset().mockResolvedValue({ id: "job-a" });
  routeMocks.markCaptureRecordingIngestQueued
    .mockReset()
    .mockResolvedValue({ ...recording, ingestJobId: "job-a" });
  routeMocks.projectOperationJobStatus.mockReset().mockReturnValue({ id: "job-a", status: "queued" });
});

describe("capture recording completion", () => {
  it("queues timestamped structured evidence with a verifiable receipt", async () => {
    const response = await POST(
      new Request("http://localhost/api/capture/recordings/recording-a/complete", { method: "POST" }),
      { params: Promise.resolve({ id: recording.id }) },
    );

    expect(response.status).toBe(202);
    const queued = routeMocks.enqueueKnowledgeIngestJob.mock.calls[0]?.[0];
    expect(queued.request.content).toBe("Opening\n\nClosing");
    expect(queued.request.metadata).toMatchObject({
      structuredSourceKind: "audio",
      extractionState: "completed",
    });
    expect(queued.request.structuredUnits).toHaveLength(2);
    expect(queued.request.structuredUnits[1].locator).toMatchObject({
      kind: "media_time_range",
      startMilliseconds: 1_000,
      endMillisecondsExclusive: 3_000,
    });
    expect(queued.request.metadata.extractionReceiptSha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(response.json()).resolves.toMatchObject({
      extractionReceipt: {
        state: "completed",
        unitCount: 2,
        locatorKinds: ["media_time_range"],
      },
      warnings: [],
    });
  });
});
