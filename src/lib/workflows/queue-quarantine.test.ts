import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";

const mocks = vi.hoisted(() => ({ tickWorkflowRun: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/workflows/runner", () => ({ tickWorkflowRun: mocks.tickWorkflowRun }));

beforeEach(async () => {
  delete process.env.DATABASE_URL;
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(path.join(tmpdir(), "asael-queue-release-"));
  mocks.tickWorkflowRun.mockReset();
});

async function releasedWorkflow(retries: number) {
  const store = await import("@/lib/workflows/store");
  const jobs = await import("@/lib/operations/job-queue");
  const tenantId = `tenant-released-workflow-${retries}`;
  const { run } = await store.createWorkflowRun({
    tenantId, goal: "Recover interrupted work after quarantine",
    budgetLimits: { ...WORKFLOW_RUN_BUDGET_LIMITS, retries },
  });
  await store.transitionWorkflowRun(run.id, ["queued"], {
    status: "running", currentStep: "preflight",
  }, { tenantId });
  await store.updateWorkflowStep(run.id, "preflight", { status: "running", attempt: 1 }, {
    tenantId, events: [{ type: "step.started" }],
  });
  const job = await jobs.enqueueOperationJob({
    tenantId, type: "workflow.tick", dedupeKey: `workflow:${run.id}`,
    payload: { workflowRunId: run.id }, maxAttempts: 5,
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    for (let lapse = 0; lapse < jobs.OPERATION_JOB_QUARANTINE_LAPSES; lapse += 1) {
      await jobs.leaseOperationJobs({ tenantId, leaseSeconds: 10 });
      vi.setSystemTime(Date.now() + 11_000);
      await jobs.repairExpiredOperationJobs({ tenantId });
    }
  } finally {
    vi.useRealTimers();
  }
  await jobs.releaseQuarantinedOperationJob(job.id, { tenantId });
  return { store, jobs, tenantId, run, job };
}

describe("released workflow queue delivery", () => {
  it("executes on the first reset attempt after reclaiming the interrupted run", async () => {
    const { store, jobs, tenantId, run, job } = await releasedWorkflow(3);
    const { processWorkflowQueue } = await import("@/lib/workflows/queue");
    mocks.tickWorkflowRun.mockImplementation(async (runId: string) => {
      await expect(store.getWorkflowRunDetail(runId, { tenantId }))
        .resolves.toMatchObject({ run: { status: "queued" } });
      await store.transitionWorkflowRun(runId, ["queued"], { status: "completed" }, { tenantId });
      return store.getWorkflowRunDetail(runId, { tenantId });
    });

    await expect(processWorkflowQueue({ tenantId, limit: 1, bootstrapQueuedRuns: false }))
      .resolves.toMatchObject({ leased: 1, completed: 1, failed: 0 });
    expect(mocks.tickWorkflowRun).toHaveBeenCalledWith(run.id, expect.any(Object));
    const completed = await jobs.getOperationJob(job.id, { tenantId });
    expect(completed).toMatchObject({ status: "completed", attempt: 1 });
    expect(completed?.payload).not.toHaveProperty("__workflowQuarantineReleased");
  });

  it("keeps the run retry budget binding after an operator resets queue attempts", async () => {
    const { store, tenantId, run } = await releasedWorkflow(0);
    const { processWorkflowQueue } = await import("@/lib/workflows/queue");

    await processWorkflowQueue({ tenantId, limit: 1, bootstrapQueuedRuns: false });

    expect(mocks.tickWorkflowRun).not.toHaveBeenCalled();
    await expect(store.getWorkflowRunDetail(run.id, { tenantId }))
      .resolves.toMatchObject({ run: { status: "failed", error: expect.stringContaining("budget") } });
  });
});
