import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  authorizeRequest: vi.fn(),
  processAllTenantAgentResumeQueues: vi.fn(),
  processAllTenantDurableSpecialistQueues: vi.fn(),
  processAllTenantWorkflowQueues: vi.fn(),
  processDueWorkflowSchedules: vi.fn(),
  processDueWorkflowSchedulesForTenant: vi.fn(),
  processPendingMemoryDeletionScrubs: vi.fn(),
  processPendingMemoryGraphRebuilds: vi.fn(),
  processPendingTemporalRelationProjections: vi.fn(),
  scrubExpiredLocalComputerObservations: vi.fn(),
  runTenantMemoryMaintenance: vi.fn(),
  listMaintenanceTenantIds: vi.fn(),
  recoverInterruptedLoopV2Runs: vi.fn(),
  repairStuckAgentRuns: vi.fn(),
  reconcileMissionProjections: vi.fn(),
  recoverStaleToolExecutionClaims: vi.fn(),
  processDueDailyBriefs: vi.fn(),
  processDueNotifications: vi.fn(),
  processDomainMobilePushProducers: vi.fn(),
  dispatchMobilePushDeliveries: vi.fn(),
  processActiveProjectExecutions: vi.fn(),
  syncDuePersonalProviders: vi.fn(),
  syncDueSalesforceConnections: vi.fn(),
  processDueMoltbookHeartbeats: vi.fn(),
  processDueMoltbookAutonomyCycles: vi.fn(),
  processProactiveAgentAdaptationProposalsForTenant: vi.fn(),
  recordSecurityAudit: vi.fn(),
  recordRuntimeEventSafely: vi.fn(),
  recordWorkerHeartbeat: vi.fn(),
  reconcileAbandonedExternalA2ATasks: vi.fn(),
  reconcileCheckpointShadowsDaily: vi.fn(),
  processWorkflowQueue: vi.fn(),
  processAgentResumeQueue: vi.fn(),
  processDurableSpecialistQueue: vi.fn(),
  processBackgroundOperationQueue: vi.fn(),
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
  processAgentResumeQueue: routeMocks.processAgentResumeQueue,
}));

vi.mock("@/lib/operations/background-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/background-jobs")>()),
  processBackgroundOperationQueue: routeMocks.processBackgroundOperationQueue,
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

vi.mock("@/lib/missions/reconcile", () => ({
  reconcileMissionProjections: routeMocks.reconcileMissionProjections,
}));

vi.mock("@/lib/security/retention", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/security/retention")>()),
  processPendingMemoryGraphRebuilds:
    routeMocks.processPendingMemoryGraphRebuilds,
}));

vi.mock("@/lib/local-computer/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/local-computer/store")>()),
  scrubExpiredLocalComputerObservations:
    routeMocks.scrubExpiredLocalComputerObservations,
}));

vi.mock("@/lib/memory/deletion-scrub", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/deletion-scrub")>()),
  processPendingMemoryDeletionScrubs:
    routeMocks.processPendingMemoryDeletionScrubs,
}));

vi.mock("@/lib/entities/relation-projection-queue", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/entities/relation-projection-queue")
  >()),
  processPendingTemporalRelationProjections:
    routeMocks.processPendingTemporalRelationProjections,
}));

vi.mock("@/lib/memory/maintenance-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/memory/maintenance-store")>()),
  runTenantMemoryMaintenance: routeMocks.runTenantMemoryMaintenance,
}));

vi.mock("@/lib/operations/job-queue", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/operations/job-queue")>();
  return {
    ...actual,
    listMaintenanceTenantIds: routeMocks.listMaintenanceTenantIds,
    listRunnableOperationDispatchTenants: vi.fn(
      actual.listRunnableOperationDispatchTenants,
    ),
  };
});

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

vi.mock("@/lib/mobile/push-store", () => ({
  dispatchMobilePushDeliveries: routeMocks.dispatchMobilePushDeliveries,
}));

vi.mock("@/lib/mobile/push-producers", () => ({
  processDomainMobilePushProducers:
    routeMocks.processDomainMobilePushProducers,
}));

vi.mock("@/lib/projects/execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects/execution")>()),
  processActiveProjectExecutions: routeMocks.processActiveProjectExecutions,
}));

