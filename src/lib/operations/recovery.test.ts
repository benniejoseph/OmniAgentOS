import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OperationJobRecoveryRow, OperationJobStats } from "@/lib/operations/job-queue";
import type { WorkflowRunRecord, WorkflowStats } from "@/lib/workflows/types";

const mocks = vi.hoisted(() => ({
  cancelOperationJobByDedupeKey: vi.fn(),
  getOperationJobStats: vi.fn(),
  listOperationJobRecoveryRows: vi.fn(),
  repairExpiredOperationJobs: vi.fn(),
  requeueOperationJobByDedupeKey: vi.fn(),
  processWorkflowQueue: vi.fn(),
  enqueueWorkflowRunTick: vi.fn(),
  getWorkflowStats: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
  listWorkflowRuns: vi.fn(),
  transitionWorkflowRunWithEvents: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", () => ({
  cancelOperationJobByDedupeKey: mocks.cancelOperationJobByDedupeKey,
  getOperationJobStats: mocks.getOperationJobStats,
  listOperationJobRecoveryRows: mocks.listOperationJobRecoveryRows,
  repairExpiredOperationJobs: mocks.repairExpiredOperationJobs,
  requeueOperationJobByDedupeKey: mocks.requeueOperationJobByDedupeKey,
  storageDedupeKey: (tenantId: string, dedupeKey: string) => `${tenantId}/${dedupeKey}`,
}));

vi.mock("@/lib/workflows/queue", () => ({
  processWorkflowQueue: mocks.processWorkflowQueue,
  enqueueWorkflowRunTick: mocks.enqueueWorkflowRunTick,
  getWorkflowJobDedupeKey: (workflowRunId: string) => `workflow:${workflowRunId}`,
}));

vi.mock("@/lib/workflows/store", () => ({
  getWorkflowStats: mocks.getWorkflowStats,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
  listWorkflowRuns: mocks.listWorkflowRuns,
  transitionWorkflowRunWithEvents: mocks.transitionWorkflowRunWithEvents,
}));

import { reconcileOperationsRecovery } from "@/lib/operations/recovery";

const jobStats: OperationJobStats = {
  total: 1,
  byStatus: {},
  runnable: 0,
  delayed: 0,
  expiredLeases: 0,
  latest: [],
};

const staleRun: WorkflowRunRecord = {
  id: "run-q",
  tenantId: "tenant-a",
  workflowType: "orchestrate",
  status: "running",
  goal: "Index the archive",
  input: {} as WorkflowRunRecord["input"],
  attempt: 1,
  maxAttempts: 3,
  approvalRequired: false,
  createdAt: new Date(Date.now() - 30 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
};

function tick(status: OperationJobRecoveryRow["status"], leaseExpiresAt?: string): OperationJobRecoveryRow {
  return { id: "tick-q", dedupeKey: "workflow:run-q", status, leaseExpiresAt };
}

const quarantineFailure = "Recovery failed the workflow because its queue tick is quarantined.";

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
  mocks.getOperationJobStats.mockResolvedValue(jobStats);
  mocks.getWorkflowStats.mockResolvedValue({} as WorkflowStats);
  mocks.listWorkflowRuns.mockResolvedValue([staleRun]);
  mocks.repairExpiredOperationJobs.mockResolvedValue(0);
  mocks.transitionWorkflowRunWithEvents.mockImplementation(async (_id, _statuses, patch) => ({
    ...staleRun,
    ...patch,
  }));
  mocks.cancelOperationJobByDedupeKey.mockResolvedValue([{ id: "tick-q" }]);
  mocks.requeueOperationJobByDedupeKey.mockResolvedValue([{ id: "tick-q" }]);
});

describe("operations recovery of a workflow whose tick is quarantined", () => {
  it("reports the run should fail, without changing it, on inspection", async () => {
    mocks.listOperationJobRecoveryRows.mockResolvedValue([tick("quarantined")]);

    const report = await reconcileOperationsRecovery({ mode: "inspect", tenantId: "tenant-a" });

    expect(report.staleWorkflows).toEqual([expect.objectContaining({
      workflowRunId: "run-q",
      disposition: "inspect",
      reason: "Workflow's queue tick is quarantined and the workflow should be failed.",
    })]);
    expect(mocks.transitionWorkflowRunWithEvents).not.toHaveBeenCalled();
    expect(mocks.cancelOperationJobByDedupeKey).not.toHaveBeenCalled();
  });

  it("fails a retryable run, and cancels its tick, instead of requeueing it", async () => {
    mocks.listOperationJobRecoveryRows.mockResolvedValue([tick("quarantined")]);

    const report = await reconcileOperationsRecovery({ mode: "repair", tenantId: "tenant-a", actorId: "operator-a" });

    expect(report.failedWorkflows).toBe(1);
    expect(report.requeuedWorkflows).toBe(0);
    expect(report.staleWorkflows).toEqual([expect.objectContaining({
      disposition: "failed",
      reason: quarantineFailure,
      jobIds: ["tick-q"],
    })]);
    expect(mocks.transitionWorkflowRunWithEvents).toHaveBeenCalledWith(
      "run-q",
      ["running"],
      expect.objectContaining({ status: "failed", error: quarantineFailure }),
      [{
        type: "workflow.recovery.failed",
        payload: expect.objectContaining({ actorId: "operator-a", reason: quarantineFailure }),
      }],
      expect.objectContaining({ tenantId: "tenant-a" }),
    );
    expect(mocks.cancelOperationJobByDedupeKey).toHaveBeenCalledWith(
      "workflow:run-q",
      quarantineFailure,
      { tenantId: "tenant-a" },
    );
    expect(mocks.requeueOperationJobByDedupeKey).not.toHaveBeenCalled();
    expect(mocks.enqueueWorkflowRunTick).not.toHaveBeenCalled();
  });

  it("fails a run whose tick this pass's repair quarantined", async () => {
    const lapsedAt = new Date(Date.now() - 1_000).toISOString();
    mocks.listOperationJobRecoveryRows
      .mockResolvedValueOnce([tick("running", lapsedAt)])
      .mockResolvedValueOnce([tick("quarantined")]);
    mocks.repairExpiredOperationJobs.mockResolvedValueOnce(1);

    const report = await reconcileOperationsRecovery({ mode: "repair", tenantId: "tenant-a" });

    expect(mocks.listOperationJobRecoveryRows).toHaveBeenCalledTimes(2);
    expect(report.staleWorkflows).toEqual([expect.objectContaining({
      disposition: "failed",
      reason: quarantineFailure,
    })]);
    expect(mocks.requeueOperationJobByDedupeKey).not.toHaveBeenCalled();
  });

  it("still requeues a stale run whose tick is only queued", async () => {
    // Another run's quarantined tick is that run's to answer for.
    mocks.listOperationJobRecoveryRows.mockResolvedValue([
      tick("queued"),
      { id: "tick-other", dedupeKey: "workflow:run-other", status: "quarantined" },
    ]);

    const report = await reconcileOperationsRecovery({ mode: "repair", tenantId: "tenant-a" });

    expect(report.requeuedWorkflows).toBe(1);
    expect(mocks.listOperationJobRecoveryRows).toHaveBeenCalledTimes(1);
    expect(mocks.requeueOperationJobByDedupeKey).toHaveBeenCalledWith(
      "workflow:run-q",
      "Recovery requeued stale workflow job.",
      { tenantId: "tenant-a" },
    );
    expect(mocks.cancelOperationJobByDedupeKey).not.toHaveBeenCalled();
  });
});
