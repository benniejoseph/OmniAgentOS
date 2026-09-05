import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  completeClaim: vi.fn(),
  enqueueJob: vi.fn(),
  recordCheckpoint: vi.fn(),
  transaction: vi.fn(),
  txQuery: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: vi.fn(),
  getDatabaseTenantContext: vi.fn(),
  getSql: () => ({ transaction: mocks.transaction }),
  hasDatabaseUrl: () => true,
}));

vi.mock("@/lib/events/store", () => ({
  appendDomainEvent: vi.fn(),
  appendDomainEventSafely: vi.fn(),
  appendScopedDomainEvent: vi.fn(),
  listStreamEvents: vi.fn(),
}));

vi.mock("@/lib/operations/job-queue", () => ({
  enqueueOperationJob: mocks.enqueueJob,
  getAgentResumeJobDedupeKey: (executionId: string) =>
    `agent-resume:${executionId}`,
}));

vi.mock("@/lib/runs/approval-checkpoint-shadow", () => ({
  parseApprovalCheckpointShadowEnrollment: vi.fn(),
  recordApprovalWaitingCheckpointShadow: mocks.recordCheckpoint,
}));

vi.mock("@/lib/runs/checkpoint-resume-claim", () => ({
  completeRunCheckpointResumeClaim: mocks.completeClaim,
  runCheckpointResumeClaimTokenSha256: () => "hashed-claim-token",
}));

import {
  completeAgentRun,
  markAgentRunWaitingForApproval,
} from "@/lib/runs/store";
import type { AgentRunContinuation } from "@/lib/runs/types";
import { createExecutionScope } from "@/lib/security/execution-scope";

const TENANT_ID = "tenant_resume_fence";
const RUN_ID = "run_resume_fence";
const CHECKPOINT_ID = "checkpoint_resume_fence";
const CHECKPOINT_SHA256 = "a".repeat(64);
const JOB_ID = "job_resume_fence";
const CLAIM_TOKEN = "b9096a20-22b1-49de-a834-4ad83158e321";
const EXECUTION_ID = "execution_resume_fence";
const SCOPE = createExecutionScope({
  tenantId: TENANT_ID,
  initiatingActorId: "actor_resume_fence",
  executingPrincipalType: "agent",
  executingPrincipalId: "agent_resume_fence",
  correlationId: RUN_ID,
  contextGrantIds: [],
  capabilityGrantIds: [],
  purpose: "Test fenced checkpoint writes.",
});
const CLAIM = {
  tenantId: TENANT_ID,
  runId: RUN_ID,
  checkpointId: CHECKPOINT_ID,
  checkpointSha256: CHECKPOINT_SHA256,
  operationJobId: JOB_ID,
  leaseGeneration: 3,
  leaseExpiresAt: "2026-09-05T18:01:00.000Z",
  claimToken: CLAIM_TOKEN,
};
const RESUME_FENCE = { claim: CLAIM, executionScope: SCOPE };

describe("agent run checkpoint resume write fences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.completeClaim.mockResolvedValue(true);
    mocks.enqueueJob.mockResolvedValue({ id: "next-resume-job" });
    mocks.recordCheckpoint.mockResolvedValue(undefined);
    mocks.transaction.mockImplementation(async (callback) =>
      callback({ query: mocks.txQuery }),
    );
  });

  it("commits a terminal state only through the exact live claim token", async () => {
    mocks.txQuery.mockResolvedValueOnce([{ id: RUN_ID }]);

    await expect(completeAgentRun(
      RUN_ID,
      "finished once",
      undefined,
      { tenantId: TENANT_ID, resumeFence: RESUME_FENCE },
    )).resolves.toBe(true);

    const [statement, params] = mocks.txQuery.mock.calls[0] as [
      string,
      unknown[],
    ];
    expect(statement).toContain("claim.claim_token_sha256 = $12");
    expect(statement).toContain("claim.lease_expires_at > statement_timestamp()");
    expect(params).toContain("hashed-claim-token");
    expect(params).not.toContain(CLAIM_TOKEN);
    expect(mocks.completeClaim).toHaveBeenCalledWith(
      { ...CLAIM, executionScope: SCOPE },
      expect.objectContaining({ query: mocks.txQuery }),
    );
  });

  it("refuses a terminal write after the claim fence becomes stale", async () => {
    mocks.txQuery.mockResolvedValueOnce([]);

    await expect(completeAgentRun(
      RUN_ID,
      "must not commit",
      undefined,
      { tenantId: TENANT_ID, resumeFence: RESUME_FENCE },
    )).resolves.toBe(false);
    expect(mocks.completeClaim).not.toHaveBeenCalled();
  });

  it("parks the next approval and retires the old claim atomically", async () => {
    mocks.txQuery.mockResolvedValueOnce([{ id: RUN_ID }]);
    const continuation = continuationFor(EXECUTION_ID);

    await expect(markAgentRunWaitingForApproval(
      RUN_ID,
      { response: "waiting again", continuation },
      { resumeFence: RESUME_FENCE },
    )).resolves.toMatchObject({
      parked: true,
      resumeJob: { id: "next-resume-job" },
    });

    expect(mocks.enqueueJob).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        type: "agent.resume",
        payload: {
          agentRunId: RUN_ID,
          executionId: EXECUTION_ID,
          actorId: "actor_resume_fence",
        },
      }),
      { sql: expect.objectContaining({ query: mocks.txQuery }) },
    );
    expect(mocks.recordCheckpoint).toHaveBeenCalled();
    expect(mocks.completeClaim).toHaveBeenCalledWith(
      { ...CLAIM, executionScope: SCOPE },
      expect.objectContaining({ query: mocks.txQuery }),
    );
  });
});

function continuationFor(executionId: string): AgentRunContinuation {
  return {
    executionScope: SCOPE,
    conversationItems: [{ role: "user", content: "test" }],
    instructions: "test",
    response: "partial",
    toolSteps: 1,
    outputsBeforeApproval: [],
    pendingToolCall: {
      callId: "call_resume_fence",
      toolId: "http.request",
      toolName: "HTTP Request",
      riskLevel: 2,
      executionId,
    },
    context: {
      tenantId: TENANT_ID,
      actorId: "actor_resume_fence",
      role: "operator",
    },
    createdAt: "2026-09-05T18:00:00.000Z",
  };
}