vi.mock("@/lib/connectors/personal-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connectors/personal-sync")>()),
  syncDuePersonalProviders: routeMocks.syncDuePersonalProviders,
}));

vi.mock("@/lib/customer-success/salesforce-sync", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/customer-success/salesforce-sync")>()),
  syncDueSalesforceConnections: routeMocks.syncDueSalesforceConnections,
}));

vi.mock("@/lib/moltbook/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moltbook/store")>()),
  processDueMoltbookHeartbeats: routeMocks.processDueMoltbookHeartbeats,
}));

vi.mock("@/lib/moltbook/autonomy-runner", () => ({
  processDueMoltbookAutonomyCycles:
    routeMocks.processDueMoltbookAutonomyCycles,
}));

vi.mock("@/lib/agents/adaptation-proposals", () => ({
  processProactiveAgentAdaptationProposalsForTenant:
    routeMocks.processProactiveAgentAdaptationProposalsForTenant,
}));

vi.mock("@/lib/subagents/worker", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/subagents/worker")>()),
  processAllTenantDurableSpecialistQueues:
    routeMocks.processAllTenantDurableSpecialistQueues,
  processDurableSpecialistQueue: routeMocks.processDurableSpecialistQueue,
}));

vi.mock("@/lib/workflows/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/queue")>()),
  processAllTenantWorkflowQueues: routeMocks.processAllTenantWorkflowQueues,
  processWorkflowQueue: routeMocks.processWorkflowQueue,
}));

vi.mock("@/lib/workflows/triggers", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflows/triggers")>()),
  processDueWorkflowSchedules: routeMocks.processDueWorkflowSchedules,
  processDueWorkflowSchedulesForTenant: routeMocks.processDueWorkflowSchedulesForTenant,
}));

vi.mock("@/lib/operations/worker-heartbeat", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/operations/worker-heartbeat")>()),
  recordWorkerHeartbeat: routeMocks.recordWorkerHeartbeat,
}));

vi.mock("@/lib/a2a/maintenance", () => ({
  reconcileAbandonedExternalA2ATasks:
    routeMocks.reconcileAbandonedExternalA2ATasks,
}));

vi.mock("@/lib/runs/checkpoint-shadow-reconciliation", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/runs/checkpoint-shadow-reconciliation")
  >()),
  reconcileCheckpointShadowsDaily: routeMocks.reconcileCheckpointShadowsDaily,
}));

import { POST } from "@/app/api/workflows/tick/route";
import { listRunnableOperationDispatchTenants } from "@/lib/operations/job-queue";
import { emptyWorkflowScheduleTotals } from "@/lib/workflows/triggers";

