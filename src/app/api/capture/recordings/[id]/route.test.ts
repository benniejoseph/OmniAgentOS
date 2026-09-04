import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestCaptureRecordingMetadataDetail } from "@/lib/capture/types";

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
  class CaptureRecordingReadConflictError extends Error {
    constructor(message = "Capture recording ownership is ambiguous.") {
      super(message);
      this.name = "CaptureRecordingReadConflictError";
    }
  }
  return {
    CaptureRecordingError,
    CaptureRecordingReadConflictError,
    authorizeRequest: vi.fn(),
    cancelOperationJobByDedupeKey: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    captureExecutionScopeFromSecurityContext: vi.fn(),
    deleteCaptureRecording: vi.fn(),
    deleteKnowledgeDocumentsBySourcePrefix: vi.fn(),
    getCaptureRecording: vi.fn(),
    getCaptureRecordingMetadataForRequest: vi.fn(),
    getOperationJob: vi.fn(),
    updateCaptureRecording: vi.fn(),
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

vi.mock("@/lib/security/canonical-actor", () => ({
  canonicalRequestActorBindingFromSecurityContext:
    routeMocks.canonicalRequestActorBindingFromSecurityContext,
}));

vi.mock("@/lib/capture/recordings", () => ({
  CaptureRecordingError: routeMocks.CaptureRecordingError,
  CaptureRecordingReadConflictError:
    routeMocks.CaptureRecordingReadConflictError,
  deleteCaptureRecording: routeMocks.deleteCaptureRecording,
  getCaptureRecording: routeMocks.getCaptureRecording,
  getCaptureRecordingMetadataForRequest:
    routeMocks.getCaptureRecordingMetadataForRequest,
  updateCaptureRecording: routeMocks.updateCaptureRecording,
}));

vi.mock("@/lib/capture/execution-scope", () => ({
  captureExecutionScopeFromSecurityContext:
    routeMocks.captureExecutionScopeFromSecurityContext,
}));

vi.mock("@/lib/rag/store", () => ({
  deleteKnowledgeDocumentsBySourcePrefix:
    routeMocks.deleteKnowledgeDocumentsBySourcePrefix,
}));

vi.mock("@/lib/operations/job-queue", () => ({
  cancelOperationJobByDedupeKey:
    routeMocks.cancelOperationJobByDedupeKey,
  getOperationJob: routeMocks.getOperationJob,
}));

import {
  DELETE,
  GET,
  PATCH,
} from "@/app/api/capture/recordings/[id]/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner@example.test",
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: "11111111-1111-4111-8111-111111111111",
    email: "owner@example.test",
    sessionId: "session-a",
    tenantName: "Tenant A",
  },
};
const requestActorBinding = {
  version: 1,
  kind: "auth_user",
  authUserId: context.auth.userId,
  canonicalActorId: `actor:${context.auth.userId}`,
  legacyOwnerActorIds: [context.actorId],
  readableOwnerActorIds: [
    `actor:${context.auth.userId}`,
    context.actorId,
  ],
};
const executionScope = { version: 1, purpose: "capture.recording.test" };
const exactRecording = {
  id: "recording-a",
  tenantId: context.tenantId,
  actorId: context.actorId,
  title: "Exact recording",
  status: "ready",
  language: "en-US",
  tags: ["capture"],
  startedAt: "2026-09-05T10:00:00.000Z",
  durationMs: 1_000,
  byteCount: 12,
  segmentCount: 1,
  transcript: "private transcript",
  source: "capture:recording:recording-a",
  metadata: { private: true },
  createdAt: "2026-09-05T10:00:00.000Z",
  updatedAt: "2026-09-05T10:01:00.000Z",
  segments: [{ id: "segment-a", transcript: "private segment" }],
};
const readableMetadata: RequestCaptureRecordingMetadataDetail = {
  id: exactRecording.id,
  title: "Retained recording",
  status: "ready",
  language: "en-US",
  tags: ["capture"],
  startedAt: exactRecording.startedAt,
  durationMs: exactRecording.durationMs,
  byteCount: exactRecording.byteCount,
  segmentCount: exactRecording.segmentCount,
  createdAt: exactRecording.createdAt,
  updatedAt: exactRecording.updatedAt,
  metadataAvailable: true,
  segmentMetadataAvailable: true,
  transcriptAvailable: false,
  audioAvailable: false,
  manageable: false,
  segments: [{
    id: "segment-a",
    segmentIndex: 0,
    mimeType: "audio/webm",
    byteCount: 12,
    durationMs: 1_000,
    transcriptionStatus: "completed",
    createdAt: exactRecording.createdAt,
    updatedAt: exactRecording.updatedAt,
  }],
};
const route = { params: Promise.resolve({ id: exactRecording.id }) };

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.captureExecutionScopeFromSecurityContext
    .mockReset()
    .mockReturnValue(executionScope);
  routeMocks.deleteCaptureRecording.mockReset().mockResolvedValue(true);
  routeMocks.deleteKnowledgeDocumentsBySourcePrefix
    .mockReset()
    .mockResolvedValue(1);
  routeMocks.getCaptureRecording
    .mockReset()
    .mockResolvedValue(exactRecording);
  routeMocks.getCaptureRecordingMetadataForRequest
    .mockReset()
    .mockResolvedValue(readableMetadata);
  routeMocks.getOperationJob.mockReset().mockResolvedValue(undefined);
  routeMocks.cancelOperationJobByDedupeKey.mockReset();
  routeMocks.updateCaptureRecording
    .mockReset()
    .mockResolvedValue(exactRecording);
});

