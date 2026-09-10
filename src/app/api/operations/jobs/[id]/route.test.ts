import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  getOperationJob: vi.fn(),
  projectOperationJobStatus: vi.fn(),
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
}));

import { GET } from "@/app/api/operations/jobs/[id]/route";

const context = {
  tenantId: "tenant-a",
  actorId: "owner-a",
  role: "admin" as const,
  source: "session" as const,
};

beforeEach(() => {
  routeMocks.authorizeRequest.mockReset().mockResolvedValue(context);
  routeMocks.getOperationJob.mockReset();
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
