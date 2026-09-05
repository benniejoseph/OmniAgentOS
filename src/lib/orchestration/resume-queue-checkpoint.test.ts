import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  completeJob: vi.fn(),
  deferJob: vi.fn(),
  failJob: vi.fn(),
  getRun: vi.fn(),
  getToolExecution: vi.fn(),
  heartbeatClaim: vi.fn(),
  heartbeatJob: vi.fn(),
  leaseJobs: vi.fn(),
  resumeRun: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  getSql: () => ({ transaction: mocks.transaction }),
  runWithDatabaseTenantScope: (_tenantId: string, operation: () => unknown) =>
    Promise.resolve(operation()),
}));

vi.mock("@/lib/operations/job-queue", () => ({
  completeOperationJob: mocks.completeJob,
  deferOperationJob: mocks.deferJob,
  failOperationJob: mocks.failJob,
  heartbeatOperationJob: mocks.heartbeatJob,
  leaseOperationJobs: mocks.leaseJobs,
  listRunnableAgentResumeTenantIds: vi.fn(),
}));

vi.mock("@/lib/orchestration/agent-runner", () => ({
  rejectAgentRunApproval: vi.fn(),
  resumeAgentRunAfterToolApproval: mocks.resumeRun,
}));

vi.mock("@/lib/missions/runtime", () => ({
  syncMissionExecutorSafely: vi.fn(),
}));

vi.mock("@/lib/runs/approval-checkpoint-shadow", () => ({
  parseApprovalCheckpointShadowEnrollment: (value: unknown) => value,
}));

vi.mock("@/lib/runs/checkpoint-resume-claim", () => ({
  authorizeLatestAgentRunCheckpointResume: mocks.authorize,
  heartbeatRunCheckpointResumeClaim: mocks.heartbeatClaim,
}));

vi.mock("@/lib/runs/store", () => ({
  appendRunEvent: vi.fn(),
  failAgentRun: vi.fn(),
  getAgentRun: mocks.getRun,
}));

vi.mock("@/lib/tools/audit-store", () => ({
  getToolExecution: mocks.getToolExecution,
}));

import { processAgentResumeQueue } from "@/lib/orchestration/resume-queue";
import { createExecutionScope } from "@/lib/security/execution-scope";

const TENANT_ID = "tenant_checkpoint_queue";
const RUN_ID = "run_checkpoint_queue";
const EXECUTION_ID = "execution_checkpoint_queue";
const JOB_ID = "job_checkpoint_queue";
const SCOPE = createExecutionScope({
  tenantId: TENANT_ID,
  initiatingActorId: "actor_checkpoint_queue",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_checkpoint_queue",
  correlationId: RUN_ID,
  contextGrantIds: [],
  capabilityGrantIds: [],
  purpose: "Test checkpoint queue fencing.",
});
const JOB = {
  id: JOB_ID,
  tenantId: TENANT_ID,
  type: "agent.resume" as const,
  status: "running" as const,
  payload: { agentRunId: RUN_ID, executionId: EXECUTION_ID },
  priority: 20,
  attempt: 1,
  maxAttempts: 10,
  runAt: "2026-09-05T18:00:00.000Z",
  lockedAt: "2026-09-05T18:00:01.000Z",
  leaseOwner: "worker:checkpoint-queue",
  leaseExpiresAt: "2026-09-05T18:01:01.000Z",
  createdAt: "2026-09-05T18:00:00.000Z",
  updatedAt: "2026-09-05T18:00:01.000Z",
};
const CLAIM = {
  tenantId: TENANT_ID,
  runId: RUN_ID,
  checkpointId: "checkpoint_checkpoint_queue",
  checkpointSha256: "a".repeat(64),
  operationJobId: JOB_ID,
  leaseGeneration: 1,
  leaseExpiresAt: "2026-09-05T18:01:01.000Z",
  claimToken: "b9096a20-22b1-49de-a834-4ad83158e321",
};

describe("agent resume checkpoint canary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transaction.mockImplementation(async (callback) =>
      callback({ transactionScoped: true }),
    );
    mocks.leaseJobs.mockResolvedValue([JOB]);
    mocks.getRun.mockResolvedValue({
      id: RUN_ID,
      tenantId: TENANT_ID,
      status: "waiting_approval",
      continuation: {
        executionScope: SCOPE,
        checkpointShadowEnrollment: {
          enginePin: { rolloutMode: "canary" },
        },
        pendingToolCall: { executionId: EXECUTION_ID },
        toolPolicy: { readOnly: true },
        context: { actorId: "actor_checkpoint_queue" },
      },
    });
    mocks.getToolExecution.mockResolvedValue({
      id: EXECUTION_ID,
      tenantId: TENANT_ID,
      status: "executed",
      riskLevel: 0,
      output: { ok: true },
    });
    mocks.authorize.mockResolvedValue({
      outcome: "authorized",
      reason: "checkpoint_fence_acquired",
      claim: CLAIM,
      fenceAcquired: true,
      resumeAuthorityGranted: true,
    });
    mocks.heartbeatJob.mockResolvedValue(true);
    mocks.heartbeatClaim.mockResolvedValue(true);
    mocks.resumeRun.mockResolvedValue({ resumed: true, status: "completed" });
    mocks.completeJob.mockResolvedValue({ ...JOB, status: "completed" });
    mocks.deferJob.mockResolvedValue({ ...JOB, status: "queued" });
    mocks.failJob.mockResolvedValue({ ...JOB, status: "failed" });
  });

  it("uses the same claim for authorization, heartbeat, and runner writes", async () => {
    const result = await processAgentResumeQueue({ tenantId: TENANT_ID });

    expect(result).toMatchObject({
      leased: 1,
      completed: 1,
      deferred: 0,
      failed: 0,
    });
    expect(mocks.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        runId: RUN_ID,
        approvalExecutionId: EXECUTION_ID,
        operationJobId: JOB_ID,
        leaseOwner: JOB.leaseOwner,
      }),
      expect.objectContaining({ transactionScoped: true }),
    );
    expect(mocks.heartbeatClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: CLAIM.checkpointId,
        leaseGeneration: CLAIM.leaseGeneration,
        claimToken: CLAIM.claimToken,
      }),
      expect.objectContaining({ transactionScoped: true }),
    );
    expect(mocks.resumeRun).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: EXECUTION_ID,
        resumeFence: { claim: CLAIM, executionScope: SCOPE },
      }),
    );
  });

  it("pauses instead of falling back when the checkpoint claim is busy", async () => {
    mocks.authorize.mockResolvedValue({
      outcome: "busy",
      reason: "active_claim",
      claim: null,
      fenceAcquired: false,
      resumeAuthorityGranted: false,
    });

    const result = await processAgentResumeQueue({ tenantId: TENANT_ID });

    expect(result).toMatchObject({ completed: 0, deferred: 1, failed: 0 });
    expect(mocks.resumeRun).not.toHaveBeenCalled();
    expect(mocks.deferJob).toHaveBeenCalledWith(
      JOB_ID,
      JOB.leaseOwner,
      expect.objectContaining({ reason: expect.stringContaining("active_claim") }),
    );
  });
});
