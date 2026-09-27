import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({ tickWorkflowRun: vi.fn() }));

vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/workflows/runner", () => ({
  tickWorkflowRun: mocks.tickWorkflowRun,
}));
vi.mock("@/lib/workflows/store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/workflows/store")>();
  return {
    ...actual,
    getWorkflowRunExecutionAuthority: vi.fn(actual.getWorkflowRunExecutionAuthority),
    recordWorkflowSpecialistsPending: vi.fn(actual.recordWorkflowSpecialistsPending),
  };
});
vi.mock("@/lib/operations/job-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/operations/job-queue")>();
  return { ...actual, deferOperationJob: vi.fn(actual.deferOperationJob) };
});
vi.mock("@/lib/subagents/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/subagents/context")>();
  return {
    ...actual,
    inspectWorkflowSpecialistDependencies: vi.fn(
      actual.inspectWorkflowSpecialistDependencies,
    ),
  };
});

const actorId = "owner@example.test";
const waitReason = "Waiting for durable specialist tasks to finish.";

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

/** Distinct update times, so each tick is enqueued after the one before it. */
function pause() {
  return new Promise((resolve) => setTimeout(resolve, 2));
}

async function workflowTick(tenantId: string, workflowRunId: string) {
  const { listOperationJobs } = await import("@/lib/operations/job-queue");
  const jobs = await listOperationJobs(50, { tenantId, type: "workflow.tick" });
  return jobs.find((job) => job.payload.workflowRunId === workflowRunId);
}

async function eventsOf(tenantId: string, workflowRunId: string, type: string) {
  const { getWorkflowRunDetail } = await import("@/lib/workflows/store");
  const detail = await getWorkflowRunDetail(workflowRunId, { tenantId });
  return (detail?.events || []).filter((event) => event.type === type);
}

/** A queued run behind durable specialist tasks that have not finished. */
async function waitingRun(
  tenantId: string,
  options: { specialists?: number; authority?: boolean; retries?: number } = {},
) {
  const missions = await import("@/lib/missions/store");
  const { createWorkflowRun } = await import("@/lib/workflows/store");
  const owner = { tenantId, actorId };
  const mission = await missions.createMission({
    ...owner,
    title: "Plan the spring trip",
    objective: "Compare the flights and the hotels for the spring trip.",
  });
  const tasks: Awaited<ReturnType<typeof missions.ensureMissionTask>>[] = [];
  for (let index = 0; index < (options.specialists ?? 1); index += 1) {
    tasks.push(await missions.ensureMissionTask(
      mission.id,
      { sourceKey: `specialist-${index}`, title: `Specialist ${index + 1}` },
      owner,
    ));
  }
  const { run } = await createWorkflowRun({
    tenantId,
    goal: "Book the spring trip",
    metadata: {
      actorId,
      missionId: mission.id,
      specialistTaskIds: tasks.map((task) => task.id),
    },
    ...(options.retries === undefined ? {} : {
      budgetLimits: { ...WORKFLOW_RUN_BUDGET_LIMITS, retries: options.retries },
    }),
    ...(options.authority ? {
      executionAuthority: {
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          correlationId: `specialists-${tenantId}`,
          purpose: "workflow.run",
        }),
        requesterRole: "admin" as const,
      },
    } : {}),
  });
  return {
    run,
    taskIds: tasks.map((task) => task.id),
    finish: (index: number) =>
      missions.transitionMissionTask(tasks[index].id, "succeeded", owner),
  };
}

