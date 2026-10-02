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
  it("redacts actor-private semantic enrichment details from status projections", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const projected = queue.projectOperationJobStatus({
      id: "semantic-private",
      tenantId: "tenant-semantic-private",
      type: "conversation.summary.enrich",
      status: "failed",
      payload: {
        actorId: "private-actor",
        progress: {
          stage: "completed",
          outcome: "enriched",
          statementCount: 7,
          sourceTurnCount: 12,
          generationLatencyMs: 4_321,
          privateProgress: "do-not-expose",
        },
        result: {
          status: "enriched",
          enrichmentId: "private-enrichment-id",
          sourceSha256: "private-source-hash",
          reason: "private supersession reason",
          statementCount: 7,
          sourceTurnCount: 12,
          generationLatencyMs: 4_321,
        },
      },
      priority: 0,
      attempt: 1,
      maxAttempts: 3,
      runAt: "2026-09-11T00:00:00.000Z",
      lastError: "provider returned private source content",
      createdAt: "2026-09-11T00:00:00.000Z",
      updatedAt: "2026-09-11T00:01:00.000Z",
    });

    expect(projected.progress).toEqual({
      stage: "completed",
      shadowOnly: true,
      outcome: "enriched",
      statementCount: 7,
      sourceTurnCount: 12,
      generationLatencyMs: 4_321,
    });
    expect(projected.result).toEqual({
      shadowOnly: true,
      rankingEffect: "none",
      outcome: "enriched",
      statementCount: 7,
      sourceTurnCount: 12,
      generationLatencyMs: 4_321,
    });
    expect(projected.lastError).toBe(
      "Semantic summary enrichment did not complete.",
    );
    expect(JSON.stringify(projected)).not.toContain("private-enrichment-id");
    expect(JSON.stringify(projected)).not.toContain("private-source-hash");
    expect(JSON.stringify(projected)).not.toContain("private supersession reason");
    expect(JSON.stringify(projected)).not.toContain("provider returned private source content");
  });

  it("keeps actor-private semantic jobs out of tenant-wide latest surfaces", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-semantic-latest-private";
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-09-11T00:00:00.000Z"));
      const visible = await queue.enqueueOperationJob({
        tenantId,
        type: "workflow.tick",
        payload: { workflowRunId: "visible-workflow" },
      });
      vi.setSystemTime(new Date("2026-09-11T00:01:00.000Z"));
      for (let index = 0; index < 6; index += 1) {
        await queue.enqueueOperationJob({
          tenantId,
          type: "conversation.summary.enrich",
          payload: {
            actorId: `private-actor-${index}`,
            result: { sourceSha256: `private-hash-${index}` },
          },
        });
      }

      await expect(
        queue.listTenantWideOperationJobs(5, { tenantId }),
      ).resolves.toEqual([
        expect.objectContaining({ id: visible.id, type: "workflow.tick" }),
      ]);
      const stats = await queue.getOperationJobStats({ tenantId });
      expect(stats.total).toBe(7);
      expect(stats.byStatus.queued).toBe(7);
      expect(stats.latest).toEqual([
        expect.objectContaining({ id: visible.id, type: "workflow.tick" }),
      ]);
      expect(JSON.stringify(stats)).not.toContain("private-hash");
    } finally {
      vi.useRealTimers();
    }
  });

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

  it("loads a bounded set of tenant-scoped jobs without exposing other tenants", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const first = await queue.enqueueOperationJob({
      tenantId: "tenant-job-batch-a",
      type: "capture.asset.process",
      payload: { actorId: "owner-a", progress: { stage: "queued" } },
    });
    const second = await queue.enqueueOperationJob({
      tenantId: "tenant-job-batch-a",
      type: "capture.asset.process",
      payload: { actorId: "owner-a", progress: { stage: "reading" } },
    });
    const otherTenant = await queue.enqueueOperationJob({
      tenantId: "tenant-job-batch-b",
      type: "capture.asset.process",
      payload: { actorId: "owner-b", progress: { stage: "queued" } },
    });

    const jobs = await queue.getOperationJobsByIds(
      [first.id, second.id, otherTenant.id, first.id, " invalid "],
      { tenantId: "tenant-job-batch-a" },
    );

    expect(new Set(jobs.map((job) => job.id))).toEqual(
      new Set([first.id, second.id]),
    );
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

  it("keeps a lapsed attempt's count and error when the same work is enqueued again", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-lapsed-attempt";
    const enqueue = () => queue.enqueueOperationJob({
      tenantId,
      type: "workflow.tick",
      dedupeKey: "lapsed-attempt",
      payload: { workflowRunId: "workflow-lapsed-attempt" },
      maxAttempts: 3,
    });
    const job = await enqueue();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const [leased] = await queue.leaseOperationJobs({
        tenantId,
        dedupeKey: job.dedupeKey,
        leaseSeconds: 10,
      });
      expect(leased).toMatchObject({ id: job.id, attempt: 1 });
      vi.setSystemTime(Date.now() + 11_000);

      await expect(enqueue()).resolves.toMatchObject({
        id: job.id,
        status: "queued",
        attempt: 1,
        lastError: "Lease expired before completion.",
      });
      const [retried] = await queue.leaseOperationJobs({
        tenantId,
        dedupeKey: job.dedupeKey,
      });
      expect(retried).toMatchObject({ id: job.id, attempt: 2 });
      await queue.failOperationJob(
        job.id,
        "transient",
        retried.leaseOwner,
        tenantId,
      );
      await expect(enqueue()).resolves.toMatchObject({
        id: job.id,
        status: "queued",
        attempt: 2,
        lastError: "transient",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits between half and all of a retry's backoff", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-retry-spread";
    for (const [index, [draw, delayMs]] of [
      [0, 7_500],
      [0.5, 11_250],
      [1, 15_000],
    ].entries()) {
      const job = await queue.enqueueOperationJob({
        tenantId,
        type: "workflow.tick",
        dedupeKey: `retry-spread-${index}`,
        payload: { workflowRunId: `workflow-retry-spread-${index}` },
      });
      const [leased] = await queue.leaseOperationJobs({
        tenantId,
        dedupeKey: job.dedupeKey,
      });
      const random = vi.spyOn(Math, "random").mockReturnValue(draw);
      const before = Date.now();
      try {
        const failed = await queue.failOperationJob(
          job.id,
          "transient",
          leased.leaseOwner,
          tenantId,
        );
        const runAt = Date.parse(failed?.runAt || "");
        expect(runAt).toBeGreaterThanOrEqual(before + delayMs);
        expect(runAt).toBeLessThanOrEqual(Date.now() + delayMs);
      } finally {
        random.mockRestore();
      }
    }
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

  it("leases a job by dedupe key for an in-request owner, whatever its schedule", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-dedupe-lease";
    const dedupeKey = queue.getAgentResumeJobDedupeKey("execution-dedupe-lease");
    const job = await queue.enqueueOperationJob({
      tenantId,
      type: "agent.resume",
      dedupeKey,
      payload: { agentRunId: "run-dedupe-lease" },
      runAt: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(
      await queue.leaseOperationJobs({ tenantId, type: "agent.resume" }),
    ).toEqual([]);

    const before = Date.now();
    const lease = await queue.leaseOperationJobByDedupeKey(dedupeKey, {
      tenantId,
      type: "agent.resume",
      owner: "request:approval",
      leaseSeconds: 60,
    });
    expect(lease).toMatchObject({
      outcome: "leased",
      job: {
        id: job.id,
        tenantId,
        status: "running",
        attempt: 1,
        leaseOwner: "request:approval",
      },
    });
    const leasedJob = lease.outcome === "leased" ? lease.job : undefined;
    expect(Date.parse(leasedJob?.leaseExpiresAt || "")).toBeGreaterThanOrEqual(
      before + 60_000,
    );
    await expect(
      queue.leaseOperationJobByDedupeKey(dedupeKey, {
        tenantId,
        type: "agent.resume",
        owner: "request:second",
      }),
    ).resolves.toEqual({ outcome: "busy" });
    expect(
      await queue.heartbeatOperationJob(job.id, "request:approval", { tenantId }),
    ).toMatchObject({ id: job.id, leaseOwner: "request:approval" });
    await expect(
      queue.leaseOperationJobByDedupeKey(dedupeKey, {
        tenantId: "tenant-dedupe-lease-other",
        type: "agent.resume",
      }),
    ).resolves.toEqual({ outcome: "absent" });
    await expect(
      queue.leaseOperationJobByDedupeKey(dedupeKey, {
        tenantId,
        type: "workflow.tick",
      }),
    ).resolves.toEqual({ outcome: "absent" });

    expect(
      await queue.completeOperationJob(job.id, "request:approval", tenantId),
    ).toMatchObject({ status: "completed" });
    await expect(
      queue.leaseOperationJobByDedupeKey(dedupeKey, {
        tenantId,
        type: "agent.resume",
      }),
    ).resolves.toEqual({ outcome: "absent" });
    await expect(
      queue.leaseOperationJobByDedupeKey("agent.resume:never-enqueued", {
        tenantId,
        type: "agent.resume",
      }),
    ).resolves.toEqual({ outcome: "absent" });
  });

  it("leases failed and lease-expired jobs by dedupe key but not canceled ones", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-dedupe-recover";
    const failedKey = "dedupe-recover-failed";
    const failedJob = await queue.enqueueOperationJob({
      tenantId,
      type: "agent.resume",
      dedupeKey: failedKey,
      payload: {},
      maxAttempts: 1,
    });
    const [firstLease] = await queue.leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      dedupeKey: failedKey,
    });
    expect(
      await queue.failOperationJob(
        failedJob.id,
        "boom",
        firstLease.leaseOwner,
        tenantId,
      ),
    ).toMatchObject({ status: "failed", attempt: 1 });
    await expect(
      queue.leaseOperationJobByDedupeKey(failedKey, {
        tenantId,
        type: "agent.resume",
        owner: "request:failed",
      }),
    ).resolves.toMatchObject({
      outcome: "leased",
      job: {
        id: failedJob.id,
        status: "running",
        attempt: 2,
        leaseOwner: "request:failed",
        lastError: undefined,
        completedAt: undefined,
      },
    });

    const expiredKey = "dedupe-recover-expired";
    const expiredJob = await queue.enqueueOperationJob({
      tenantId,
      type: "agent.resume",
      dedupeKey: expiredKey,
      payload: {},
    });
    await queue.leaseOperationJobs({
      tenantId,
      type: "agent.resume",
      dedupeKey: expiredKey,
      owner: "worker:dead",
      leaseSeconds: 10,
    });
    await expect(
      queue.leaseOperationJobByDedupeKey(expiredKey, {
        tenantId,
        type: "agent.resume",
      }),
    ).resolves.toEqual({ outcome: "busy" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 11_000);
      await expect(
        queue.leaseOperationJobByDedupeKey(expiredKey, {
          tenantId,
          type: "agent.resume",
          owner: "request:expired",
        }),
      ).resolves.toMatchObject({
        outcome: "leased",
        job: {
          id: expiredJob.id,
          status: "running",
          attempt: 2,
          leaseOwner: "request:expired",
        },
      });
    } finally {
      vi.useRealTimers();
    }

    const canceledKey = "dedupe-recover-canceled";
    await queue.enqueueOperationJob({
      tenantId,
      type: "agent.resume",
      dedupeKey: canceledKey,
      payload: {},
    });
    await queue.cancelOperationJobByDedupeKey(canceledKey, "gone", { tenantId });
    await expect(
      queue.leaseOperationJobByDedupeKey(canceledKey, {
        tenantId,
        type: "agent.resume",
      }),
    ).resolves.toEqual({ outcome: "absent" });
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

  it("ranks each tenant for dispatch by the job it would lease next", async () => {
    const queue = await import("@/lib/operations/job-queue");
    // Long before the other tests' jobs, so only these are due.
    const now = Date.parse("2026-01-05T00:00:00.000Z");
    const ago = (seconds: number) => new Date(now - seconds * 1_000).toISOString();
    const tick = (tenantId: string, dedupeKey: string, priority: number, runAt: string) =>
      queue.enqueueOperationJob({
        tenantId,
        type: "workflow.tick",
        dedupeKey,
        payload: { workflowRunId: dedupeKey },
        priority,
        runAt,
      });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // Fifteen minutes of waiting lift this job above a newer, more urgent one.
      vi.setSystemTime(now - 15 * 60_000);
      await tick("tenant-dispatch-aged", "dispatch-aged-old", 10, ago(900));
      vi.setSystemTime(now);
      await tick("tenant-dispatch-aged", "dispatch-aged-urgent", 20, ago(5));
      // A newer, more urgent job leases before this tenant's older one.
      await tick("tenant-dispatch-urgent", "dispatch-urgent-old", 10, ago(300));
      await tick("tenant-dispatch-urgent", "dispatch-urgent-new", 20, ago(1));
      await tick("tenant-dispatch-steady", "dispatch-steady", 10, ago(120));
      // At equal priority the earlier run_at leases first, whatever the enqueue order.
      await tick("tenant-dispatch-waiting", "dispatch-waiting-old", 10, ago(180));
      await tick("tenant-dispatch-waiting", "dispatch-waiting-new", 10, ago(30));

      const snapshot = await queue.listRunnableOperationDispatchTenants({
        workflowLimit: 25,
      });

      expect(snapshot.workflowTenantIds.filter((id) => id.startsWith("tenant-dispatch-")))
        .toEqual([
          "tenant-dispatch-aged",
          "tenant-dispatch-waiting",
          "tenant-dispatch-steady",
          "tenant-dispatch-urgent",
        ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("operation job quarantine (file mode)", () => {
  // Leases the job, lets the lease lapse, and settles the lapse.
  async function lapse(
    queue: typeof import("@/lib/operations/job-queue"),
    tenantId: string,
    dedupeKey: string,
  ) {
    const [leased] = await queue.leaseOperationJobs({ tenantId, dedupeKey, leaseSeconds: 10 });
    expect(leased?.status).toBe("running");
    vi.setSystemTime(Date.now() + 11_000);
    await queue.repairExpiredOperationJobs({ tenantId });
    return leased;
  }

  async function quarantinedJob(
    tenantId: string,
    dedupeKey: string,
    input: {
      type?: "memory.consolidate" | "workflow.tick" | "agent.execute" | "agent.resume";
      payload?: Record<string, unknown>;
    } = {},
  ) {
    const queue = await import("@/lib/operations/job-queue");
    const job = await queue.enqueueOperationJob({
      tenantId,
      type: input.type || "memory.consolidate",
      dedupeKey,
      payload: input.payload || { request: { memoryId: "private-memory" } },
      maxAttempts: 10,
    });
    for (let count = 0; count < queue.OPERATION_JOB_QUARANTINE_LAPSES; count += 1) {
      await lapse(queue, tenantId, dedupeKey);
    }
    const quarantined = await queue.getOperationJob(job.id, { tenantId });
    expect(quarantined?.status).toBe("quarantined");
    return quarantined!;
  }

  async function streamTypes(jobId: string, tenantId: string) {
    const [{ listStreamEvents }, queue] = await Promise.all([
      import("@/lib/events/store"),
      import("@/lib/operations/job-queue"),
    ]);
    return (await listStreamEvents(queue.operationJobStreamId(jobId), { tenantId }))
      .map((event) => ({ type: event.type, actorId: event.actorId, payload: event.payload }));
  }

  it("redelivers a lapsed job until three lapses in a row quarantine it", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-lapses";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey: "lapsing",
        payload: { request: { memoryId: "memory-a" } },
        maxAttempts: 10,
      });
      await lapse(queue, tenantId, "lapsing");
      await expect(queue.getOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        status: "queued",
        attempt: 1,
        leaseLapses: 1,
        lastError: "Lease expired before completion.",
      });
      await lapse(queue, tenantId, "lapsing");
      await expect(queue.getOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        status: "queued",
        leaseLapses: 2,
      });
      expect(await streamTypes(job.id, tenantId)).toEqual([]);

      await lapse(queue, tenantId, "lapsing");
      const quarantined = await queue.getOperationJob(job.id, { tenantId });
      expect(quarantined).toMatchObject({
        status: "quarantined",
        attempt: 3,
        leaseLapses: 3,
        lastError: queue.OPERATION_JOB_QUARANTINE_ERROR,
        payload: { request: { memoryId: "memory-a" } },
        completedAt: expect.any(String),
      });
      expect(quarantined?.leaseOwner).toBeUndefined();
      expect(await queue.leaseOperationJobs({ tenantId })).toEqual([]);
      expect(await streamTypes(job.id, tenantId)).toEqual([{
        type: "operation.job.quarantined",
        actorId: "system",
        payload: expect.objectContaining({
          jobId: job.id,
          jobType: "memory.consolidate",
          attempt: 3,
          maxAttempts: 10,
          leaseLapses: 3,
        }),
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("quarantines a workflow tick, which otherwise always redelivers", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-tick";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const tick = await queue.enqueueOperationJob({
        tenantId,
        type: "workflow.tick",
        dedupeKey: "workflow:run-q",
        payload: { workflowRunId: "run-q" },
        maxAttempts: 1,
      });
      await lapse(queue, tenantId, "workflow:run-q");
      await lapse(queue, tenantId, "workflow:run-q");
      await expect(queue.getOperationJob(tick.id, { tenantId })).resolves.toMatchObject({
        status: "queued",
        attempt: 2,
        leaseLapses: 2,
      });
      await lapse(queue, tenantId, "workflow:run-q");
      await expect(queue.getOperationJob(tick.id, { tenantId })).resolves.toMatchObject({
        status: "quarantined",
      });
      await expect(queue.listActiveWorkflowTickRunIds({ tenantId })).resolves.toEqual(
        new Set(["run-q"]),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the count when the worker reports any outcome", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-outcomes";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey: "outcomes",
        payload: {},
        maxAttempts: 20,
      });
      const twoLapsesThen = async (report: (leased: Awaited<ReturnType<typeof lapse>>) => Promise<unknown>) => {
        await lapse(queue, tenantId, "outcomes");
        await lapse(queue, tenantId, "outcomes");
        const [leased] = await queue.leaseOperationJobs({ tenantId, dedupeKey: "outcomes", leaseSeconds: 10 });
        expect(leased.leaseLapses).toBe(2);
        await report(leased);
        const reported = await queue.getOperationJob(job.id, { tenantId });
        expect(reported?.leaseLapses).toBe(0);
        return reported;
      };

      await expect(twoLapsesThen((leased) =>
        queue.failOperationJob(job.id, "transient", leased.leaseOwner, tenantId)
      )).resolves.toMatchObject({ status: "queued" });
      vi.setSystemTime(Date.now() + 3_600_000);

      await expect(twoLapsesThen((leased) =>
        queue.deferOperationJob(job.id, leased.leaseOwner!, { tenantId, delaySeconds: 0 })
      )).resolves.toMatchObject({ status: "queued" });
      vi.setSystemTime(Date.now() + 1_000);

      await expect(twoLapsesThen((leased) =>
        queue.completeOperationJob(job.id, leased.leaseOwner, tenantId)
      )).resolves.toMatchObject({ status: "completed" });
      expect(await streamTypes(job.id, tenantId)).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the count across heartbeats, which report no outcome", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-heartbeat";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey: "heartbeat",
        payload: {},
        maxAttempts: 10,
      });
      await lapse(queue, tenantId, "heartbeat");
      await lapse(queue, tenantId, "heartbeat");
      const [leased] = await queue.leaseOperationJobs({ tenantId, dedupeKey: "heartbeat", leaseSeconds: 10 });
      await queue.heartbeatOperationJob(job.id, leased.leaseOwner!, { tenantId, leaseSeconds: 10 });
      vi.setSystemTime(Date.now() + 11_000);
      await queue.repairExpiredOperationJobs({ tenantId });

      await expect(queue.getOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        status: "quarantined",
        leaseLapses: 3,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a lapse before any path revives the job, so the third quarantines it there", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-paths";
    const otherTenantId = "tenant-quarantine-paths-other";
    const revivals = {
      enqueue: (dedupeKey: string) => queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey,
        payload: {},
      }),
      wake: (dedupeKey: string) => queue.wakeOperationJobByDedupeKey(dedupeKey, { tenantId }),
      requeue: (dedupeKey: string) =>
        queue.requeueOperationJobByDedupeKey(dedupeKey, "again", { tenantId }),
      lease: (dedupeKey: string) => queue.leaseOperationJobByDedupeKey(dedupeKey, {
        tenantId,
        type: "memory.consolidate",
      }),
    };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const other = await queue.enqueueOperationJob({
        tenantId: otherTenantId,
        type: "memory.consolidate",
        dedupeKey: "enqueue",
        payload: {},
      });
      await queue.leaseOperationJobs({ tenantId: otherTenantId, leaseSeconds: 10 });

      // An idempotent enqueue revives nothing, so it leaves the lapse to
      // repair.
      const idle = await queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey: "idempotent",
        payload: {},
      });
      await queue.leaseOperationJobs({ tenantId, dedupeKey: "idempotent", leaseSeconds: 10 });
      vi.setSystemTime(Date.now() + 11_000);
      await expect(queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey: "idempotent",
        payload: {},
        dedupeMode: "idempotent",
      })).resolves.toMatchObject({ id: idle.id, status: "running" });

      for (const [path, revive] of Object.entries(revivals)) {
        const job = await queue.enqueueOperationJob({
          tenantId,
          type: "memory.consolidate",
          dedupeKey: path,
          payload: {},
          maxAttempts: 10,
        });
        await lapse(queue, tenantId, path);
        await lapse(queue, tenantId, path);
        await queue.leaseOperationJobs({ tenantId, dedupeKey: path, leaseSeconds: 10 });
        vi.setSystemTime(Date.now() + 11_000);

        await revive(path);

        await expect(queue.getOperationJob(job.id, { tenantId }), path).resolves.toMatchObject({
          status: "quarantined",
          leaseLapses: 3,
        });
        expect(await streamTypes(job.id, tenantId), path).toEqual([
          expect.objectContaining({ type: "operation.job.quarantined" }),
        ]);
      }
      // Another tenant's lapsed lease is its own to settle.
      const untouched = await queue.getOperationJob(other.id, { tenantId: otherTenantId });
      expect(untouched).toMatchObject({ status: "running", attempt: 1 });
      expect(untouched?.leaseLapses).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never revives a quarantined job through enqueue, wake, requeue or an owner's lease", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-revival";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await quarantinedJob(tenantId, "revival");

      await expect(queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey: "revival",
        payload: { request: { memoryId: "new-request" } },
      })).resolves.toMatchObject({ id: job.id, status: "quarantined" });
      await expect(queue.wakeOperationJobByDedupeKey("revival", { tenantId })).resolves.toEqual([]);
      await expect(queue.requeueOperationJobByDedupeKey("revival", "again", { tenantId })).resolves.toEqual([]);
      await expect(queue.leaseOperationJobByDedupeKey("revival", {
        tenantId,
        type: "memory.consolidate",
      })).resolves.toEqual({ outcome: "busy" });
      await expect(queue.leaseOperationJobs({ tenantId })).resolves.toEqual([]);

      await expect(queue.getOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        status: "quarantined",
        attempt: 3,
        payload: { request: { memoryId: "private-memory" } },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a quarantined job for an owner that no longer wants its work", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-cancel";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await quarantinedJob(tenantId, "workflow:run-c", {
        type: "workflow.tick",
        payload: { workflowRunId: "run-c" },
      });

      await expect(queue.cancelOperationJobByDedupeKey(
        "workflow:run-c",
        "Workflow canceled.",
        { tenantId },
      )).resolves.toMatchObject([{ id: job.id, status: "canceled", lastError: "Workflow canceled." }]);
      await expect(queue.releaseQuarantinedOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        outcome: "not_quarantined",
      });
      await expect(queue.listActiveWorkflowTickRunIds({ tenantId })).resolves.toEqual(new Set());
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases a quarantined job to run again from its first attempt", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-release";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await quarantinedJob(tenantId, "release");
      vi.setSystemTime(Date.now() + 1_000);

      const released = await queue.releaseQuarantinedOperationJob(job.id, {
        tenantId,
        actorId: "operator-a",
      });
      expect(released).toMatchObject({
        outcome: "released",
        job: { id: job.id, status: "queued", attempt: 0, leaseLapses: 0 },
      });
      expect(released.outcome === "released" && released.job.lastError).toBeUndefined();
      await expect(queue.releaseQuarantinedOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        outcome: "not_quarantined",
      });

      const [leased] = await queue.leaseOperationJobs({ tenantId, dedupeKey: "release" });
      expect(leased).toMatchObject({
        id: job.id,
        attempt: 1,
        payload: { request: { memoryId: "private-memory" } },
      });
      expect(await streamTypes(job.id, tenantId)).toEqual([
        expect.objectContaining({ type: "operation.job.quarantined" }),
        {
          type: "operation.job.released",
          actorId: "operator-a",
          payload: expect.objectContaining({ jobId: job.id, attempt: 3, leaseLapses: 3 }),
        },
      ]);

      // A released job that keeps crashing is quarantined again, as a new
      // event.
      vi.setSystemTime(Date.now() + 121_000);
      await queue.repairExpiredOperationJobs({ tenantId });
      await lapse(queue, tenantId, "release");
      await lapse(queue, tenantId, "release");
      expect((await streamTypes(job.id, tenantId)).map((event) => event.type)).toEqual([
        "operation.job.quarantined",
        "operation.job.released",
        "operation.job.quarantined",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a background job without its request, and leaves run-owned jobs to their run", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-discard";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await quarantinedJob(tenantId, "discard", {
        payload: { request: { memoryId: "private-memory" }, progress: { stage: "indexing" }, __rerunRequested: true },
      });
      const tick = await quarantinedJob(tenantId, "workflow:run-d", {
        type: "workflow.tick",
        payload: { workflowRunId: "run-d" },
      });

      const discarded = await queue.discardQuarantinedOperationJob(job.id, {
        tenantId,
        actorId: "operator-a",
        reason: "Poison input.",
      });
      expect(discarded).toMatchObject({
        outcome: "discarded",
        job: { status: "canceled", lastError: "Poison input.", payload: { progress: { stage: "indexing" } } },
      });
      const stored = await queue.getOperationJob(job.id, { tenantId });
      expect(stored?.payload).toEqual({ progress: { stage: "indexing" } });
      expect(stored?.completedAt).toBeDefined();
      expect(await streamTypes(job.id, tenantId)).toEqual([
        expect.objectContaining({ type: "operation.job.quarantined" }),
        expect.objectContaining({ type: "operation.job.discarded", actorId: "operator-a" }),
      ]);

      await expect(queue.discardQuarantinedOperationJob(tick.id, { tenantId })).resolves.toMatchObject({
        outcome: "owned_by_run",
      });
      await expect(queue.getOperationJob(tick.id, { tenantId })).resolves.toMatchObject({
        status: "quarantined",
      });
      for (const type of ["agent.execute", "agent.resume"] as const) {
        const agentJob = await quarantinedJob(tenantId, `discard-${type}`, {
          type,
          payload: { runId: `run-${type}` },
        });
        await expect(queue.discardQuarantinedOperationJob(agentJob.id, { tenantId }))
          .resolves.toMatchObject({ outcome: "owned_by_run" });
      }
      await expect(queue.discardQuarantinedOperationJob(tick.id, {
        tenantId: "tenant-quarantine-other",
      })).resolves.toEqual({ outcome: "absent" });
      await expect(queue.discardQuarantinedOperationJob("job-missing", { tenantId })).resolves.toEqual({
        outcome: "absent",
      });
      // The operator may still release a job its run owns.
      await expect(queue.releaseQuarantinedOperationJob(tick.id, { tenantId })).resolves.toMatchObject({
        outcome: "released",
        job: { id: tick.id, status: "queued" },
      });
      const defaultReason = await quarantinedJob(tenantId, "discard-default");
      await expect(queue.discardQuarantinedOperationJob(defaultReason.id, { tenantId })).resolves.toMatchObject({
        job: { lastError: "Discarded from quarantine by an operator." },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows quarantined jobs to stats, recovery, the overview and status reads", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-reads";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await quarantinedJob(tenantId, "reads");
      vi.setSystemTime(Date.now() + 1_000);
      const newer = await queue.enqueueOperationJob({
        tenantId,
        type: "memory.consolidate",
        dedupeKey: "newer",
        payload: {},
      });

      const stats = await queue.getOperationJobStats({ tenantId });
      expect(stats.byStatus.quarantined).toBe(1);
      expect((await queue.listOperationJobRecoveryRows(1, { tenantId })).map((row) => row.id))
        .toEqual([newer.id, job.id]);
      expect((await queue.listQuarantinedOperationJobs(10, { tenantId })).map((item) => item.id))
        .toEqual([job.id]);
      expect(queue.projectOperationJobStatus(job)).toMatchObject({
        status: "failed",
        quarantined: true,
      });
      expect(queue.projectOperationJobStatus(newer)).not.toHaveProperty("quarantined");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps actor-private quarantined jobs off the tenant-wide list", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const tenantId = "tenant-quarantine-private";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await queue.enqueueOperationJob({
        tenantId,
        type: "conversation.summary.enrich",
        dedupeKey: "private",
        payload: { actorId: "owner-a" },
        maxAttempts: 10,
      });
      for (let count = 0; count < queue.OPERATION_JOB_QUARANTINE_LAPSES; count += 1) {
        await lapse(queue, tenantId, "private");
      }

      await expect(queue.getOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        status: "quarantined",
      });
      await expect(queue.listQuarantinedOperationJobs(10, { tenantId })).resolves.toEqual([]);
      expect((await queue.getOperationJobStats({ tenantId })).byStatus.quarantined).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a quarantined job when the ledger trims finished work", async () => {
    const queue = await import("@/lib/operations/job-queue");
    const dataDir = process.env.OMNIAGENT_DATA_DIR;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "omni-queue-trim-"));
    const tenantId = "tenant-quarantine-trim";
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const job = await quarantinedJob(tenantId, "trim");
      const { writeFile, readFile } = await import("node:fs/promises");
      const file = path.join(process.env.OMNIAGENT_DATA_DIR, "operation-jobs.json");
      const ledger = JSON.parse(await readFile(file, "utf8")) as { jobs: Record<string, unknown>[] };
      const later = Date.now() + 1_000;
      const finished = Array.from({ length: 500 }, (_, index) => ({
        ...ledger.jobs[0],
        id: `finished-${index}`,
        dedupeKey: `finished-${index}`,
        status: "completed",
        updatedAt: new Date(later + index).toISOString(),
      }));
      await writeFile(file, JSON.stringify({ jobs: [...finished, ...ledger.jobs] }));
      vi.setSystemTime(later + 10_000);

      await queue.enqueueOperationJob({ tenantId, type: "memory.consolidate", dedupeKey: "trigger", payload: {} });

      await expect(queue.getOperationJob(job.id, { tenantId })).resolves.toMatchObject({
        status: "quarantined",
      });
    } finally {
      vi.useRealTimers();
      process.env.OMNIAGENT_DATA_DIR = dataDir;
    }
  });
});
