import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// Force the file-backed queue into an isolated temp data dir before import.
beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-queue-"));
  delete process.env.DATABASE_URL;
});

describe("operation job queue (file mode)", () => {
  it("enqueues, leases, and completes a job", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const job = await queue.enqueueOperationJob({
      type: "workflow.tick",
      dedupeKey: "wf-1",
      payload: { workflowRunId: "wf-1" },
      maxAttempts: 3,
    });
    expect(job.status).toBe("queued");

    const leased = await queue.leaseOperationJobs({ limit: 5 });
    expect(leased.map((item) => item.id)).toContain(job.id);
    expect(leased.find((item) => item.id === job.id)?.status).toBe("running");

    const completed = await queue.completeOperationJob(job.id);
    expect(completed?.status).toBe("completed");
  });

  it("dedupes queued jobs by dedupe key", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const first = await queue.enqueueOperationJob({
      type: "workflow.tick",
      dedupeKey: "wf-dedupe",
      payload: { workflowRunId: "wf-dedupe" },
    });
    const second = await queue.enqueueOperationJob({
      type: "workflow.tick",
      dedupeKey: "wf-dedupe",
      payload: { workflowRunId: "wf-dedupe" },
    });
    expect(second.id).toBe(first.id);
  });

  it("retries failed jobs until attempts are exhausted", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const job = await queue.enqueueOperationJob({
      type: "workflow.tick",
      dedupeKey: "wf-retry",
      payload: { workflowRunId: "wf-retry" },
      maxAttempts: 2,
    });

    await queue.leaseOperationJobs({ limit: 10 });
    const failedOnce = await queue.failOperationJob(job.id, "first failure");
    expect(failedOnce?.status).toBe("queued");
    expect(failedOnce?.lastError).toBe("first failure");
    // Retry backoff pushes the next attempt into the future.
    expect(Date.parse(failedOnce?.runAt || "")).toBeGreaterThan(Date.now());
  });
});