describe("workflow queue while specialists work", () => {
  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-workflow-specialist-wait-"),
    );
    mocks.tickWorkflowRun.mockReset().mockImplementation(
      async (workflowRunId: string) => completed(workflowRunId),
    );
    const store = await import("@/lib/workflows/store");
    const jobQueue = await import("@/lib/operations/job-queue");
    const context = await import("@/lib/subagents/context");
    vi.mocked(store.getWorkflowRunExecutionAuthority).mockReset();
    vi.mocked(store.recordWorkflowSpecialistsPending).mockReset();
    vi.mocked(jobQueue.deferOperationJob).mockReset();
    vi.mocked(context.inspectWorkflowSpecialistDependencies).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("backs a waiting tick off to five minutes and records its specialists once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T09:00:00.000Z"));
    const { processWorkflowQueue } = await import("@/lib/workflows/queue");
    const tenantId = "tenant-specialist-backoff";
    const { run, taskIds, finish } = await waitingRun(tenantId, {
      specialists: 2,
      authority: true,
    });
    const delays: number[] = [];

    for (let wait = 1; wait <= 7; wait += 1) {
      const polledAt = Date.now();
      await expect(processWorkflowQueue({ tenantId, limit: 1 })).resolves.toMatchObject({
        leased: 1,
        waiting: 1,
        completed: 0,
        failed: 0,
        stale: 0,
        requeued: 0,
      });
      const tick = await workflowTick(tenantId, run.id);
      expect(tick).toMatchObject({
        status: "queued",
        attempt: 0,
        payload: { workflowRunId: run.id, specialistWaits: wait },
        lastError: waitReason,
      });
      const runAt = Date.parse(tick!.runAt);
      delays.push((runAt - polledAt) / 1_000);
      // Nothing is leased before the delay is up.
      vi.setSystemTime(runAt - 1);
      await expect(processWorkflowQueue({ tenantId, limit: 1 })).resolves.toMatchObject({
        leased: 0,
      });
      vi.setSystemTime(runAt);
    }

    expect(delays).toEqual([15, 30, 60, 120, 240, 300, 300]);
    expect(mocks.tickWorkflowRun).not.toHaveBeenCalled();
    const pending = async () =>
      (await eventsOf(tenantId, run.id, "workflow.specialists.pending"))
        .map((event) => event.payload.taskIds);
    expect(await pending()).toEqual([taskIds]);
    expect(await eventsOf(tenantId, run.id, "workflow.queue.leased")).toEqual([]);
    expect(await eventsOf(tenantId, run.id, "workflow.queue.enqueued")).toHaveLength(1);

    // One of the two finishes, so the run now waits on the other alone.
    await finish(0);
    await processWorkflowQueue({ tenantId, limit: 1 });
    expect(await pending()).toEqual([taskIds, [taskIds[1]]]);
  });

  it("starts a waiting tick's attempts over, even one redelivered past its run's retries", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T09:00:00.000Z"));
    const jobQueue = await import("@/lib/operations/job-queue");
    const { enqueueWorkflowRunTick, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-specialist-redelivery";
    const { run } = await waitingRun(tenantId, { retries: 0 });
    await enqueueWorkflowRunTick(run.id, "workflow_queued", 10, tenantId);
    // A worker leased the tick and stopped before it could send it back.
    await jobQueue.leaseOperationJobs({
      tenantId,
      type: "workflow.tick",
      leaseSeconds: 10,
    });
    vi.setSystemTime(Date.now() + 11_000);
    await jobQueue.repairExpiredOperationJobs({ tenantId });
    expect(await workflowTick(tenantId, run.id)).toMatchObject({
      status: "queued",
      attempt: 1,
      maxAttempts: 1,
    });

    const result = await processWorkflowQueue({
      tenantId,
      limit: 1,
      bootstrapQueuedRuns: false,
    });

    expect(result).toMatchObject({ leased: 1, waiting: 1, completed: 0, failed: 0 });
    expect(await workflowTick(tenantId, run.id)).toMatchObject({
      status: "queued",
      attempt: 0,
    });
    const { getWorkflowRun } = await import("@/lib/workflows/store");
    expect(await getWorkflowRun(run.id, { tenantId })).toMatchObject({
      status: "queued",
    });
    expect(await eventsOf(tenantId, run.id, "workflow.budget_exhausted")).toEqual([]);
    expect(mocks.tickWorkflowRun).not.toHaveBeenCalled();
  });

  it("wakes its tick at once when the specialists finish while it was leased", async () => {
    const context = await import("@/lib/subagents/context");
    const actual = await vi.importActual<typeof import("@/lib/subagents/context")>(
      "@/lib/subagents/context",
    );
    const { enqueueWorkflowRunTick, processAllTenantWorkflowQueues } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-specialist-recheck";
    const { run, finish } = await waitingRun(tenantId);
    vi.mocked(context.inspectWorkflowSpecialistDependencies).mockImplementationOnce(
      async (detail) => {
        const gate = await actual.inspectWorkflowSpecialistDependencies(detail);
        // The last specialist finishes, and its wake finds the tick leased.
        await finish(0);
        await enqueueWorkflowRunTick(
          run.id,
          "specialist_dependencies_ready",
          20,
          tenantId,
          { wake: true },
        );
        return gate;
      },
    );

    const result = await processAllTenantWorkflowQueues({
      tenantIds: [tenantId],
      timeBudgetMs: 30_000,
      limit: 1,
    });

    expect(result).toMatchObject({ leased: 2, waiting: 1, completed: 1, requeued: 1 });
    const [waited, ran] = result.jobs;
    expect(waited).toMatchObject({ workflowRunId: run.id, status: "waiting" });
    expect(Date.parse(waited.requeued!.runAt)).toBeLessThanOrEqual(Date.now());
    expect(ran).toMatchObject({ workflowRunId: run.id, status: "completed" });
    expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("brings a waiting tick forward only for a wake", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T09:00:00.000Z"));
    const { enqueueWorkflowRunTick, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-specialist-wake";
    const { run, finish } = await waitingRun(tenantId);
    await processWorkflowQueue({ tenantId, limit: 1 });
    const waiting = (await workflowTick(tenantId, run.id))!;
    vi.setSystemTime(Date.now() + 5_000);
    await finish(0);

    await expect(
      enqueueWorkflowRunTick(run.id, "workflow_queued", 10, tenantId),
    ).resolves.toMatchObject({ status: "queued", runAt: waiting.runAt });
    await expect(processWorkflowQueue({
      tenantId,
      limit: 1,
      bootstrapQueuedRuns: false,
    })).resolves.toMatchObject({ leased: 0 });

    const woken = await enqueueWorkflowRunTick(
      run.id,
      "specialist_dependencies_ready",
      20,
      tenantId,
      { wake: true },
    );

    expect(woken).toMatchObject({
      status: "queued",
      priority: 20,
      runAt: new Date().toISOString(),
    });
    const [enqueued] = (await eventsOf(tenantId, run.id, "workflow.queue.enqueued"))
      .slice(-1);
    expect(enqueued.payload).toMatchObject({
      reason: "specialist_dependencies_ready",
      runAt: woken.runAt,
    });
    await expect(processWorkflowQueue({
      tenantId,
      limit: 1,
      bootstrapQueuedRuns: false,
    })).resolves.toMatchObject({ leased: 1, completed: 1, waiting: 0 });
  });

  it("leaves a run whose authority is missing to the runner", async () => {
    const store = await import("@/lib/workflows/store");
    const { enqueueWorkflowRunTick, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-specialist-authority";
    const { run } = await waitingRun(tenantId, { authority: true });
    await enqueueWorkflowRunTick(run.id, "workflow_queued", 10, tenantId);
    vi.mocked(store.getWorkflowRunExecutionAuthority).mockResolvedValueOnce(undefined);
    mocks.tickWorkflowRun.mockRejectedValueOnce(
      new Error("Workflow execution authority is missing."),
    );

    const result = await processWorkflowQueue({
      tenantId,
      limit: 1,
      bootstrapQueuedRuns: false,
    });

    expect(result).toMatchObject({ leased: 1, waiting: 0, failed: 1 });
    expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("runs the tick of a run that is no longer queued", async () => {
    const store = await import("@/lib/workflows/store");
    const { enqueueWorkflowRunTick, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-specialist-paused";
    const { run } = await waitingRun(tenantId);
    await enqueueWorkflowRunTick(run.id, "workflow_queued", 10, tenantId);
    await store.transitionWorkflowRunWithEvents(
      run.id,
      ["queued"],
      { status: "paused", pausedAt: new Date().toISOString() },
      [{ type: "workflow.paused", payload: {} }],
      { tenantId },
    );

    const result = await processWorkflowQueue({
      tenantId,
      limit: 1,
      bootstrapQueuedRuns: false,
    });

    expect(result).toMatchObject({ leased: 1, waiting: 0, completed: 1 });
    expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("still waits when the pending specialists cannot be recorded", async () => {
    const store = await import("@/lib/workflows/store");
    const { processWorkflowQueue } = await import("@/lib/workflows/queue");
    const tenantId = "tenant-specialist-record-failure";
    const { run } = await waitingRun(tenantId);
    vi.mocked(store.recordWorkflowSpecialistsPending).mockRejectedValueOnce(
      new Error("The workflow ledger is locked."),
    );

    const result = await processWorkflowQueue({ tenantId, limit: 1 });

    expect(result).toMatchObject({ leased: 1, waiting: 1, failed: 0 });
    expect(await workflowTick(tenantId, run.id)).toMatchObject({
      status: "queued",
      attempt: 0,
      lastError: waitReason,
    });
    expect(mocks.tickWorkflowRun).not.toHaveBeenCalled();
  });

  it("reports a tick whose lease went stale before it could wait", async () => {
    const jobQueue = await import("@/lib/operations/job-queue");
    const { processWorkflowQueue } = await import("@/lib/workflows/queue");
    const tenantId = "tenant-specialist-stale";
    await waitingRun(tenantId);
    vi.mocked(jobQueue.deferOperationJob).mockResolvedValueOnce(null);

    const result = await processWorkflowQueue({ tenantId, limit: 1 });

    expect(result).toMatchObject({ leased: 1, waiting: 0, stale: 1 });
    expect(result.jobs[0]).toMatchObject({
      status: "stale",
      error: "Workflow queue lease was stale before the tick could wait for specialists.",
    });
    expect(mocks.tickWorkflowRun).not.toHaveBeenCalled();
  });

  it("counts a malformed wait count as no wait yet", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-27T09:00:00.000Z"));
    const jobQueue = await import("@/lib/operations/job-queue");
    const { processWorkflowQueue } = await import("@/lib/workflows/queue");
    const tenantId = "tenant-specialist-malformed";
    const { run } = await waitingRun(tenantId);

    for (const specialistWaits of ["3", 2.5, -2]) {
      await jobQueue.enqueueOperationJob({
        tenantId,
        type: "workflow.tick",
        dedupeKey: `workflow:${run.id}`,
        payload: { workflowRunId: run.id, specialistWaits },
      });
      await jobQueue.wakeOperationJobByDedupeKey(`workflow:${run.id}`, { tenantId });
      const polledAt = Date.now();

      await processWorkflowQueue({ tenantId, limit: 1, bootstrapQueuedRuns: false });

      const tick = (await workflowTick(tenantId, run.id))!;
      expect(tick.payload.specialistWaits).toBe(1);
      expect(Date.parse(tick.runAt) - polledAt).toBe(15_000);
    }
  });

  it("sends a tick behind the queue when its deadline comes after only a waiting tick", async () => {
    const { createWorkflowRun } = await import("@/lib/workflows/store");
    const { enqueueWorkflowRunTick, processWorkflowQueue } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-specialist-cut";
    const { run: ready } = await createWorkflowRun({
      tenantId,
      goal: "Sort this week's receipts",
    });
    const { run: waiting } = await waitingRun(tenantId);
    // The queue's ledger hands back the tick enqueued last first.
    await enqueueWorkflowRunTick(ready.id, "workflow_queued", 10, tenantId);
    await pause();
    await enqueueWorkflowRunTick(waiting.id, "workflow_queued", 10, tenantId);
    const deadline = new AbortController();
    let cutAt = 0;
    mocks.tickWorkflowRun.mockImplementationOnce(async () => {
      cutAt = Date.now();
      deadline.abort();
      throw deadline.signal.reason;
    });

    const result = await processWorkflowQueue({
      tenantId,
      limit: 2,
      bootstrapQueuedRuns: false,
      abortSignal: deadline.signal,
    });

    expect(result).toMatchObject({ leased: 2, waiting: 1, stale: 1 });
    expect(result.jobs.map((job) => [job.workflowRunId, job.status])).toEqual([
      [waiting.id, "waiting"],
      [ready.id, "stale"],
    ]);
    expect(mocks.tickWorkflowRun.mock.calls.map(([id]) => id)).toEqual([ready.id]);
    const cut = (await workflowTick(tenantId, ready.id))!;
    expect(cut).toMatchObject({ status: "queued", attempt: 0 });
    expect(Date.parse(cut.runAt)).toBeGreaterThanOrEqual(cutAt + 1_000);
  });

  it("does not count a waiting tick as one that ran earlier in the pass", async () => {
    const { createWorkflowRun } = await import("@/lib/workflows/store");
    const { enqueueRunnableWorkflowRuns, processAllTenantWorkflowQueues } =
      await import("@/lib/workflows/queue");
    const waitingTenant = "tenant-specialist-pass-waiting";
    const later = "tenant-specialist-pass-later";
    await waitingRun(waitingTenant);
    const { run: laterRun } = await createWorkflowRun({
      tenantId: later,
      goal: "Compare the insurance quotes",
    });
    await enqueueRunnableWorkflowRuns(50, { tenantId: later });
    const queued = (await workflowTick(later, laterRun.id))!;
    mocks.tickWorkflowRun.mockImplementation(untilDeadline);

    const result = await processAllTenantWorkflowQueues({
      tenantIds: [waitingTenant, later],
      timeBudgetMs: 1_000,
      limit: 2,
    });

    expect(result).toMatchObject({ leased: 2, waiting: 1, stale: 1 });
    const cut = (await workflowTick(later, laterRun.id))!;
    expect(cut).toMatchObject({ status: "queued", attempt: 0 });
    expect(Date.parse(cut.runAt)).toBeGreaterThanOrEqual(
      Date.parse(queued.runAt) + 1_000,
    );
  });

  it("keeps a tenant's turn and the pass's limit when its tick only waited", async () => {
    const { createWorkflowRun } = await import("@/lib/workflows/store");
    const { enqueueWorkflowRunTick, processAllTenantWorkflowQueues } = await import(
      "@/lib/workflows/queue"
    );
    const tenantId = "tenant-specialist-turn";
    const { run: waiting } = await waitingRun(tenantId);
    const { run: ready } = await createWorkflowRun({
      tenantId,
      goal: "Draft the renewal letter",
    });
    await enqueueWorkflowRunTick(waiting.id, "workflow_queued", 10, tenantId);
    await pause();
    await enqueueWorkflowRunTick(ready.id, "workflow_queued", 10, tenantId);

    const result = await processAllTenantWorkflowQueues({
      tenantIds: [tenantId],
      timeBudgetMs: 30_000,
      limit: 1,
    });

    expect(result.jobs.map((job) => [job.workflowRunId, job.status])).toEqual([
      [waiting.id, "waiting"],
      [ready.id, "completed"],
    ]);
    expect(result).toMatchObject({ leased: 2, waiting: 1, completed: 1 });
    expect(mocks.tickWorkflowRun.mock.calls.map(([id]) => id)).toEqual([ready.id]);
  });

  it("records the pending specialists only when they change, and only in the run's tenant", async () => {
    const store = await import("@/lib/workflows/store");
    const tenantId = "tenant-specialist-record";
    const otherTenantId = "tenant-specialist-record-other";
    const { run } = await store.createWorkflowRun({
      tenantId,
      goal: "Compare the flight options",
    });
    const { run: sibling } = await store.createWorkflowRun({
      tenantId,
      goal: "Compare the hotel options",
    });
    const { run: foreign } = await store.createWorkflowRun({
      tenantId: otherTenantId,
      goal: "Renew the passport",
    });
    const record = (runId: string, taskIds: string[]) =>
      store.recordWorkflowSpecialistsPending(runId, taskIds, { tenantId });
    const recorded = async (runId: string, tenant = tenantId) =>
      (await eventsOf(tenant, runId, "workflow.specialists.pending"))
        .map((event) => event.payload.taskIds);

    await expect(record(run.id, ["task-a", "task-b"])).resolves.toMatchObject({
      type: "workflow.specialists.pending",
      payload: { taskIds: ["task-a", "task-b"] },
    });
    await store.appendWorkflowEvent(run.id, "workflow.queue.enqueued", {
      reason: "workflow_queued",
    });
    await expect(record(run.id, ["task-b", "task-a"])).resolves.toBeUndefined();
    await expect(record(run.id, ["task-b"])).resolves.toBeDefined();
    await expect(record(run.id, ["task-a"])).resolves.toBeDefined();
    await expect(record(run.id, ["task-a"])).resolves.toBeUndefined();
    await expect(record(sibling.id, ["task-a"])).resolves.toBeDefined();
    await expect(record(foreign.id, ["task-c"])).resolves.toBeUndefined();

    expect(await recorded(run.id)).toEqual([["task-a", "task-b"], ["task-b"], ["task-a"]]);
    expect(await recorded(sibling.id)).toEqual([["task-a"]]);
    expect(await recorded(foreign.id, otherTenantId)).toEqual([]);
    await expect(store.getWorkflowRun(foreign.id, { tenantId })).resolves.toBeNull();
    await expect(
      store.getWorkflowRun(foreign.id, { tenantId: otherTenantId }),
    ).resolves.toMatchObject({ id: foreign.id, tenantId: otherTenantId, status: "queued" });
  });
});
