import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(async () => ({ tenantId: "tenant-operator-tick" })),
  processWorkflowQueue: vi.fn(async () => ({ requested: 1, leased: 1, jobs: [] })),
  getWorkflowRunDetail: vi.fn(async () => null),
  getOperationJobStats: vi.fn(async () => ({ queued: 0 })),
}));

vi.mock("@/lib/security/guard", () => ({
  authorizeRequest: mocks.authorizeRequest,
  forbiddenResponse: (error: unknown) => {
    throw error;
  },
}));
vi.mock("@/lib/workflows/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/queue")>()),
  processWorkflowQueue: mocks.processWorkflowQueue,
}));
vi.mock("@/lib/workflows/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/store")>()),
  getWorkflowRunDetail: mocks.getWorkflowRunDetail,
}));
vi.mock("@/lib/operations/job-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/job-queue")>()),
  getOperationJobStats: mocks.getOperationJobStats,
}));

import { POST } from "@/app/api/workflows/[id]/tick/route";

const requestedAt = Date.parse("2026-09-30T12:00:00.000Z");

describe("operator workflow tick", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-operator-tick-"),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(requestedAt);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops the tick 10 seconds before the route's 60 seconds run out", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const now = vi.spyOn(performance, "now");
    // The request has run for 3 seconds when the tick starts.
    now.mockReturnValueOnce(1_000).mockReturnValue(4_000);
    let response: Response;
    let timeoutCalls: unknown[][];
    try {
      response = await POST(
        new Request("http://localhost/api/workflows/run-1/tick", { method: "POST" }),
        { params: Promise.resolve({ id: "run-1" }) },
      );
    } finally {
      timeoutCalls = [...timeout.mock.calls];
      now.mockRestore();
      timeout.mockRestore();
    }

    expect(response.status).toBe(200);
    expect(timeoutCalls).toEqual([[47_000]]);
    expect(mocks.processWorkflowQueue.mock.calls).toEqual([[{
      workflowRunId: "run-1",
      limit: 1,
      bootstrapQueuedRuns: false,
      tenantId: "tenant-operator-tick",
      abortSignal: deadline.signal,
      deadlineAt: requestedAt + 47_000,
      keepQueuePlaceOnDeadline: true,
    }]]);
  });
});