const emptyWorkflowQueue = {
  requested: 0,
  leased: 0,
  completed: 0,
  failed: 0,
  stale: 0,
  waiting: 0,
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
  routeMocks.processDueWorkflowSchedules
    .mockReset()
    .mockResolvedValue(emptyWorkflowScheduleTotals());
  routeMocks.processDueWorkflowSchedulesForTenant
    .mockReset()
    .mockResolvedValue(emptyWorkflowScheduleTotals());
  routeMocks.scrubExpiredLocalComputerObservations
    .mockReset()
    .mockResolvedValue({ scrubbed: 0, moreAvailable: false });
  routeMocks.processAllTenantAgentResumeQueues
    .mockReset()
    .mockResolvedValue(emptyResumeQueue);
  routeMocks.runTenantMemoryMaintenance.mockReset().mockResolvedValue({
    report: {
      policyVersion: 1,
      scanned: 0,
      eligible: 0,
      exactDuplicateGroups: 0,
      autoArchivedDuplicates: 0,
      pinnedDuplicateConflicts: 0,
      promotionReviewsCreated: 0,
      expiredArchived: 0,
      duplicateRateBefore: 0,
      duplicateRateAfter: 0,
      duplicateRateTarget: 0.01,
    },
    reviews: [],
  });
  routeMocks.processAllTenantDurableSpecialistQueues
    .mockReset()
    .mockResolvedValue(emptySpecialistQueue);
  routeMocks.processPendingMemoryGraphRebuilds
    .mockReset()
    .mockResolvedValue({ processed: 0 });
  routeMocks.processPendingTemporalRelationProjections
    .mockReset()
    .mockResolvedValue({ processed: 0, completed: 0, failed: 0 });
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
  routeMocks.reconcileMissionProjections
    .mockReset()
    .mockResolvedValue({ repaired: 0, failed: 0 });
  routeMocks.recoverStaleToolExecutionClaims.mockReset().mockResolvedValue([]);
  routeMocks.reconcileAbandonedExternalA2ATasks.mockReset().mockResolvedValue({
    scanned: 0,
    expired: 0,
    canceled: 0,
    alreadyTerminal: 0,
    failed: 0,
    results: [],
  });
  routeMocks.processDueDailyBriefs.mockReset().mockResolvedValue([]);
  routeMocks.processDueNotifications.mockReset().mockResolvedValue([]);
  routeMocks.processDomainMobilePushProducers.mockReset().mockResolvedValue({
    scanned: 0,
    queued: 0,
    queuedByKind: { approval: 0, meeting: 0, customer: 0, run: 0 },
    skippedByPreference: 0,
  });
  routeMocks.dispatchMobilePushDeliveries.mockReset().mockResolvedValue({
    processed: 0,
    providerAccepted: 0,
    retried: 0,
    failed: 0,
    unsettled: 0,
  });
  routeMocks.processActiveProjectExecutions.mockReset().mockResolvedValue([]);
  routeMocks.syncDuePersonalProviders.mockReset().mockResolvedValue([]);
  routeMocks.processWorkflowQueue.mockReset().mockResolvedValue({
    leased: 0,
    completed: 0,
    failed: 0,
  });
  routeMocks.processAgentResumeQueue.mockReset().mockResolvedValue({});
  routeMocks.processDurableSpecialistQueue.mockReset().mockResolvedValue({});
  routeMocks.processBackgroundOperationQueue.mockReset().mockResolvedValue({});
  routeMocks.syncDueSalesforceConnections.mockReset().mockResolvedValue([]);
  routeMocks.processDueMoltbookHeartbeats.mockReset().mockResolvedValue({
    processed: 0,
    healthy: 0,
    failed: 0,
    skipped: 0,
  });
  routeMocks.processDueMoltbookAutonomyCycles.mockReset().mockResolvedValue({
    processed: 0,
    succeeded: 0,
    failed: 0,
    paused: 0,
    results: [],
  });
  routeMocks.processProactiveAgentAdaptationProposalsForTenant
    .mockReset()
    .mockResolvedValue({
      processed: 0,
      proposed: 0,
      held: 0,
      failed: 0,
      results: [],
    });
  routeMocks.reconcileCheckpointShadowsDaily
    .mockReset()
    .mockResolvedValue({ status: "skipped" });
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
  it("scrubs expired local screenshots on every fast-lane pass", async () => {
    routeMocks.scrubExpiredLocalComputerObservations.mockResolvedValue({
      scrubbed: 2,
      moreAvailable: false,
    });

    const response = await POST(workerRequest({ startup: false }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      localComputerObservationScrub: { scrubbed: 2 },
      idle: false,
      activityCount: 2,
    });
    expect(routeMocks.scrubExpiredLocalComputerObservations).toHaveBeenCalledWith({
      limit: 100,
    });
  });

  it("runs every tenant's due schedules ahead of the dispatch snapshot on each fast pass", async () => {
    routeMocks.processDueWorkflowSchedules.mockResolvedValue({
      ownerActors: 3,
      ownerFailures: 1,
      shadowEvaluated: 2,
      occurrencesClaimed: 3,
      occurrencesEnqueued: 4,
      occurrencesSkipped: 5,
      occurrencesMissed: 6,
      occurrencesFailed: 7,
      occurrencesReconciled: 8,
    });

    const before = Date.now();
    const response = await POST(workerRequest({ startup: false, timeBudgetMs: 60_000 }));
    const after = Date.now();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      workflowSchedules: { ownerActors: 3, occurrencesEnqueued: 4, occurrencesMissed: 6 },
      idle: false,
      // Every count except the owner failure, which changed nothing.
      activityCount: 35,
    });
    expect(routeMocks.processDueWorkflowSchedules).toHaveBeenCalledOnce();
    const [input] = routeMocks.processDueWorkflowSchedules.mock.calls[0];
    expect(input).toEqual({
      systemActorId: "dedicated-worker",
      correlationId: "correlation-test",
      limit: 20,
      deadlineAt: expect.any(Number),
    });
    // Half of the pass's budget, so dispatch keeps the rest.
    expect(input.deadlineAt).toBeGreaterThanOrEqual(before + 30_000);
    expect(input.deadlineAt).toBeLessThanOrEqual(after + 30_000);
    // The run a schedule queues must be in the snapshot this pass dispatches.
    expect(routeMocks.processDueWorkflowSchedules.mock.invocationCallOrder[0])
      .toBeLessThan(
        vi.mocked(listRunnableOperationDispatchTenants).mock.invocationCallOrder.at(-1)!,
      );
    expect(routeMocks.recordSecurityAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        scheduleShadowOccurrencesEvaluated: 2,
        scheduleOccurrencesClaimed: 3,
        scheduleOccurrencesEnqueued: 4,
        scheduleOccurrencesSkipped: 5,
        scheduleOccurrencesMissed: 6,
        scheduleOccurrencesFailed: 7,
        scheduleOccurrencesReconciled: 8,
        scheduleOwnerFailures: 1,
        schedulePassFailures: 0,
      }),
    }));
  });

  it("adds tenant maintenance's schedule work to the fast pass's and stops it at the pass deadline", async () => {
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.processDueWorkflowSchedules.mockResolvedValue({
      ...emptyWorkflowScheduleTotals(),
      ownerActors: 1,
      occurrencesClaimed: 1,
      occurrencesMissed: 3,
    });
    routeMocks.processDueWorkflowSchedulesForTenant.mockResolvedValue({
      ...emptyWorkflowScheduleTotals(),
      ownerActors: 1,
      ownerFailures: 1,
      occurrencesMissed: 2,
      occurrencesReconciled: 4,
    });

    const before = Date.now();
    const response = await POST(workerRequest({
      startup: false,
      lane: "all",
      timeBudgetMs: 60_000,
    }));
    const after = Date.now();

    expect(response.status).toBe(200);
    expect(routeMocks.processDueWorkflowSchedulesForTenant).toHaveBeenCalledOnce();
    const [input] = routeMocks.processDueWorkflowSchedulesForTenant.mock.calls[0];
    expect(input).toEqual({
      tenantId: "tenant-a",
      systemActorId: "dedicated-worker",
      correlationId: "correlation-test",
      limit: 10,
      deadlineAt: expect.any(Number),
    });
    expect(input.deadlineAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(input.deadlineAt).toBeLessThanOrEqual(after + 60_000);
    expect(routeMocks.recordSecurityAudit).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        scheduleOccurrencesClaimed: 1,
        scheduleOccurrencesMissed: 5,
        scheduleOccurrencesReconciled: 4,
        scheduleOwnerFailures: 1,
      }),
    }));
  });

  it("leaves due schedules to the fast pass", async () => {
    for (const lane of ["background", "maintenance"] as const) {
      const response = await POST(workerRequest({ startup: false, lane }));
      expect(response.status).toBe(200);
    }
    expect(routeMocks.processDueWorkflowSchedules).not.toHaveBeenCalled();

    const response = await POST(workerRequest({ startup: false, lane: "all" }));
    expect(response.status).toBe(200);
    expect(routeMocks.processDueWorkflowSchedules).toHaveBeenCalledOnce();
  });

  it("reports a failed schedule pass and still dispatches queued work", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.processDueWorkflowSchedules.mockRejectedValue(
      new Error("schedule discovery failed password=hunter2-secret"),
    );
    routeMocks.processAllTenantWorkflowQueues.mockResolvedValue({
      ...emptyWorkflowQueue,
      leased: 1,
      completed: 1,
    });
    try {
      const response = await POST(workerRequest({ startup: false }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        workflowSchedules: emptyWorkflowScheduleTotals(),
        idle: false,
        activityCount: 2,
      });
      expect(body.workflowSchedulesError).toContain("schedule discovery failed");
      expect(JSON.stringify(body)).not.toContain("hunter2-secret");
      expect(routeMocks.processAllTenantWorkflowQueues).toHaveBeenCalledOnce();
      expect(routeMocks.recordSecurityAudit).toHaveBeenCalledWith(expect.objectContaining({
        metadata: expect.objectContaining({
          schedulePassFailures: 1,
          scheduleOwnerFailures: 0,
        }),
      }));
      expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
        level: "error",
        msg: "workflow_schedules_failed",
        error: body.workflowSchedulesError,
      }));
      expect(errorLog.mock.calls.flat().join(" ")).not.toContain("hunter2-secret");
    } finally {
      errorLog.mockRestore();
    }
  });

  it("stays idle when the only schedule work failed, so the fast lane backs off", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      routeMocks.processDueWorkflowSchedules.mockResolvedValueOnce({
        ...emptyWorkflowScheduleTotals(),
        ownerActors: 1,
        ownerFailures: 1,
      });
      const ownerFailed = await POST(workerRequest({ startup: false }));
      await expect(ownerFailed.json()).resolves.toMatchObject({
        workflowSchedules: { ownerActors: 1, ownerFailures: 1 },
        idle: true,
        activityCount: 0,
      });

      routeMocks.processDueWorkflowSchedules.mockRejectedValueOnce(
        new Error("schedule discovery failed"),
      );
      const passFailed = await POST(workerRequest({ startup: false }));
      const body = await passFailed.json();
      expect(body).toMatchObject({ idle: true, activityCount: 0 });
      expect(body.workflowSchedulesError).toContain("schedule discovery failed");

      expect(routeMocks.processDueWorkflowSchedules).toHaveBeenCalledTimes(2);
      expect(routeMocks.recordSecurityAudit).not.toHaveBeenCalled();
      expect(routeMocks.recordRuntimeEventSafely).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it("stays idle when every leased tick went back to wait on specialists", async () => {
    routeMocks.processAllTenantWorkflowQueues.mockResolvedValueOnce({
      ...emptyWorkflowQueue,
      leased: 2,
      waiting: 2,
    });
    const waited = await POST(workerRequest({ startup: false }));
    await expect(waited.json()).resolves.toMatchObject({
      idle: true,
      activityCount: 0,
    });
    expect(routeMocks.recordSecurityAudit).not.toHaveBeenCalled();
    expect(routeMocks.recordRuntimeEventSafely).not.toHaveBeenCalled();

    // A tick woken because its specialists finished has work to run.
    routeMocks.processAllTenantWorkflowQueues.mockResolvedValueOnce({
      ...emptyWorkflowQueue,
      leased: 1,
      waiting: 1,
      requeued: 1,
    });
    const woken = await POST(workerRequest({ startup: false }));
    await expect(woken.json()).resolves.toMatchObject({
      idle: false,
      activityCount: 1,
    });
  });

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
    const body = await response.json();
    expect(body).toMatchObject({
      error: "Workflow tick failed.",
      code: "internal_error",
    });
    expect(JSON.stringify(body)).not.toContain("scheduled work failed");
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
        externalDelegationsTerminated: 0,
        loopV2Recovery: { claimed: 1, failedClosed: 1 },
      }],
      idle: false,
    });
    expect(order).toEqual(["loop-v2-recovery", "generic-repair"]);
    expect(routeMocks.recoverInterruptedLoopV2Runs).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 1,
    });
    expect(routeMocks.reconcileAbandonedExternalA2ATasks).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 5,
    });
    expect(routeMocks.processDueMoltbookHeartbeats).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 2,
    });
  });

  it("replays missed mission updates after stale-run repair", async () => {
    const order: string[] = [];
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.repairStuckAgentRuns.mockImplementation(async () => {
      order.push("generic-repair");
      return 1;
    });
    routeMocks.reconcileMissionProjections.mockImplementation(async () => {
      order.push("mission-repair");
      return { repaired: 3, failed: 1 };
    });

    const response = await POST(workerRequest({
      startup: false,
      lane: "maintenance",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      maintenance: [{
        tenantId: "tenant-a",
        agentRunsRepaired: 1,
        missionProjectionsRepaired: 3,
      }],
    });
    expect(order).toEqual(["generic-repair", "mission-repair"]);
    expect(routeMocks.reconcileMissionProjections.mock.calls).toEqual([
      [{ tenantId: "tenant-a" }],
    ]);
  });

  it("keeps a tenant's maintenance results when mission repair fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.repairStuckAgentRuns.mockResolvedValue(2);
    routeMocks.reconcileMissionProjections.mockRejectedValue(
      new Error("untrusted mission storage detail"),
    );

    try {
      const response = await POST(workerRequest({
        startup: false,
        lane: "maintenance",
      }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.maintenance).toEqual([
        expect.objectContaining({
          tenantId: "tenant-a",
          agentRunsRepaired: 2,
          missionProjectionsRepaired: 0,
        }),
      ]);
      expect(body.maintenance[0]).not.toHaveProperty("maintenanceError");
      expect(routeMocks.recoverStaleToolExecutionClaims).toHaveBeenCalledWith({
        tenantId: "tenant-a",
      });
      expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
        level: "error",
        msg: "mission_projection_reconciliation_failed",
        tenantId: "tenant-a",
      }));
      expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
        "untrusted mission storage detail",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("prioritizes a due Moltbook autonomy cycle before slower tenant maintenance", async () => {
    const order: string[] = [];
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.processDueMoltbookAutonomyCycles.mockImplementation(async () => {
      order.push("moltbook-autonomy");
      return {
        processed: 1,
        succeeded: 1,
        failed: 0,
        paused: 0,
        results: [],
      };
    });
    routeMocks.runTenantMemoryMaintenance.mockImplementation(async () => {
      order.push("memory-maintenance");
      return {
        report: {
          policyVersion: 1,
          scanned: 0,
          eligible: 0,
          exactDuplicateGroups: 0,
          autoArchivedDuplicates: 0,
          pinnedDuplicateConflicts: 0,
          promotionReviewsCreated: 0,
          expiredArchived: 0,
          duplicateRateBefore: 0,
          duplicateRateAfter: 0,
          duplicateRateTarget: 0.01,
        },
        reviews: [],
      };
    });

    const response = await POST(workerRequest({
      startup: false,
      lane: "maintenance",
      timeBudgetMs: 240_000,
    }));

    expect(response.status).toBe(200);
    expect(order).toEqual(["moltbook-autonomy", "memory-maintenance"]);
    expect(routeMocks.processDueMoltbookAutonomyCycles).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 1,
      abortSignal: expect.any(AbortSignal),
    });
    await expect(response.json()).resolves.toMatchObject({
      maintenance: [{ moltbookAutonomyCyclesProcessed: 1 }],
    });
  });

  it("runs one bounded proactive adaptation proposal after project maintenance", async () => {
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.processProactiveAgentAdaptationProposalsForTenant
      .mockResolvedValue({
        processed: 1,
        proposed: 1,
        held: 0,
        failed: 0,
        results: [{
          actorId: "actor:owner",
          agentId: "scout",
          status: "proposed",
        }],
      });

    const response = await POST(workerRequest({
      startup: false,
      lane: "maintenance",
      timeBudgetMs: 240_000,
    }));

    expect(response.status).toBe(200);
    expect(
      routeMocks.processProactiveAgentAdaptationProposalsForTenant,
    ).toHaveBeenCalledWith({
      tenantId: "tenant-a",
      limit: 1,
      abortSignal: expect.any(AbortSignal),
    });
    await expect(response.json()).resolves.toMatchObject({
      maintenance: [{
        tenantId: "tenant-a",
        adaptationProposalsProcessed: 1,
        adaptationProposalsCreated: 1,
      }],
    });
    expect(routeMocks.recordSecurityAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          adaptationProposalsProcessed: 1,
          adaptationProposalsCreated: 1,
        }),
      }),
    );
  });

  it("keeps tenant maintenance running when the shadow proposal lane fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.processProactiveAgentAdaptationProposalsForTenant
      .mockRejectedValue(new Error("untrusted model transport detail"));

    try {
      const response = await POST(workerRequest({
        startup: false,
        lane: "maintenance",
        timeBudgetMs: 240_000,
      }));

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        maintenance: [{
          tenantId: "tenant-a",
          adaptationProposalsProcessed: 0,
          adaptationProposalsCreated: 0,
          connectedSourcesSynced: 0,
        }],
      });
      expect(routeMocks.syncDuePersonalProviders).toHaveBeenCalledWith({
        tenantId: "tenant-a",
        limit: 1,
        abortSignal: expect.any(AbortSignal),
      });
      expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
        level: "error",
        msg: "agent_adaptation_proposal_cycle_failed",
        tenantId: "tenant-a",
      }));
      expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
        "untrusted model transport detail",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("checks each tenant's checkpoint shadow last, when maintenance has time for it", async () => {
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    const order: string[] = [];
    routeMocks.processDueMoltbookHeartbeats.mockImplementation(async () => {
      order.push("moltbook-heartbeats");
      return { processed: 0, healthy: 0, failed: 0, skipped: 0 };
    });
    routeMocks.reconcileCheckpointShadowsDaily.mockImplementation(async () => {
      order.push("checkpoint-shadow");
      return {
        status: "matched",
        mode: "approval",
        sampledRunCount: 3,
        mismatchedRunCount: 0,
        matchedDays: 7,
      };
    });

    const response = await POST(workerRequest({
      startup: false,
      lane: "maintenance",
      timeBudgetMs: 240_000,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      maintenance: [{
        tenantId: "tenant-a",
        checkpointShadowReconciliation: { status: "matched", matchedDays: 7 },
      }],
    });
    expect(routeMocks.reconcileCheckpointShadowsDaily).toHaveBeenCalledWith({
      tenantId: "tenant-a",
    });
    expect(order).toEqual(["moltbook-heartbeats", "checkpoint-shadow"]);

    routeMocks.reconcileCheckpointShadowsDaily.mockClear();
    await POST(workerRequest({
      startup: false,
      lane: "maintenance",
      timeBudgetMs: 10_000,
    }));
    expect(routeMocks.reconcileCheckpointShadowsDaily).not.toHaveBeenCalled();
  });

  it("keeps a tenant's maintenance results when its checkpoint shadow check fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);
    routeMocks.repairStuckAgentRuns.mockResolvedValue(2);
    routeMocks.reconcileCheckpointShadowsDaily.mockRejectedValue(
      new Error("untrusted rollout storage detail"),
    );

    try {
      const response = await POST(workerRequest({
        startup: false,
        lane: "maintenance",
        timeBudgetMs: 240_000,
      }));

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.maintenance).toEqual([
        expect.objectContaining({ tenantId: "tenant-a", agentRunsRepaired: 2 }),
      ]);
      expect(body.maintenance[0]).not.toHaveProperty("maintenanceError");
      expect(body.maintenance[0]).not.toHaveProperty(
        "checkpointShadowReconciliation",
      );
      expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
        level: "error",
        msg: "checkpoint_shadow_reconciliation_failed",
        tenantId: "tenant-a",
      }));
      expect(errorLog.mock.calls.flat().join(" ")).not.toContain(
        "untrusted rollout storage detail",
      );
    } finally {
      errorLog.mockRestore();
    }
  });

  it("serializes system-scope maintenance work before listing tenants", async () => {
    const graphGate = createGate();
    const order: string[] = [];
    routeMocks.processPendingMemoryGraphRebuilds.mockImplementation(async () => {
      order.push("graph-started");
      await graphGate.promise;
      order.push("graph-completed");
      return { processed: 0, completed: 0, failed: 0 };
    });
    routeMocks.processPendingTemporalRelationProjections.mockImplementation(
      async () => {
        order.push("relations");
        return { processed: 0, completed: 0, failed: 0 };
      },
    );
    routeMocks.processPendingMemoryDeletionScrubs.mockImplementation(async () => {
      order.push("deletion-scrubs");
      return { scrubbedMemories: 0, overdueReceiptIds: [] };
    });
    routeMocks.listMaintenanceTenantIds.mockImplementation(async () => {
      order.push("tenant-list");
      return [];
    });

    const responsePromise = POST(workerRequest({
      startup: false,
      lane: "maintenance",
    }));

    await vi.waitFor(() => {
      expect(order).toEqual(["graph-started"]);
    });
    expect(
      routeMocks.processPendingTemporalRelationProjections,
    ).not.toHaveBeenCalled();
    expect(routeMocks.processPendingMemoryDeletionScrubs).not.toHaveBeenCalled();
    expect(routeMocks.listMaintenanceTenantIds).not.toHaveBeenCalled();

    graphGate.release();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(order).toEqual([
      "graph-started",
      "graph-completed",
      "relations",
      "deletion-scrubs",
      "tenant-list",
    ]);
  });

  it("runs tenant maintenance when the deletion scrub fails", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      routeMocks.processPendingMemoryDeletionScrubs.mockRejectedValue(
        new Error("Memory write intersects a permanent deletion barrier"),
      );
      routeMocks.listMaintenanceTenantIds.mockResolvedValue(["tenant-a"]);

      const response = await POST(workerRequest({
        startup: false,
        lane: "maintenance",
      }));

      expect(response.status).toBe(200);
      expect(routeMocks.listMaintenanceTenantIds).toHaveBeenCalled();
      expect(routeMocks.recoverInterruptedLoopV2Runs).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: "tenant-a" }),
      );
      expect(errorLog).toHaveBeenCalledWith(JSON.stringify({
        level: "error",
        msg: "memory_deletion_scrub_failed",
        error: "Memory write intersects a permanent deletion barrier",
      }));
    } finally {
      errorLog.mockRestore();
    }
  });

  it("continues to later tenants when one maintenance tenant fails", async () => {
    routeMocks.listMaintenanceTenantIds.mockResolvedValue([
      "tenant-poisoned",
      "tenant-personal",
    ]);
    routeMocks.recoverInterruptedLoopV2Runs.mockImplementation(
      async ({ tenantId }: { tenantId: string }) => {
        if (tenantId === "tenant-poisoned") {
          throw new Error("Domain event id is already bound to a different event.");
        }
        return emptyLoopV2Recovery;
      },
    );

    const response = await POST(workerRequest({
      startup: false,
      lane: "maintenance",
      timeBudgetMs: 10_000,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      maintenanceTenantIds: ["tenant-poisoned", "tenant-personal"],
      maintenance: [
        {
          tenantId: "tenant-poisoned",
          maintenanceError:
            "Domain event id is already bound to a different event.",
        },
        {
          tenantId: "tenant-personal",
          connectedSourcesSynced: 0,
        },
      ],
    });
    expect(routeMocks.recoverInterruptedLoopV2Runs).toHaveBeenCalledTimes(2);
    expect(routeMocks.syncDuePersonalProviders).toHaveBeenCalledWith({
      tenantId: "tenant-personal",
      limit: 1,
      abortSignal: expect.any(AbortSignal),
    });
  });
});

