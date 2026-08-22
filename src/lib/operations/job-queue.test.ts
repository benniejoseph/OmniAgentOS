import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
    const leasedJob = leased.find((item) => item.id === job.id);
    expect(leasedJob?.status).toBe("running");

    const completed = await queue.completeOperationJob(
      job.id,
      leasedJob?.leaseOwner,
      leasedJob?.tenantId,
    );
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

  it("preserves a wake-up requested during an active lease", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-active-wakeup";
    const first = await queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      dedupeKey: "active-wakeup",
      payload: { workflowRunId: "workflow-active", reason: "initial" },
    });
    const [leased] = await queue.leaseOperationJobs({
      tenantId,
      dedupeKey: "active-wakeup",
      owner: "worker-active",
    });
    expect(leased.id).toBe(first.id);

    const woken = await queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      dedupeKey: "active-wakeup",
      payload: { workflowRunId: "workflow-active", reason: "new-signal" },
    });
    expect(woken).toMatchObject({ id: first.id, status: "running" });

    const completed = await queue.completeOperationJob(
      first.id,
      "worker-active",
      tenantId,
    );
    expect(completed).toMatchObject({
      id: first.id,
      status: "queued",
      attempt: 0,
      payload: {
        workflowRunId: "workflow-active",
        reason: "new-signal",
      },
    });
    expect(completed?.payload).not.toHaveProperty("__rerunRequested");
    await expect(
      queue.leaseOperationJobs({
        tenantId,
        dedupeKey: "active-wakeup",
        owner: "worker-next",
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: first.id, status: "running" }),
    ]);
  });

  it("retries failed jobs until attempts are exhausted", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const job = await queue.enqueueOperationJob({
      type: "workflow.tick",
      dedupeKey: "wf-retry",
      payload: { workflowRunId: "wf-retry" },
      maxAttempts: 2,
    });

    const leased = await queue.leaseOperationJobs({ limit: 10 });
    const leasedJob = leased.find((item) => item.id === job.id);
    const failedOnce = await queue.failOperationJob(
      job.id,
      "first failure",
      leasedJob?.leaseOwner,
      leasedJob?.tenantId,
    );
    expect(failedOnce?.status).toBe("queued");
    expect(failedOnce?.lastError).toBe("first failure");
    // Retry backoff pushes the next attempt into the future.
    expect(Date.parse(failedOnce?.runAt || "")).toBeGreaterThan(Date.now());
  });

  it("redelivers an expired final workflow attempt for terminal reconciliation", async () => {
    const queue = await import("@/lib/operations/job-queue");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
    try {
      const job = await queue.enqueueOperationJob({
        tenantId: "tenant-final-reconcile",
        type: "workflow.tick",
        dedupeKey: "workflow-final-reconcile",
        payload: { workflowRunId: "workflow-final-reconcile" },
        maxAttempts: 1,
      });
      const [leased] = await queue.leaseOperationJobs({
        tenantId: "tenant-final-reconcile",
        dedupeKey: "workflow-final-reconcile",
        leaseSeconds: 10,
      });
      expect(leased.id).toBe(job.id);
      vi.advanceTimersByTime(11_000);

      await expect(
        queue.repairExpiredOperationJobs({
          tenantId: "tenant-final-reconcile",
        }),
      ).resolves.toBe(1);
      const [redelivered] = await queue.leaseOperationJobs({
        tenantId: "tenant-final-reconcile",
        dedupeKey: "workflow-final-reconcile",
        leaseSeconds: 10,
      });
      expect(redelivered).toMatchObject({
        id: job.id,
        status: "running",
        attempt: 2,
        maxAttempts: 1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers and wakes durable agent continuations without spending attempts", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-agent-resume";
    const dedupeKey = queue.getAgentResumeJobDedupeKey("execution-1");
    const job = await queue.enqueueOperationJob({
      tenantId,
      type: "agent.resume",
      dedupeKey,
      payload: { agentRunId: "run-1", executionId: "execution-1" },
    });
    const [leased] = await queue.leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      dedupeKey,
    });
    expect(leased.id).toBe(job.id);
    const deferred = await queue.deferOperationJob(
      job.id,
      leased.leaseOwner!,
      { tenantId, delaySeconds: 60 },
    );
    expect(deferred).toMatchObject({ status: "queued", attempt: 0 });
    expect(Date.parse(deferred!.runAt)).toBeGreaterThan(Date.now());

    const [woken] = await queue.wakeOperationJobByDedupeKey(dedupeKey, {
      tenantId,
    });
    expect(woken).toMatchObject({ id: job.id, status: "queued" });
    expect(Date.parse(woken.runAt)).toBeLessThanOrEqual(Date.now());
  });

  it("partitions dedupe keys and leases by tenant", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantA = await queue.enqueueOperationJob({
      tenantId: "tenant-a",
      type: "workflow.tick",
      dedupeKey: "shared-key",
      payload: { workflowRunId: "workflow-a" },
    });
    const tenantB = await queue.enqueueOperationJob({
      tenantId: "tenant-b",
      type: "workflow.tick",
      dedupeKey: "shared-key",
      payload: { workflowRunId: "workflow-b" },
    });

    expect(tenantA.id).not.toBe(tenantB.id);
    expect(
      await queue.leaseOperationJobs({ tenantId: "tenant-a", limit: 10 }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: tenantA.id, tenantId: "tenant-a" }),
      ]),
    );
    expect(
      (await queue.listOperationJobs(100, { tenantId: "tenant-a" })).some(
        (job) => job.id === tenantB.id,
      ),
    ).toBe(false);
  });

  it("requires the current tenant lease owner for heartbeat and completion", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-fence";
    const job = await queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      dedupeKey: "fenced-job",
      payload: { workflowRunId: "workflow-fenced" },
    });
    const [leased] = await queue.leaseOperationJobs({
      tenantId,
      dedupeKey: "fenced-job",
      owner: "worker-a",
    });

    expect(leased.id).toBe(job.id);
    await expect(queue.heartbeatOperationJob(job.id, "worker-b", { tenantId })).resolves.toBeNull();
    await expect(queue.completeOperationJob(job.id)).resolves.toBeNull();
    await expect(queue.completeOperationJob(job.id, "worker-a", "other-tenant")).resolves.toBeNull();
    await expect(
      queue.heartbeatOperationJob(job.id, "worker-a", { tenantId, leaseSeconds: 60 }),
    ).resolves.toMatchObject({ status: "running", leaseOwner: "worker-a" });
    await expect(queue.completeOperationJob(job.id, "worker-a", tenantId)).resolves.toMatchObject({
      status: "completed",
    });
  });
});
