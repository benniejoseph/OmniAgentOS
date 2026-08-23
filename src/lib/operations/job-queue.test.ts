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

  it("preserves retry attempts and backoff when bootstrap sees a queued dedupe key", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-preserve-backoff";
    const job = await queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      dedupeKey: "preserve-backoff",
      payload: { workflowRunId: "workflow-preserve-backoff" },
      maxAttempts: 3,
    });
    const [leased] = await queue.leaseOperationJobs({
      tenantId,
      dedupeKey: job.dedupeKey,
    });
    const failed = await queue.failOperationJob(
      job.id,
      "transient",
      leased.leaseOwner,
      tenantId,
    );

    const bootstrapped = await queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      dedupeKey: "preserve-backoff",
      payload: { workflowRunId: "workflow-preserve-backoff" },
      maxAttempts: 3,
    });

    expect(bootstrapped).toMatchObject({
      id: job.id,
      status: "queued",
      attempt: 1,
      runAt: failed?.runAt,
    });
  });

  it("reuses a completed idempotent job without requeueing it", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-idempotent-terminal";
    const job = await queue.enqueueOperationJob({
      tenantId,
      type: "knowledge.ingest",
      dedupeKey: "ingest:one",
      payload: { request: { title: "One" } },
      requeueTerminal: false,
    });
    const [leased] = await queue.leaseOperationJobs({
      tenantId,
      dedupeKey: job.dedupeKey,
    });
    await queue.completeOperationJob(job.id, leased.leaseOwner, tenantId);

    const reused = await queue.enqueueOperationJob({
      tenantId,
      type: "knowledge.ingest",
      dedupeKey: "ingest:one",
      payload: { request: { title: "One" } },
      requeueTerminal: false,
    });

    expect(reused).toMatchObject({
      id: job.id,
      status: "completed",
      attempt: 1,
    });
  });

  it("requeues failed idempotent work without rerunning completed work", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-retry-failed-terminal";
    const input = {
      tenantId,
      type: "knowledge.ingest" as const,
      dedupeKey: "ingest:retry-failed",
      payload: { request: { title: "Retry failed ingestion" } },
      maxAttempts: 1,
      requeueTerminal: false,
      requeueFailed: true,
    };
    const job = await queue.enqueueOperationJob(input);
    const [leased] = await queue.leaseOperationJobs({
      tenantId,
      dedupeKey: input.dedupeKey,
    });
    const failed = await queue.failOperationJob(
      job.id,
      "terminal failure",
      leased.leaseOwner,
      tenantId,
    );
    expect(failed?.status).toBe("failed");

    const retried = await queue.enqueueOperationJob(input);
    expect(retried).toMatchObject({
      id: job.id,
      status: "queued",
      attempt: 0,
      payload: input.payload,
    });
  });

  it("preserves active and completed work for transport-idempotent retries", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-transport-idempotency";
    const input = {
      tenantId,
      type: "evaluation.run" as const,
      dedupeKey: "evaluation:transport-request",
      payload: { request: { suite: "core" } },
      dedupeMode: "idempotent" as const,
    };
    const queued = await queue.enqueueOperationJob(input);
    const [running] = await queue.leaseOperationJobs({
      tenantId,
      dedupeKey: input.dedupeKey,
      owner: "worker-a",
    });

    const activeRetry = await queue.enqueueOperationJob({
      ...input,
      payload: { request: { suite: "replacement" } },
    });
    expect(activeRetry).toMatchObject({
      id: queued.id,
      status: "running",
      payload: input.payload,
    });
    expect(activeRetry.payload.__rerunRequested).toBeUndefined();

    await queue.completeOperationJob(queued.id, running.leaseOwner, tenantId);
    const completedRetry = await queue.enqueueOperationJob(input);
    expect(completedRetry).toMatchObject({
      id: queued.id,
      status: "completed",
    });
  });

  it("ages older runnable work so sustained priority cannot starve it", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-priority-aging";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
    try {
      const older = await queue.enqueueOperationJob({
        tenantId,
        type: "knowledge.ingest",
        payload: { request: { title: "older" } },
        priority: 0,
      });
      vi.advanceTimersByTime(11 * 60 * 1_000);
      await queue.enqueueOperationJob({
        tenantId,
        type: "knowledge.ingest",
        payload: { request: { title: "newer" } },
        priority: 10,
      });

      const [leased] = await queue.leaseOperationJobs({
        tenantId,
        types: ["knowledge.ingest"],
        limit: 1,
      });
      expect(leased.id).toBe(older.id);
    } finally {
      vi.useRealTimers();
    }
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
