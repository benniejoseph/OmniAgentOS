import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  processAllTenantAgentResumeQueues: vi.fn(),
  processAllTenantDurableSpecialistQueues: vi.fn(),
  processAllTenantWorkflowQueues: vi.fn(),
  processPendingMemoryDeletionScrubs: vi.fn(),
  processPendingMemoryGraphRebuilds: vi.fn(),
  listMaintenanceTenantIds: vi.fn(),
  recoverInterruptedLoopV2Runs: vi.fn(),
  repairStuckAgentRuns: vi.fn(),
  recoverStaleToolExecutionClaims: vi.fn(),
  processDueDailyBriefs: vi.fn(),
  processDueNotifications: vi.fn(),
  processActiveProjectExecutions: vi.fn(),
  syncDuePersonalProviders: vi.fn(),
  recordSecurityAudit: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
  recordWorkerHeartbeat: vi.fn(),
}));

vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/client")>()),
  runWithDatabaseTenantScope: async (
    _tenantId: string,
    operation: () => Promise<unknown>,
  ) => operation(),
  withDatabaseRequestScope:
    (handler: (request: Request) => Promise<Response>) => handler,
}));

vi.mock("@/lib/security/guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/guard")>()),
  authorizeRequest: routeMocks.authorizeRequest,
}));

vi.mock("@/lib/security/audit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/audit-store")>()),
  recordSecurityAudit: routeMocks.recordSecurityAudit,
}));

vi.mock("@/lib/observability/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/observability/store")>()),
  createRequestTelemetry: () => ({
    requestId: "request-test",
    correlationId: "correlation-test",
  }),
  recordRuntimeEventSafely: routeMocks.recordRuntimeEventSafely,
}));

vi.mock("@/lib/orchestration/resume-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/orchestration/resume-queue")>()),
  processAllTenantAgentResumeQueues:
    routeMocks.processAllTenantAgentResumeQueues,
}));

vi.mock("@/lib/orchestration/loop-v2-recovery", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/orchestration/loop-v2-recovery")
  >()),
  recoverInterruptedLoopV2Runs: routeMocks.recoverInterruptedLoopV2Runs,
}));

vi.mock("@/lib/runs/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/runs/store")>()),
  repairStuckAgentRuns: routeMocks.repairStuckAgentRuns,
}));

vi.mock("@/lib/security/retention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/retention")>()),
  processPendingMemoryGraphRebuilds:
    routeMocks.processPendingMemoryGraphRebuilds,
}));

vi.mock("@/lib/memory/deletion-scrub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/deletion-scrub")>()),
  processPendingMemoryDeletionScrubs:
    routeMocks.processPendingMemoryDeletionScrubs,
}));

vi.mock("@/lib/operations/job-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/job-queue")>()),
  listMaintenanceTenantIds: routeMocks.listMaintenanceTenantIds,
}));

vi.mock("@/lib/tools/audit-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tools/audit-store")>()),
  recoverStaleToolExecutionClaims: routeMocks.recoverStaleToolExecutionClaims,
}));

vi.mock("@/lib/today/briefs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/today/briefs")>()),
  processDueDailyBriefs: routeMocks.processDueDailyBriefs,
}));

vi.mock("@/lib/today/notifications", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/today/notifications")>()),
  processDueNotifications: routeMocks.processDueNotifications,
}));

vi.mock("@/lib/projects/execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects/execution")>()),
  processActiveProjectExecutions: routeMocks.processActiveProjectExecutions,
}));

vi.mock("@/lib/connectors/personal-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/personal-sync")>()),
  syncDuePersonalProviders: routeMocks.syncDuePersonalProviders,
}));

vi.mock("@/lib/subagents/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/subagents/worker")>()),
  processAllTenantDurableSpecialistQueues:
    routeMocks.processAllTenantDurableSpecialistQueues,
}));

vi.mock("@/lib/workflows/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/queue")>()),
  processAllTenantWorkflowQueues: routeMocks.processAllTenantWorkflowQueues,
}));

vi.mock("@/lib/operations/worker-heartbeat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/worker-heartbeat")>()),
  recordWorkerHeartbeat: routeMocks.recordWorkerHeartbeat,
}));

