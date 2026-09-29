import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";

const mocks = vi.hoisted(() => ({ after: vi.fn(), tickWorkflowRun: vi.fn() }));

vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@/lib/workflows/runner", () => ({
  tickWorkflowRun: mocks.tickWorkflowRun,
}));

import { listOperationJobs } from "@/lib/operations/job-queue";
import { runWithRequestTiming } from "@/lib/observability/request-timing";
import {
  enqueueWorkflowRunTick,
  scheduleWorkflowQueueDrain,
} from "@/lib/workflows/queue";
import { createWorkflowRun } from "@/lib/workflows/store";

const tenantId = "tenant-queue-drain";
const scheduledAt = Date.parse("2026-09-30T12:00:00.000Z");

async function queueRun(goal: string) {
  const created = await createWorkflowRun({ tenantId, goal });
  await enqueueWorkflowRunTick(created.run.id, "test", undefined, tenantId);
  return created.run.id;
}

async function jobStatuses() {
  const jobs = await listOperationJobs(20, { tenantId, type: "workflow.tick" });
  return jobs.map((job) => job.status).sort();
}

/** Schedules a drain from a request that has already run for `elapsedMs`. */
async function drainAfterRequest(
  elapsedMs: number,
  options?: { routeMaxDurationSeconds?: number },
) {
  const now = vi.spyOn(performance, "now");
  now.mockReturnValueOnce(1_000).mockReturnValue(1_000 + elapsedMs);
  try {
    await runWithRequestTiming(() =>
      scheduleWorkflowQueueDrain(undefined, tenantId, options),
    );
  } finally {
    now.mockRestore();
  }
  expect(mocks.after).toHaveBeenCalledTimes(1);
  await mocks.after.mock.calls[0][0]();
}

describe("workflow queue drain after a response", () => {
  let deadline: AbortController;
  let timeout: MockInstance<typeof AbortSignal.timeout>;
  let warn: MockInstance<typeof console.warn>;

  beforeEach(async () => {
    delete process.env.DATABASE_URL;
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-workflow-queue-drain-"),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(scheduledAt);
    mocks.after.mockReset();
    mocks.tickWorkflowRun.mockReset().mockImplementation(
      async (workflowRunId: string) => ({
        run: { id: workflowRunId, status: "completed" },
        steps: [],
        events: [],
      }),
    );
    deadline = new AbortController();
    timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    timeout.mockRestore();
    warn.mockRestore();
    vi.useRealTimers();
  });

  it.each([
    ["a route's own limit", 4_000, { routeMaxDurationSeconds: 60 }, 46_000],
    ["30 seconds for a route that names no limit", 0, undefined, 20_000],
  ])("stops the tick 10 seconds before %s runs out", async (
    _,
    elapsedMs,
    options,
    runwayMs,
  ) => {
    const workflowRunId = await queueRun("Tidy this week's notes");

    await drainAfterRequest(elapsedMs, options);

    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout).toHaveBeenCalledWith(runwayMs);
    expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(1);
    const [tickedRunId, tickOptions] = mocks.tickWorkflowRun.mock.calls[0];
    expect(tickedRunId).toBe(workflowRunId);
    expect(tickOptions).toMatchObject({
      tenantId,
      deadlineAt: scheduledAt + runwayMs,
    });
    expect(tickOptions.abortSignal.aborted).toBe(false);
    deadline.abort();
    expect(tickOptions.abortSignal.aborted).toBe(true);
  });

  it("leases the next tick only after the one before it ends", async () => {
    await queueRun("Draft the weekly update");
    await queueRun("File the receipts");
    const queuedDuringTick: string[][] = [];
    mocks.tickWorkflowRun.mockImplementation(async (workflowRunId: string) => {
      queuedDuringTick.push(await jobStatuses());
      return { run: { id: workflowRunId, status: "completed" }, steps: [], events: [] };
    });

    await drainAfterRequest(0);

    expect(queuedDuringTick).toEqual([
      ["queued", "running"],
      ["completed", "running"],
    ]);
    expect(await jobStatuses()).toEqual(["completed", "completed"]);
  });

  it.each([
    // The first tick runs until 4 seconds before the drain's deadline.
    ["less than five seconds are left", () => vi.setSystemTime(scheduledAt + 16_000)],
    ["the deadline has passed", () => deadline.abort()],
  ])("starts no further tick once %s", async (_, endFirstTick) => {
    await queueRun("Draft the weekly update");
    await queueRun("File the receipts");
    mocks.tickWorkflowRun.mockImplementationOnce(async (workflowRunId: string) => {
      endFirstTick();
      return { run: { id: workflowRunId, status: "completed" }, steps: [], events: [] };
    });

    await drainAfterRequest(0);

    expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(1);
    expect(await jobStatuses()).toEqual(["completed", "queued"]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("puts a tick the deadline cuts short back in its place without spending an attempt", async () => {
    await queueRun("Draft the weekly update");
    const [queued] = await listOperationJobs(20, { tenantId, type: "workflow.tick" });
    mocks.tickWorkflowRun.mockImplementationOnce(async () => {
      deadline.abort();
      throw new Error("The tick stopped at the drain's deadline.");
    });

    await drainAfterRequest(0);

    const [job] = await listOperationJobs(20, { tenantId, type: "workflow.tick" });
    expect(job).toMatchObject({
      id: queued.id,
      status: "queued",
      attempt: queued.attempt,
      runAt: queued.runAt,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    [15_001, "queued", 0],
    [15_000, "completed", 1],
  ])("after %i ms of a 30 second route, leaves its tick %s", async (
    elapsedMs,
    status,
    ticks,
  ) => {
    await queueRun("Draft the weekly update");

    await drainAfterRequest(elapsedMs);

    expect(await jobStatuses()).toEqual([status]);
    expect(mocks.tickWorkflowRun).toHaveBeenCalledTimes(ticks);
  });
});
