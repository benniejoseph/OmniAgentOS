import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ tickWorkflowRun: vi.fn() }));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/workflows/runner", () => ({
  tickWorkflowRun: mocks.tickWorkflowRun,
}));
vi.mock("@/lib/workflows/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflows/store")>();
  return {
    ...actual,
    listRunnableWorkflowRuns: vi.fn(actual.listRunnableWorkflowRuns),
  };
});

function completed(workflowRunId: string) {
  return { run: { id: workflowRunId, status: "completed" }, steps: [], events: [] };
}

/** A tick that runs until the pass's deadline stops it, like a slow model step. */
function untilDeadline(_workflowRunId: string, options: { abortSignal: AbortSignal }) {
  return new Promise((_resolve, reject) => {
    const signal = options.abortSignal;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

async function workflowTicks(tenantId: string) {
  const { listOperationJobs } = await import("@/lib/operations/job-queue");
  const jobs = await listOperationJobs(50, { tenantId, type: "workflow.tick" });
  return new Map(jobs.map((job) => [String(job.payload.workflowRunId), job]));
}

async function queuedRuns(tenantId: string, goals: string[]) {
  const { createWorkflowRun } = await import("@/lib/workflows/store");
  const runs = [];
  for (const goal of goals) {
    runs.push((await createWorkflowRun({ tenantId, goal })).run);
    // Distinct creation times, so the oldest run is the first one created.
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return runs;
}

describe("workflow queue fairness", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-workflow-queue-fairness-"),
    );
    mocks.tickWorkflowRun.mockReset().mockImplementation(
      async (workflowRunId: string) => completed(workflowRunId),
    );
  });

  it("enqueues ticks only for queued runs that have none waiting or running", async () => {
    const jobQueue = await import("@/lib/operations/job-queue");
    const { enqueueRunnableWorkflowRuns, enqueueWorkflowRunTick } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-queue-bootstrap";
    const otherTenantId = "tenant-queue-bootstrap-other";
    const [retrying, running, orphan, finished] = await queuedRuns(tenantId, [
      "Retry the weekly export",
      "Draft the monthly summary",
      "Sort this week's receipts",
      "Plan the spring garden",
    ]);
    const [foreign] = await queuedRuns(otherTenantId, ["Renew the passport"]);
    const lease = async (runId: string) => {
      const [leased] = await jobQueue.leaseOperationJobs({
        tenantId,
        type: "workflow.tick",
        dedupeKey: `workflow:${runId}`,
      });
      return leased;
    };
    for (const run of [retrying, running, finished]) {
      await enqueueWorkflowRunTick(run.id, "workflow_queued", 10, tenantId);
    }
    await enqueueWorkflowRunTick(foreign.id, "workflow_queued", 10, otherTenantId);
    // One tick failed and waits out its backoff, one runs under a lease, and
    // one finished while its run stayed queued.
    const retryLease = await lease(retrying.id);
    await jobQueue.failOperationJob(
      retryLease.id,
      "The export service timed out.",
      retryLease.leaseOwner,
      tenantId,
    );
    await lease(running.id);
    const finishedLease = await lease(finished.id);
    await jobQueue.completeOperationJob(finishedLease.id, finishedLease.leaseOwner, tenantId);
    // Another job may name a run without being its tick.
    await jobQueue.enqueueOperationJob({
      tenantId,
      type: "agent.resume",
      dedupeKey: "bootstrap-resume",
      payload: { workflowRunId: orphan.id },
    });
    const before = await workflowTicks(tenantId);
    expect(before.get(retrying.id)).toMatchObject({
      status: "queued",
      attempt: 1,
      lastError: "The export service timed out.",
    });
    expect(await jobQueue.listActiveWorkflowTickRunIds({ tenantId })).toEqual(
      new Set([retrying.id, running.id]),
    );

    // Two runs are read, and the oldest two already have their ticks.
    const enqueued = await enqueueRunnableWorkflowRuns(2, { tenantId });

    expect(enqueued.map((job) => job.payload.workflowRunId)).toEqual([
      orphan.id,
      finished.id,
    ]);
    const after = await workflowTicks(tenantId);
    expect(after.get(retrying.id)).toEqual(before.get(retrying.id));
    expect(after.get(running.id)).toEqual(before.get(running.id));
    expect(after.get(finished.id)).toMatchObject({ status: "queued", attempt: 0 });
    expect(await jobQueue.listActiveWorkflowTickRunIds({ tenantId })).toEqual(
      new Set([retrying.id, running.id, orphan.id, finished.id]),
    );
  });

  it("keeps the place of a leased tick when the deadline passes before it starts", async () => {
    const { enqueueRunnableWorkflowRuns, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-queue-unstarted";
    await queuedRuns(tenantId, ["File the travel receipts", "Plan the team offsite"]);
    await enqueueRunnableWorkflowRuns(50, { tenantId });
    const queued = await workflowTicks(tenantId);
    const deadline = new AbortController();
    mocks.tickWorkflowRun.mockImplementationOnce(async (workflowRunId: string) => {
      // The deadline passes while the first tick finishes.
      deadline.abort();
      return completed(workflowRunId);
    });

    const result = await processWorkflowQueue({
      tenantId,
      limit: 2,
      bootstrapQueuedRuns: false,
      abortSignal: deadline.signal,
    });

    expect(result).toMatchObject({ leased: 2, completed: 1, stale: 1 });
    const [[tickedRunId]] = mocks.tickWorkflowRun.mock.calls;
    const [unstartedRunId] = [...queued.keys()].filter((id) => id !== tickedRunId);
    expect((await workflowTicks(tenantId)).get(unstartedRunId)).toMatchObject({
      status: "queued",
      attempt: 0,
      runAt: queued.get(unstartedRunId)!.runAt,
    });
  });

  it("keeps the place of a tick cut short once an earlier tick in the pass ran", async () => {
    const { enqueueRunnableWorkflowRuns, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-queue-second-tick";
    await queuedRuns(tenantId, ["Summarize the board notes", "Answer the vendor survey"]);
    await enqueueRunnableWorkflowRuns(50, { tenantId });
    const queued = await workflowTicks(tenantId);
    const deadline = new AbortController();
    mocks.tickWorkflowRun
      .mockImplementationOnce(async (workflowRunId: string) => completed(workflowRunId))
      .mockImplementationOnce(async () => {
        deadline.abort();
        throw deadline.signal.reason;
      });

    await processWorkflowQueue({
      tenantId,
      limit: 2,
      bootstrapQueuedRuns: false,
      abortSignal: deadline.signal,
    });

    const cutRunId = mocks.tickWorkflowRun.mock.calls[1][0];
    expect((await workflowTicks(tenantId)).get(cutRunId)).toMatchObject({
      status: "queued",
      attempt: 0,
      runAt: queued.get(cutRunId)!.runAt,
    });
  });

  it("sends a tick that had the whole budget behind the queue when the deadline cuts it", async () => {
    const { enqueueRunnableWorkflowRuns, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-queue-whole-budget";
    const [run] = await queuedRuns(tenantId, ["Reconcile the quarter's invoices"]);
    await enqueueRunnableWorkflowRuns(50, { tenantId });
    const queued = (await workflowTicks(tenantId)).get(run.id)!;
    const deadline = new AbortController();
    let cutAt = 0;
    mocks.tickWorkflowRun.mockImplementationOnce(async () => {
      cutAt = Date.now();
      deadline.abort();
      throw deadline.signal.reason;
    });

    await processWorkflowQueue({
      tenantId,
      limit: 1,
      bootstrapQueuedRuns: false,
      abortSignal: deadline.signal,
    });

    const deferred = (await workflowTicks(tenantId)).get(run.id)!;
    expect(deferred).toMatchObject({ status: "queued", attempt: 0 });
    expect(Date.parse(deferred.runAt)).toBeGreaterThan(Date.parse(queued.runAt));
    expect(Date.parse(deferred.runAt)).toBeGreaterThanOrEqual(cutAt + 1_000);
  });

  it("keeps a later tenant's place when the pass's deadline cuts its tick", async () => {
    const { enqueueRunnableWorkflowRuns, processAllTenantWorkflowQueues } =
      await import("@/lib/workflows/queue");
    const first = "tenant-queue-pass-first";
    const later = "tenant-queue-pass-later";
    const [firstRun] = await queuedRuns(first, ["Tidy the shared drive"]);
    const [laterRun] = await queuedRuns(later, ["Compare the insurance quotes"]);
    await enqueueRunnableWorkflowRuns(50, { tenantId: first });
    await enqueueRunnableWorkflowRuns(50, { tenantId: later });
    const queued = (await workflowTicks(later)).get(laterRun.id)!;
    mocks.tickWorkflowRun.mockImplementation(async (
      workflowRunId: string,
      options: { abortSignal: AbortSignal },
    ) => workflowRunId === laterRun.id
      ? untilDeadline(workflowRunId, options)
      : completed(workflowRunId));

    const result = await processAllTenantWorkflowQueues({
      tenantIds: [first, later],
      timeBudgetMs: 1_000,
      limit: 2,
    });

    expect(mocks.tickWorkflowRun.mock.calls.map(([id]) => id)).toEqual([
      firstRun.id,
      laterRun.id,
    ]);
    expect(result).toMatchObject({ leased: 2, completed: 1, stale: 1 });
    expect((await workflowTicks(later)).get(laterRun.id)).toMatchObject({
      status: "queued",
      attempt: 0,
      runAt: queued.runAt,
    });
  });

  it("sends the pass's first tick behind the queue when the deadline cuts it", async () => {
    const { enqueueRunnableWorkflowRuns, processAllTenantWorkflowQueues } =
      await import("@/lib/workflows/queue");
    const tenantId = "tenant-queue-pass-only";
    const [run] = await queuedRuns(tenantId, ["Draft the renewal letter"]);
    await enqueueRunnableWorkflowRuns(50, { tenantId });
    const queued = (await workflowTicks(tenantId)).get(run.id)!;
    mocks.tickWorkflowRun.mockImplementation(untilDeadline);

    // A tenant with nothing to run first takes none of the budget.
    const result = await processAllTenantWorkflowQueues({
      tenantIds: ["tenant-queue-pass-idle", tenantId],
      timeBudgetMs: 1_000,
      limit: 2,
    });

    expect(result).toMatchObject({ leased: 1, stale: 1 });

    const cut = (await workflowTicks(tenantId)).get(run.id)!;
    expect(cut).toMatchObject({ status: "queued", attempt: 0 });
    // The deadline came a second after the pass began; the tick waits one more.
    expect(Date.parse(cut.runAt)).toBeGreaterThanOrEqual(
      Date.parse(queued.runAt) + 1_000,
    );
  });

  it("goes on to other tenants when one tenant's queue fails", async () => {
    const store = await import("@/lib/workflows/store");
    const { processAllTenantWorkflowQueues } = await import("@/lib/workflows/queue");
    const broken = "tenant-queue-broken";
    const healthy = "tenant-queue-healthy";
    await queuedRuns(broken, ["Export the photo albums"]);
    const [healthyRun] = await queuedRuns(healthy, ["Book the dentist visit"]);
    vi.mocked(store.listRunnableWorkflowRuns).mockRejectedValueOnce(new Error(
      "connect ECONNREFUSED postgres://asael:hunter2@db.internal:5432/asael",
    ));
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const safeError = "connect ECONNREFUSED [redacted-connection-url]";

    try {
      const result = await processAllTenantWorkflowQueues({
        tenantIds: [broken, healthy],
        timeBudgetMs: 30_000,
        limit: 2,
      });

      expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(1);
      expect(mocks.tickWorkflowRun.mock.calls[0][0]).toBe(healthyRun.id);
      expect(result).toMatchObject({
        leased: 1,
        completed: 1,
        tenantIds: [broken, healthy],
      });
      expect(result.tenantResults).toEqual([
        {
          tenantId: broken,
          result: expect.objectContaining({ leased: 0, jobs: [] }),
          error: safeError,
        },
        {
          tenantId: healthy,
          result: expect.objectContaining({ leased: 1, completed: 1 }),
        },
      ]);
      expect(errors).toHaveBeenCalledWith(JSON.stringify({
        level: "error",
        msg: "workflow_queue_tenant_failed",
        tenantId: broken,
        error: safeError,
      }));
    } finally {
      errors.mockRestore();
    }
  });
});
