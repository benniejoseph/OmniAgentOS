import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getOperationJob: vi.fn(),
  projectOperationJobStatus: vi.fn(),
  releaseQuarantinedOperationJob: vi.fn(),
  discardQuarantinedOperationJob: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  withDatabaseRequestScope:
    (handler: (...args: never[]) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/operations/job-queue", () => ({
  getOperationJob: routeMocks.getOperationJob,
  projectOperationJobStatus: routeMocks.projectOperationJobStatus,
  releaseQuarantinedOperationJob: routeMocks.releaseQuarantinedOperationJob,
  discardQuarantinedOperationJob: routeMocks.discardQuarantinedOperationJob,
}));

vi.mock("@/lib/observability/store", () => ({
  createRequestTelemetry: () => ({ requestId: "request-a", correlationId: "correlation-a" }),
  recordRuntimeEventSafely: routeMocks.recordRuntimeEventSafely,
}));

import { GET, POST } from "@/app/api/operations/jobs/[id]/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner-a",
  role: "admin" as const,
  source: "session" as const,
};

const authUserId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.getOperationJob.mockReset();
  routeMocks.releaseQuarantinedOperationJob.mockReset();
  routeMocks.discardQuarantinedOperationJob.mockReset();
  routeMocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
  routeMocks.projectOperationJobStatus.mockReset().mockImplementation((job) => ({
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.payload.progress,
  }));
});