import { POST } from "@/app/api/workflows/tick/route";

const emptyWorkflowQueue = {
  requested: 0,
  leased: 0,
  completed: 0,
  failed: 0,
  stale: 0,
  requeued: 0,
  jobs: [],
  tenantIds: [],
  tenantResults: [],
};

const emptyResumeQueue = {
  tenantIds: [],
  tenantResults: [],
  leased: 0,
  completed: 0,
  deferred: 0,
  failed: 0,
};

const emptySpecialistQueue = {
  tenantIds: [],
  tenantResults: [],
  leased: 0,
  completed: 0,
  failed: 0,
  stale: 0,
};

beforeEach(() => {
  vi.stubEnv("OMNIAGENT_WORKER_PROTOCOL_VERSION", "1");
  routeMocks.authorizeRequest.mockReset().mockResolvedValue({
    tenantId: "system",
    actorId: "dedicated-worker",
    role: "system",
  });
  routeMocks.processAllTenantWorkflowQueues
    .mockReset()
    .mockResolvedValue(emptyWorkflowQueue);
  routeMocks.processAllTenantAgentResumeQueues
    .mockReset()
    .mockResolvedValue(emptyResumeQueue);
  routeMocks.processAllTenantDurableSpecialistQueues
    .mockReset()
    .mockResolvedValue(emptySpecialistQueue);
  routeMocks.processPendingMemoryGraphRebuilds
    .mockReset()
    .mockResolvedValue({ processed: 0 });
  routeMocks.processPendingMemoryDeletionScrubs
    .mockReset()
    .mockResolvedValue({ scrubbedMemories: 0, overdueReceiptIds: [] });
  routeMocks.listMaintenanceTenantIds
    .mockReset()
    .mockResolvedValue([]);
  routeMocks.recoverInterruptedLoopV2Runs
    .mockReset()
    .mockResolvedValue(emptyLoopV2Recovery);
  routeMocks.repairStuckAgentRuns.mockReset().mockResolvedValue(0);
  routeMocks.recoverStaleToolExecutionClaims.mockReset().mockResolvedValue([]);
  routeMocks.processDueDailyBriefs.mockReset().mockResolvedValue([]);
  routeMocks.processDueNotifications.mockReset().mockResolvedValue([]);
  routeMocks.processActiveProjectExecutions.mockReset().mockResolvedValue([]);
  routeMocks.syncDuePersonalProviders.mockReset().mockResolvedValue([]);
  routeMocks.recordRuntimeEventSafely.mockReset().mockResolvedValue(undefined);
  routeMocks.recordSecurityAudit.mockReset().mockResolvedValue(undefined);
  routeMocks.recordWorkerHeartbeat.mockReset().mockImplementation(async (input) => ({
    ...input,
    recordedAt: "2026-08-26T12:00:00.000Z",
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("dedicated worker heartbeat timing", () => {
  it("persists startup registration before responding without beginning scheduled work", async () => {
    const heartbeatGate = createGate();
    const order: string[] = [];
    routeMocks.recordWorkerHeartbeat.mockImplementation(async (input) => {
      order.push("heartbeat-started");
      await heartbeatGate.promise;
      order.push("heartbeat-recorded");
      return {
        ...input,
        recordedAt: "2026-08-26T12:00:00.000Z",
      };
    });
    routeMocks.processAllTenantWorkflowQueues.mockImplementation(async () => {
      order.push("scheduled-work");
      return emptyWorkflowQueue;
    });

    const responsePromise = POST(workerRequest({ startup: true }));

    await vi.waitFor(() => {
      expect(routeMocks.recordWorkerHeartbeat).toHaveBeenCalledOnce();
    });
    expect(routeMocks.processAllTenantWorkflowQueues).not.toHaveBeenCalled();

    heartbeatGate.release();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      startup: true,
      lane: "fast",
      count: 0,
    });
    expect(order).toEqual(["heartbeat-started", "heartbeat-recorded"]);
    expect(routeMocks.processAllTenantWorkflowQueues).not.toHaveBeenCalled();
    expect(routeMocks.recordWorkerHeartbeat).toHaveBeenCalledWith({
      instanceId: "worker-test",
      lane: "fast",
      phase: "startup",
      protocol: "1",
      revision: "release-test",
      target: "http://localhost",
    });
  });

  it("records an ordinary heartbeat only after scheduled work succeeds", async () => {
    const workGate = createGate();
    const order: string[] = [];
    routeMocks.processAllTenantWorkflowQueues.mockImplementation(async () => {
      order.push("scheduled-work-started");
      await workGate.promise;
      order.push("scheduled-work-completed");
      return emptyWorkflowQueue;
    });
    routeMocks.recordWorkerHeartbeat.mockImplementation(async (input) => {
      order.push("heartbeat-recorded");
      return {
        ...input,
        recordedAt: "2026-08-26T12:00:00.000Z",
      };
    });

    const responsePromise = POST(workerRequest({ startup: false }));

    await vi.waitFor(() => {
      expect(routeMocks.processAllTenantWorkflowQueues).toHaveBeenCalledOnce();
    });
    expect(routeMocks.recordWorkerHeartbeat).not.toHaveBeenCalled();

    workGate.release();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(order).toEqual([
      "scheduled-work-started",
      "scheduled-work-completed",
      "heartbeat-recorded",
    ]);
    expect(routeMocks.recordWorkerHeartbeat).toHaveBeenCalledWith({
      instanceId: "worker-test",
      lane: "fast",
      phase: "active",
      protocol: "1",
      revision: "release-test",
      target: "http://localhost",
    });
  });

  it("does not publish an ordinary heartbeat when scheduled work fails", async () => {
    routeMocks.processAllTenantWorkflowQueues.mockRejectedValue(
      new Error("scheduled work failed"),
    );

    const response = await POST(workerRequest({ startup: false }));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "scheduled work failed",
    });
    expect(routeMocks.recordWorkerHeartbeat).not.toHaveBeenCalled();
  });

  it("rejects a worker pinned to another origin before heartbeat or work", async () => {
    const response = await POST(workerRequest({
      startup: true,
      target: "https://staged.example.test",
    }));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "Worker target mismatch",
    });
    expect(routeMocks.recordWorkerHeartbeat).not.toHaveBeenCalled();
    expect(routeMocks.processAllTenantWorkflowQueues).not.toHaveBeenCalled();
  });

  it("recovers fenced Loop v2 work before generic stale-run repair", async () => {
    const order: string[] = [];
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.recoverInterruptedLoopV2Runs.mockImplementation(async () => {
      order.push("loop-v2-recovery");
      return {
        ...emptyLoopV2Recovery,
        claimed: 1,
        failedClosed: 1,
        results: [{
          runId: "run-a",
          action: "fail_closed",
          outcome: "failed_closed",
          reasonCode: "non_replayable_model_boundary",
        }],
      };
    });
    routeMocks.repairStuckAgentRuns.mockImplementation(async () => {
      order.push("generic-repair");
      return 0;
    });

    const response = await POST(workerRequest({
      startup: false,
      lane: "maintenance",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      maintenance: [{
        tenantId: "tenant-a",
        agentRunsRepaired: 0,
        loopV2Recovery: { claimed: 1, failedClosed: 1 },
      }],
      idle: false,
    });
    expect(order).toEqual(["loop-v2-recovery", "generic-repair"]);
    expect(routeMocks.recoverInterruptedLoopV2Runs).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 1,
    });
  });
});

function workerRequest({
  startup,
  target = "http://localhost",
  lane = "fast",
}: {
  startup: boolean;
  target?: string;
  lane?: "fast" | "background" | "maintenance" | "all";
}) {
  return new Request("http://localhost/api/workflows/tick", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-omni-worker-instance": "worker-test",
      "x-omni-worker-protocol": "1",
      "x-omni-worker-revision": "release-test",
      "x-omni-worker-target": target,
    },
    body: JSON.stringify({
      scope: "all_tenants",
      lane,
      startup,
      timeBudgetMs: 1_000,
    }),
  });
}

const emptyLoopV2Recovery = {
  claimed: 0,
  resumed: 0,
  waitingClarification: 0,
  failedClosed: 0,
  deferred: 0,
  results: [],
};

function createGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
