import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  processDelegationExecutionJob: vi.fn(),
  leaseOperationJobs: vi.fn(),
  failOperationJob: vi.fn(),
  getAgentRun: vi.fn(),
  claimQueuedAgentRun: vi.fn(),
  failAgentRun: vi.fn(),
  getAgentRunExecutionScope: vi.fn(),
  runAgent: vi.fn(),
  syncMissionExecutor: vi.fn(),
  recordMissionArtifact: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  runWithDatabaseTenantScope: async (
    _tenantId: string,
    operation: () => unknown,
  ) => operation(),
  runWithDatabaseActorScope: async (
    _tenantId: string,
    _actorIds: readonly string[],
    operation: () => unknown,
  ) => operation(),
}));
vi.mock("@/lib/delegation/worker", () => ({
  processDelegationExecutionJob: mocks.processDelegationExecutionJob,
}));
vi.mock("@/lib/missions/runtime", () => ({
  syncMissionExecutor: mocks.syncMissionExecutor,
}));
vi.mock("@/lib/missions/store", () => ({
  recordMissionArtifact: mocks.recordMissionArtifact,
}));
vi.mock("@/lib/orchestration/agent-runner", () => ({
  runAgent: mocks.runAgent,
}));
vi.mock("@/lib/operations/job-queue", () => ({
  completeOperationJob: vi.fn(),
  deferOperationJob: vi.fn(),
  failOperationJob: mocks.failOperationJob,
  getAgentExecuteJobDedupeKey: (runId: string) => `agent.execute:${runId}`,
  heartbeatOperationJob: vi.fn(),
  leaseOperationJobs: mocks.leaseOperationJobs,
  listRunnableAgentExecuteTenantIds: vi.fn(),
}));
vi.mock("@/lib/runs/store", () => ({
  AgentRunExecutionScopeBindingError: class AgentRunExecutionScopeBindingError extends Error {},
  claimQueuedAgentRun: mocks.claimQueuedAgentRun,
  failAgentRun: mocks.failAgentRun,
  getAgentRun: mocks.getAgentRun,
  getAgentRunExecutionScope: mocks.getAgentRunExecutionScope,
}));
vi.mock("@/lib/subagents/context", () => ({
  inspectWorkflowSpecialistDependencies: vi.fn(),
}));
vi.mock("@/lib/subagents/profiles", () => ({
  durableSpecialistLabel: vi.fn(),
  durableSpecialistProfile: vi.fn(),
}));
vi.mock("@/lib/workflows/queue", () => ({
  enqueueWorkflowRunTick: vi.fn(),
}));
vi.mock("@/lib/workflows/store", () => ({
  getWorkflowRunDetail: vi.fn(),
}));

import { processDurableSpecialistQueue } from "@/lib/subagents/worker";
import type { OperationJobRecord } from "@/lib/operations/job-queue";

describe("durable agent.execute payload routing", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const job = malformedV2JobThatAlsoMatchesLegacySchema();
    mocks.leaseOperationJobs.mockResolvedValue([job]);
    mocks.processDelegationExecutionJob.mockRejectedValue(
      new Error("Malformed delegation V2 payload."),
    );
    mocks.failOperationJob.mockResolvedValue({
      ...job,
      status: "failed",
      lastError: "Malformed delegation V2 payload.",
    });
  });

  it("never falls a malformed V2 envelope through to the legacy specialist path", async () => {
    const result = await processDurableSpecialistQueue({
      tenantId: "tenant-routing",
      limit: 1,
      deadline: Date.now() + 30_000,
    });

    expect(result).toMatchObject({ leased: 1, failed: 1, completed: 0 });
    expect(mocks.processDelegationExecutionJob).toHaveBeenCalledTimes(1);
    expect(mocks.getAgentRun).not.toHaveBeenCalled();
    expect(mocks.getAgentRunExecutionScope).not.toHaveBeenCalled();
    expect(mocks.claimQueuedAgentRun).not.toHaveBeenCalled();
    expect(mocks.runAgent).not.toHaveBeenCalled();
    expect(mocks.syncMissionExecutor).not.toHaveBeenCalled();
    expect(mocks.recordMissionArtifact).not.toHaveBeenCalled();
    expect(mocks.failOperationJob).toHaveBeenCalledWith(
      "job-malformed-v2",
      "Malformed delegation V2 payload.",
      "worker:routing",
      "tenant-routing",
    );
  });
});

function malformedV2JobThatAlsoMatchesLegacySchema(): OperationJobRecord {
  const now = new Date().toISOString();
  return {
    id: "job-malformed-v2",
    tenantId: "tenant-routing",
    type: "agent.execute",
    status: "running",
    payload: {
      kind: "delegation_execution_v2",
      actorId: "actor-routing",
      missionId: "mission-legacy-shape",
      taskId: "task-legacy-shape",
      runId: "run-legacy-shape",
      agentId: "scout",
      ready: true,
      preparedAt: now,
      // Deliberately omit the V2 schema version, digests, and execution scope.
      // The discriminator must still keep this out of the legacy parser.
    },
    dedupeKey: "agent.execute:run-legacy-shape",
    priority: 20,
    attempt: 1,
    maxAttempts: 1,
    runAt: now,
    lockedAt: now,
    leaseOwner: "worker:routing",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    createdAt: now,
    updatedAt: now,
  };
}
