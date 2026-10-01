import { beforeEach, describe, expect, it, vi } from "vitest";
import { SecurityPolicyError } from "@/lib/security/context";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getReleaseEvidenceReport: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));
vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: mocks.authorizeRequest,
}));
vi.mock("@/lib/release/evidence", () => ({
  getReleaseEvidenceReport: mocks.getReleaseEvidenceReport,
}));
vi.mock("@/lib/observability/store", () => ({
  createRequestTelemetry: () => ({
    requestId: "request-1",
    correlationId: "correlation-1",
    syntheticMetadata: { synthetic: true, syntheticSource: "release", sloExcluded: false },
  }),
  recordRuntimeEventSafely: mocks.recordRuntimeEventSafely,
}));

import { GET } from "@/app/api/release/evidence/route";

const REASON = "Ships the fix for failing runs.";

function evidence(exception?: { reason: string; applied: boolean }) {
  return {
    deployment: { commitSha: "release-sha" },
    releaseGate: {
      approved: true,
      status: "passed",
      summary: { failures: 0, warnings: 0 },
    },
    gates: [{
      id: "agent_error_budget",
      name: "Agent error budget",
      status: "pass",
      summary: "No error budget is spent this week.",
      details: exception ? { exception } : {},
    }],
  };
}

function exceptionEvents() {
  return mocks.recordRuntimeEventSafely.mock.calls
    .map(([event]) => event)
    .filter((event) => event.action === "release.agent_error_budget.exception_applied");
}

beforeEach(() => {
  mocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "tenant-a",
    actorId: "owner-a",
    role: "admin",
    source: "session",
  });
  mocks.getReleaseEvidenceReport.mockReset().mockResolvedValue(evidence());
  mocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
});

describe("release evidence route", () => {
  it("refuses an exception that is not one bounded line", async () => {
    for (const reason of ["first line\nsecond line", "a".repeat(201)]) {
      const response = await GET(new Request(
        `http://asael.test/api/release/evidence?errorBudgetException=${encodeURIComponent(reason)}`,
      ));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "An error budget exception is one line of at most 200 characters.",
      });
    }
    expect(mocks.getReleaseEvidenceReport).not.toHaveBeenCalled();
  });

  it("passes a named exception to the report and records who applied it", async () => {
    mocks.getReleaseEvidenceReport.mockResolvedValue(
      evidence({ reason: REASON, applied: true }),
    );

    const response = await GET(new Request(
      `http://asael.test/api/release/evidence?refresh=true&errorBudgetException=${encodeURIComponent(` ${REASON} `)}`,
    ));

    expect(response.status).toBe(200);
    expect(mocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "read.security",
      resourceType: "release_evidence",
    }));
    expect(mocks.getReleaseEvidenceReport).toHaveBeenCalledWith("tenant-a", {
      force: true,
      expectedWorkerTarget: "http://asael.test",
      requireActiveWorkerHeartbeats: false,
      workerHeartbeatNotBefore: undefined,
      errorBudgetException: REASON,
    });
    expect(exceptionEvents()).toEqual([{
      level: "warn",
      category: "security",
      action: "release.agent_error_budget.exception_applied",
      requestId: "request-1",
      correlationId: "correlation-1",
      tenantId: "tenant-a",
      actorId: "owner-a",
      resourceType: "release_evidence",
      message: "Approved a release while its error budget is spent.",
      metadata: {
        reason: REASON,
        revision: "release-sha",
        synthetic: true,
        syntheticSource: "release",
        // A decision is never counted as traffic, even from a smoke.
        sloExcluded: true,
      },
    }]);
  });

  it("records nothing when the exception had nothing to excuse", async () => {
    mocks.getReleaseEvidenceReport.mockResolvedValue(
      evidence({ reason: REASON, applied: false }),
    );

    const response = await GET(new Request(
      `http://asael.test/api/release/evidence?errorBudgetException=${encodeURIComponent(REASON)}`,
    ));

    expect(response.status).toBe(200);
    expect(exceptionEvents()).toEqual([]);
    expect(mocks.recordRuntimeEventSafely).toHaveBeenCalledWith(expect.objectContaining({
      action: "release.evidence.read",
    }));

    mocks.getReleaseEvidenceReport.mockResolvedValue(evidence());
    await GET(new Request("http://asael.test/api/release/evidence"));
    expect(mocks.getReleaseEvidenceReport).toHaveBeenLastCalledWith(
      "tenant-a",
      expect.objectContaining({ errorBudgetException: undefined }),
    );
    expect(exceptionEvents()).toEqual([]);
  });

  it("refuses a caller who cannot read security evidence", async () => {
    mocks.authorizeRequest.mockRejectedValue(
      new SecurityPolicyError("Administrator role required.", 403),
    );

    const response = await GET(new Request(
      `http://asael.test/api/release/evidence?errorBudgetException=${encodeURIComponent(REASON)}`,
    ));

    expect(response.status).toBe(403);
    expect(mocks.getReleaseEvidenceReport).not.toHaveBeenCalled();
    expect(mocks.recordRuntimeEventSafely).not.toHaveBeenCalled();
  });
});
