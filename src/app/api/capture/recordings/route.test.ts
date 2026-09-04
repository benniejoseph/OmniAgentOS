import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestCaptureRecordingSummary } from "@/lib/capture/types";

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
    constructor() {
      super("Capture recording ownership is ambiguous.");
      this.name = "CaptureRecordingReadConflictError";
    }
  }
  return {
    CaptureRecordingError,
    CaptureRecordingReadConflictError,
    authorizeRequest: vi.fn(),
    canonicalRequestActorBindingFromSecurityContext: vi.fn(),
    captureExecutionScopeFromSecurityContext: vi.fn(),
    createCaptureRecording: vi.fn(),
    listCaptureRecordings: vi.fn(),
    listCaptureRecordingsForRequest: vi.fn(),
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

vi.mock("@/lib/capture/execution-scope", () => ({
  captureExecutionScopeFromSecurityContext:
    routeMocks.captureExecutionScopeFromSecurityContext,
}));

vi.mock("@/lib/capture/recordings", () => ({
  CaptureRecordingError: routeMocks.CaptureRecordingError,
  CaptureRecordingReadConflictError:
    routeMocks.CaptureRecordingReadConflictError,
  createCaptureRecording: routeMocks.createCaptureRecording,
  listCaptureRecordings: routeMocks.listCaptureRecordings,
  listCaptureRecordingsForRequest:
    routeMocks.listCaptureRecordingsForRequest,
}));

import { GET, POST } from "@/app/api/capture/recordings/route";

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
const readableSummary: RequestCaptureRecordingSummary = {
  id: "recording-a",
  title: "Retained recording",
  status: "ready",
  startedAt: "2026-09-05T10:00:00.000Z",
  durationMs: 1_000,
  segmentCount: 1,
  updatedAt: "2026-09-05T10:01:00.000Z",
  metadataDetailAvailable: true,
  detailAvailable: false,
  manageable: false,
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.canonicalRequestActorBindingFromSecurityContext
    .mockReset()
    .mockReturnValue(requestActorBinding);
  routeMocks.captureExecutionScopeFromSecurityContext
    .mockReset()
    .mockReturnValue({ version: 1 });
  routeMocks.createCaptureRecording.mockReset().mockResolvedValue({
    id: "recording-a",
  });
  routeMocks.listCaptureRecordings.mockReset().mockResolvedValue([]);
  routeMocks.listCaptureRecordingsForRequest.mockReset().mockResolvedValue([]);
});

describe("Capture recording collection route", () => {
  it("keeps a bare GET on the exact full-recording reader", async () => {
    const response = await GET(
      new Request("http://localhost/api/capture/recordings?limit=6"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(routeMocks.listCaptureRecordings).toHaveBeenCalledWith(context, 6);
    await expect(response.json()).resolves.toEqual({
      recordings: [],
      requestReadContracts: { captureRecordings: "exact_v1" },
    });
    expect(routeMocks.listCaptureRecordingsForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("binds only the opt-in summary collection to the readable owner pair", async () => {
    routeMocks.listCaptureRecordingsForRequest.mockResolvedValue([
      readableSummary,
    ]);
    const response = await GET(new Request(
      "http://localhost/api/capture/recordings?limit=6&ownerScope=readable",
    ));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      recordings: [readableSummary],
      requestReadContracts: { captureRecordings: "readable_v1" },
    });
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).toHaveBeenCalledWith(context);
    expect(routeMocks.listCaptureRecordingsForRequest).toHaveBeenCalledWith({
      tenantId: context.tenantId,
      actorId: context.actorId,
      requestActorBinding,
    }, 6);
    expect(routeMocks.listCaptureRecordings).not.toHaveBeenCalled();
  });

  it("does not widen a similar unsupported owner scope", async () => {
    const response = await GET(new Request(
      "http://localhost/api/capture/recordings?ownerScope=Readable",
    ));

    await expect(response.json()).resolves.toEqual({
      recordings: [],
      requestReadContracts: { captureRecordings: "exact_v1" },
    });
    expect(routeMocks.listCaptureRecordings).toHaveBeenCalledWith(context, 50);
    expect(routeMocks.listCaptureRecordingsForRequest).not.toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
  });

  it("maps a summary integrity failure to a private controlled response", async () => {
    routeMocks.listCaptureRecordingsForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureRecordingReadConflictError(),
    );
    const response = await GET(new Request(
      "http://localhost/api/capture/recordings?ownerScope=readable",
    ));
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      error: "Capture recording history could not be verified.",
    });
  });

  it("preserves the existing controlled conflict for a bare collection read", async () => {
    routeMocks.listCaptureRecordings.mockRejectedValueOnce(
      new routeMocks.CaptureRecordingReadConflictError(),
    );

    const response = await GET(new Request(
      "http://localhost/api/capture/recordings",
    ));

    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Capture recording history could not be verified.",
    });
    expect(routeMocks.listCaptureRecordingsForRequest).not.toHaveBeenCalled();
  });

  it("preserves typed capture errors on the readable collection", async () => {
    routeMocks.listCaptureRecordingsForRequest.mockRejectedValueOnce(
      new routeMocks.CaptureRecordingError(
        "Capture recording identifier is invalid.",
        400,
        "invalid_capture_recording",
      ),
    );
    const response = await GET(new Request(
      "http://localhost/api/capture/recordings?ownerScope=readable",
    ));

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Capture recording identifier is invalid.",
      code: "invalid_capture_recording",
    });
  });

  it("logs only the error class for an unexpected readable failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.listCaptureRecordingsForRequest.mockRejectedValueOnce(
      new Error("sensitive database detail"),
    );

    const response = await GET(new Request(
      "http://localhost/api/capture/recordings?ownerScope=readable",
    ));

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.json()).resolves.toEqual({
      error: "Capture recording history is temporarily unavailable.",
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Capture recording history read failed.",
      "Error",
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      "sensitive database detail",
    );
    consoleError.mockRestore();
  });

  it("never derives a request-read binding for recording creation", async () => {
    const response = await POST(new Request(
      "http://localhost/api/capture/recordings",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Customer conversation" }),
      },
    ));
    expect(response.status).toBe(201);
    expect(routeMocks.createCaptureRecording).toHaveBeenCalled();
    expect(
      routeMocks.canonicalRequestActorBindingFromSecurityContext,
    ).not.toHaveBeenCalled();
    expect(routeMocks.listCaptureRecordingsForRequest).not.toHaveBeenCalled();
  });
});