describe("operation job detail route", () => {
  it("returns content-free progress for the exact Capture asset owner", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce({
      id: "job-a",
      tenantId: context.tenantId,
      type: "capture.asset.process",
      status: "running",
      payload: {
        actorId: context.actorId,
        request: { note: "private transcript" },
        progress: { stage: "embedding", chunkCount: 12 },
      },
    });

    const response = await GET(
      new Request("http://localhost/api/operations/jobs/job-a"),
      { params: Promise.resolve({ id: "job-a" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.job).toEqual({
      id: "job-a",
      type: "capture.asset.process",
      status: "running",
      progress: { stage: "embedding", chunkCount: 12 },
    });
    expect(JSON.stringify(body)).not.toContain("private transcript");
  });

  it("does not reveal an exact-owner Capture job to another actor", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce({
      id: "job-a",
      tenantId: context.tenantId,
      type: "capture.asset.process",
      status: "queued",
      payload: { actorId: "owner-b", progress: { stage: "queued" } },
    });

    const response = await GET(
      new Request("http://localhost/api/operations/jobs/job-a"),
      { params: Promise.resolve({ id: "job-a" }) },
    );

    expect(response.status).toBe(404);
    expect(routeMocks.projectOperationJobStatus).not.toHaveBeenCalled();
  });

  it("does not reveal any actor-owned background job to another actor", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce({
      id: "job-cognition",
      tenantId: context.tenantId,
      type: "knowledge.cognify",
      status: "running",
      payload: {
        actorId: "owner-b",
        request: { documentId: "private-document" },
        progress: { stage: "cognifying", batchIndex: 0 },
      },
    });

    const response = await GET(
      new Request("http://localhost/api/operations/jobs/job-cognition"),
      { params: Promise.resolve({ id: "job-cognition" }) },
    );

    expect(response.status).toBe(404);
    expect(routeMocks.projectOperationJobStatus).not.toHaveBeenCalled();
  });

  it("keeps semantic summary enrichment jobs actor-private", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce({
      id: "job-semantic-summary",
      tenantId: context.tenantId,
      type: "conversation.summary.enrich",
      status: "running",
      payload: {
        actorId: "owner-b",
        request: { episodeSummaryId: "private-episode-summary" },
        progress: { stage: "generating_enrichment" },
      },
    });

    const response = await GET(
      new Request(
        "http://localhost/api/operations/jobs/job-semantic-summary",
      ),
      { params: Promise.resolve({ id: "job-semantic-summary" }) },
    );

    expect(response.status).toBe(404);
    expect(routeMocks.projectOperationJobStatus).not.toHaveBeenCalled();
  });

  it("returns only allowlisted semantic enrichment progress", async () => {
    const job = {
      id: "job-semantic-summary",
      tenantId: context.tenantId,
      type: "conversation.summary.enrich",
      status: "running",
      payload: {
        actorId: context.actorId,
        request: { episodeSummaryId: "private-episode-summary" },
        progress: { stage: "generating" },
      },
    };
    routeMocks.getOperationJob.mockResolvedValueOnce(job);
    routeMocks.projectOperationJobStatus.mockReturnValueOnce({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: {
        stage: "generating_enrichment",
        shadowOnly: true,
        statementCount: 7,
        outcome: "private_provider_outcome",
        prompt: "private conversation prompt",
        providerTrace: "private model internals",
      },
      result: { generatedText: "private summary" },
      lastError: "private provider response",
      priority: 0,
      attempt: 1,
      maxAttempts: 3,
      runAt: "2026-09-11T05:00:00.000Z",
      createdAt: "2026-09-11T05:00:00.000Z",
      updatedAt: "2026-09-11T05:01:00.000Z",
    });

    const response = await GET(
      new Request(
        "http://localhost/api/operations/jobs/job-semantic-summary",
      ),
      { params: Promise.resolve({ id: "job-semantic-summary" }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.job).toMatchObject({
      id: job.id,
      type: job.type,
      status: "running",
      progress: {
        stage: "generating_enrichment",
        shadowOnly: true,
        statementCount: 7,
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /private conversation|model internals|provider response|generatedText/i,
    );
  });

  it("recognizes the canonical owner bound to the signed-in actor", async () => {
    const signedInContext = {
      ...context,
      actorId: "owner-a@example.test",
      source: "session" as const,
      auth: {
        userId: authUserId,
        email: "owner-a@example.test",
        sessionId: "session-a",
        tenantName: "Tenant A",
      },
    };
    routeMocks.authorizeRequest.mockResolvedValueOnce(signedInContext);
    routeMocks.getOperationJob.mockResolvedValueOnce({
      id: "job-canonical-owner",
      tenantId: context.tenantId,
      type: "conversation.summary.enrich",
      status: "queued",
      payload: {
        actorId: `actor:${authUserId}`,
        progress: { stage: "queued", shadowOnly: true },
      },
    });
    routeMocks.projectOperationJobStatus.mockReturnValueOnce({
      id: "job-canonical-owner",
      type: "conversation.summary.enrich",
      status: "queued",
      progress: { stage: "queued", shadowOnly: true },
      priority: 0,
      attempt: 0,
      maxAttempts: 3,
      runAt: "2026-09-11T05:00:00.000Z",
      createdAt: "2026-09-11T05:00:00.000Z",
      updatedAt: "2026-09-11T05:00:00.000Z",
    });

    const response = await GET(
      new Request("http://localhost/api/operations/jobs/job-canonical-owner"),
      { params: Promise.resolve({ id: "job-canonical-owner" }) },
    );

    expect(response.status).toBe(200);
  });

  it("keeps completed semantic enrichment explicitly shadow-only", async () => {
    const job = {
      id: "job-semantic-summary-completed",
      tenantId: context.tenantId,
      type: "conversation.summary.enrich",
      status: "completed",
      payload: { actorId: context.actorId, progress: { stage: "completed" } },
    };
    routeMocks.getOperationJob.mockResolvedValueOnce(job);
    routeMocks.projectOperationJobStatus.mockReturnValueOnce({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: {
        stage: "completed",
        outcome: "already_current",
        completedAt: "private-detail",
      },
      result: { summary: "private semantic output" },
      priority: 0,
      attempt: 1,
      maxAttempts: 3,
      runAt: "2026-09-11T05:00:00.000Z",
      createdAt: "2026-09-11T05:00:00.000Z",
      updatedAt: "2026-09-11T05:01:00.000Z",
      completedAt: "2026-09-11T05:01:00.000Z",
    });

    const response = await GET(
      new Request(
        "http://localhost/api/operations/jobs/job-semantic-summary-completed",
      ),
      { params: Promise.resolve({ id: job.id }) },
    );
    const body = await response.json();

    expect(body.job.progress).toEqual({
      stage: "completed",
      shadowOnly: true,
      outcome: "already_current",
    });
    expect(JSON.stringify(body)).not.toContain("private semantic output");
  });

  it("returns a fixed safe failure code without provider errors", async () => {
    const job = {
      id: "job-semantic-summary-failed",
      tenantId: context.tenantId,
      type: "conversation.summary.enrich",
      status: "failed",
      payload: {
        actorId: context.actorId,
        progress: { stage: "provider_timeout", providerMessage: "private" },
      },
      lastError: "private provider rejection with request contents",
    };
    routeMocks.getOperationJob.mockResolvedValueOnce(job);
    routeMocks.projectOperationJobStatus.mockReturnValueOnce({
      id: job.id,
      type: job.type,
      status: job.status,
      progress: job.payload.progress,
      lastError: job.lastError,
      priority: 0,
      attempt: 3,
      maxAttempts: 3,
      runAt: "2026-09-11T05:00:00.000Z",
      createdAt: "2026-09-11T05:00:00.000Z",
      updatedAt: "2026-09-11T05:01:00.000Z",
    });

    const response = await GET(
      new Request(
        "http://localhost/api/operations/jobs/job-semantic-summary-failed",
      ),
      { params: Promise.resolve({ id: job.id }) },
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.job).toMatchObject({
      status: "failed",
      failureCode: "semantic_enrichment_failed",
      progress: { stage: "pending", shadowOnly: true },
    });
    expect(JSON.stringify(body)).not.toMatch(/private|provider rejection/i);
  });

  it("fails closed when an actor-owned job has no actor binding", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce({
      id: "job-cognition-unbound",
      tenantId: context.tenantId,
      type: "knowledge.cognify",
      status: "running",
      payload: { progress: { stage: "extracting_candidates", batchIndex: 0 } },
    });

    const response = await GET(
      new Request("http://localhost/api/operations/jobs/job-cognition-unbound"),
      { params: Promise.resolve({ id: "job-cognition-unbound" }) },
    );

    expect(response.status).toBe(404);
    expect(routeMocks.projectOperationJobStatus).not.toHaveBeenCalled();
  });

  it("preserves tenant-scoped job status without an actor binding", async () => {
    const tenantJob = {
      id: "job-tenant-maintenance",
      tenantId: context.tenantId,
      type: "memory.consolidate",
      status: "queued",
      payload: { progress: { stage: "queued" } },
    };
    routeMocks.getOperationJob.mockResolvedValueOnce(tenantJob);

    const response = await GET(
      new Request("http://localhost/api/operations/jobs/job-tenant-maintenance"),
      { params: Promise.resolve({ id: "job-tenant-maintenance" }) },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.projectOperationJobStatus).toHaveBeenCalledWith(tenantJob);
  });
});

describe("operation job quarantine decision route", () => {
  const quarantined = {
    id: "job-q",
    tenantId: context.tenantId,
    type: "memory.consolidate",
    status: "quarantined",
    payload: { progress: { stage: "indexing" } },
  };

  function decide(body: unknown, id = "job-q") {
    return POST(
      new Request(`http://localhost/api/operations/jobs/${id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({ id }) },
    );
  }

  it("releases a quarantined job for the operator's tenant and records the decision", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce(quarantined);
    routeMocks.releaseQuarantinedOperationJob.mockResolvedValueOnce({
      outcome: "released",
      job: { ...quarantined, status: "queued" },
    });

    const response = await decide({ action: "release" });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      outcome: "released",
      job: { id: "job-q", type: "memory.consolidate", status: "queued", progress: { stage: "indexing" } },
    });
    expect(routeMocks.authorizeRequest).toHaveBeenCalledWith(expect.objectContaining({
      action: "manage.workflow",
      resourceType: "operation_job",
      resourceId: "job-q",
    }));
    expect(routeMocks.getOperationJob).toHaveBeenCalledWith("job-q", { tenantId: "tenant-a" });
    expect(routeMocks.releaseQuarantinedOperationJob).toHaveBeenCalledWith("job-q", {
      tenantId: "tenant-a",
      actorId: "owner-a",
    });
    expect(routeMocks.discardQuarantinedOperationJob).not.toHaveBeenCalled();
    expect(routeMocks.recordRuntimeEventSafely).toHaveBeenCalledWith(expect.objectContaining({
      action: "operations.job.release",
      statusCode: 200,
      tenantId: "tenant-a",
      metadata: { action: "release", outcome: "released" },
    }));
  });

  it("discards with the operator's reason", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce(quarantined);
    routeMocks.discardQuarantinedOperationJob.mockResolvedValueOnce({
      outcome: "discarded",
      job: { ...quarantined, status: "canceled" },
    });

    const response = await decide({ action: "discard", reason: " poison input " });

    expect(response.status).toBe(200);
    expect((await response.json()).outcome).toBe("discarded");
    expect(routeMocks.discardQuarantinedOperationJob).toHaveBeenCalledWith("job-q", {
      tenantId: "tenant-a",
      actorId: "owner-a",
      reason: "poison input",
    });
    expect(routeMocks.releaseQuarantinedOperationJob).not.toHaveBeenCalled();
  });

  it("rejects an unknown action or extra fields before deciding anything", async () => {
    for (const body of [{ action: "requeue" }, { action: "release", force: true }, { action: "discard", reason: " " }]) {
      const response = await decide(body);
      expect(response.status).toBe(400);
    }
    expect(routeMocks.authorizeRequest).not.toHaveBeenCalled();
    expect(routeMocks.releaseQuarantinedOperationJob).not.toHaveBeenCalled();
    expect(routeMocks.discardQuarantinedOperationJob).not.toHaveBeenCalled();
  });

  it("does not decide a job the operator cannot read", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce({
      ...quarantined,
      type: "knowledge.cognify",
      payload: { actorId: "owner-b", progress: { stage: "queued" } },
    });

    const response = await decide({ action: "release" });

    expect(response.status).toBe(404);
    expect(routeMocks.releaseQuarantinedOperationJob).not.toHaveBeenCalled();
  });

  it("is not found when the job is missing or vanishes before the decision", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce(undefined);
    expect((await decide({ action: "release" })).status).toBe(404);
    expect(routeMocks.releaseQuarantinedOperationJob).not.toHaveBeenCalled();

    routeMocks.getOperationJob.mockResolvedValueOnce(quarantined);
    routeMocks.releaseQuarantinedOperationJob.mockResolvedValueOnce({ outcome: "absent" });
    expect((await decide({ action: "release" })).status).toBe(404);
    expect(routeMocks.recordRuntimeEventSafely).toHaveBeenLastCalledWith(expect.objectContaining({
      statusCode: 404,
      metadata: { action: "release", outcome: "absent" },
    }));
  });

  it("refuses a job that is not quarantined and a run-owned discard", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce({ ...quarantined, status: "queued" });
    routeMocks.releaseQuarantinedOperationJob.mockResolvedValueOnce({
      outcome: "not_quarantined",
      job: { ...quarantined, status: "queued" },
    });
    const notQuarantined = await decide({ action: "release" });
    expect(notQuarantined.status).toBe(409);
    expect((await notQuarantined.json()).error).toBe("Operation job is not quarantined.");

    routeMocks.getOperationJob.mockResolvedValueOnce({ ...quarantined, type: "workflow.tick" });
    routeMocks.discardQuarantinedOperationJob.mockResolvedValueOnce({
      outcome: "owned_by_run",
      job: { ...quarantined, type: "workflow.tick" },
    });
    const owned = await decide({ action: "discard" });
    expect(owned.status).toBe(409);
    expect((await owned.json()).error).toBe("Cancel the run that owns this job to discard it.");
    expect(routeMocks.recordRuntimeEventSafely).toHaveBeenLastCalledWith(expect.objectContaining({
      statusCode: 409,
      metadata: { action: "discard", outcome: "owned_by_run" },
    }));
  });

  it("records a failed decision without leaking the error", async () => {
    routeMocks.getOperationJob.mockResolvedValueOnce(quarantined);
    routeMocks.releaseQuarantinedOperationJob.mockRejectedValueOnce(
      new Error("private database detail"),
    );

    const response = await decide({ action: "release" });

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("private database detail");
    expect(routeMocks.recordRuntimeEventSafely).toHaveBeenCalledWith(expect.objectContaining({
      level: "error",
      action: "operations.job.release.failed",
      statusCode: 500,
    }));
  });
});