describe("Capture recording detail ownership", () => {
  it("keeps bare GET on the exact full-detail reader", async () => {
    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}`,
    ), route);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      recording: exactRecording,
      requestReadContracts: { captureRecordingDetail: "exact_v1" },
    });
    expect(routeMocks.getCaptureRecording).toHaveBeenCalledWith(
      exactRecording.id,
      context,
    );
    expect(
      routeMocks.getCaptureRecordingMetadataForRequest,
    ).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("uses request-safe metadata only for the literal readable GET", async () => {
    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=readable`,
    ), route);

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      recording: readableMetadata,
      requestReadContracts: { captureRecordingDetail: "readable_v1" },
    });
    expect(JSON.stringify(readableMetadata)).not.toContain("private transcript");
    expect(JSON.stringify(readableMetadata)).not.toContain("private segment");
    expect(
      routeMocks.getCaptureRecordingMetadataForRequest,
    ).toHaveBeenCalledWith(exactRecording.id, {
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    });
    expect(routeMocks.getCaptureRecording).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
  });

  it("does not widen a similar unsupported owner scope", async () => {
    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=Readable`,
    ), route);

    await expect(response.json()).resolves.toEqual({
      recording: exactRecording,
      requestReadContracts: { captureRecordingDetail: "exact_v1" },
    });
    expect(routeMocks.getCaptureRecording).toHaveBeenCalledWith(
      exactRecording.id,
      context,
    );
    expect(
      routeMocks.getCaptureRecordingMetadataForRequest,
    ).not.toHaveBeenCalled();
  });

  it("returns a private generic conflict for ambiguous readable metadata", async () => {
    routeMocks.getCaptureRecordingMetadataForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureRecordingReadConflictError("private owner detail"),
    );

    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=readable`,
    ), route);

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Capture recording metadata could not be resolved safely.",
    });
  });

  it("keeps a missing readable recording private", async () => {
    routeMocks.getCaptureRecordingMetadataForRequest.mockResolvedValueOnce(
      undefined,
    );

    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=readable`,
    ), route);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Recording not found.",
    });
  });

  it("preserves typed capture errors for readable metadata", async () => {
    routeMocks.getCaptureRecordingMetadataForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureRecordingError(
        "Recording not found.",
        404,
        "recording_not_found",
      ),
    );

    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=readable`,
    ), route);

    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Recording not found.",
      code: "recording_not_found",
    });
  });

  it("logs only the error class for an unexpected readable failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.getCaptureRecordingMetadataForRequest.mockRejectedValueOnce(
      new Error("sensitive database detail"),
    );

    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=readable`,
    ), route);

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Capture recording metadata is temporarily unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Capture recording metadata read failed.",
      "Error",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    consoleError.mockRestore();
  });

  it("preserves the established bare GET error behavior", async () => {
    routeMocks.getCaptureRecording.mockRejectedValueOnce(
      new Error("exact recording read failed"),
    );

    const response = await GET(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}`,
    ), route);

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({
      error: "exact recording read failed",
    });
  });

  it("keeps PATCH exact even when the URL carries the readable opt-in", async () => {
    const response = await PATCH(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=readable`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Current title" }),
      },
    ), route);

    expect(response.status).toBe(200);
    expect(routeMocks.updateCaptureRecording).toHaveBeenCalledWith(
      exactRecording.id,
      { ...context, executionScope },
      { title: "Current title" },
    );
    expect(
      routeMocks.getCaptureRecordingMetadataForRequest,
    ).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("keeps DELETE pre-read and mutation exact with the readable query present", async () => {
    const response = await DELETE(new Request(
      `http://localhost/api/capture/recordings/${exactRecording.id}?ownerScope=readable`,
      { method: "DELETE" },
    ), route);

    expect(response.status).toBe(200);
    expect(routeMocks.getCaptureRecording).toHaveBeenCalledWith(
      exactRecording.id,
      context,
    );
    expect(routeMocks.deleteCaptureRecording).toHaveBeenCalledWith(
      exactRecording.id,
      { ...context, executionScope },
    );
    expect(
      routeMocks.getCaptureRecordingMetadataForRequest,
    ).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });
});