describe("operator workflow tick", () => {
  it("gives the connected-source sync 90 seconds, and stops it when the request ends", async () => {
    routeMocks.authorizeRequest.mockResolvedValue({
      tenantId: "tenant-personal",
      actorId: "owner",
      role: "owner",
    });
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const caller = new AbortController();
    let syncSignal: AbortSignal | undefined;
    routeMocks.syncDuePersonalProviders.mockImplementation(async (input) => {
      syncSignal = input.abortSignal;
      expect(syncSignal?.aborted).toBe(false);
      caller.abort();
      return [];
    });

    try {
      const response = await POST(new Request("http://localhost/api/workflows/tick", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
        signal: caller.signal,
      }));

      expect(response.status).toBe(200);
      expect(routeMocks.syncDuePersonalProviders).toHaveBeenCalledWith({
        tenantId: "tenant-personal",
        limit: 2,
        abortSignal: expect.any(AbortSignal),
      });
      expect(syncSignal?.aborted).toBe(true);
      expect(timeout).toHaveBeenCalledWith(90_000);
    } finally {
      timeout.mockRestore();
    }
  });
});

function workerRequest({
  startup,
  target = "http://localhost",
  lane = "fast",
  timeBudgetMs = 1_000,
}: {
  startup: boolean;
  target?: string;
  lane?: "fast" | "background" | "maintenance" | "all";
  timeBudgetMs?: number;
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
      timeBudgetMs,
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
