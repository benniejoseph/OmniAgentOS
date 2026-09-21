import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createExecutionScope } from "@/lib/security/execution-scope";

const moltbook = vi.hoisted(() => ({
  execute: vi.fn(),
  reconcile: vi.fn(),
  commitFromResult: vi.fn((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    return (value as Record<string, unknown>).__testMoltbookEffectCommit;
  }),
  publicResult: vi.fn((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const { __testMoltbookEffectCommit: _commit, ...publicValue } =
      value as Record<string, unknown>;
    void _commit;
    return publicValue;
  }),
}));

vi.mock("@/lib/moltbook/tool-actions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/moltbook/tool-actions")>(),
  executeMoltbookToolAction: moltbook.execute,
  reconcileMoltbookToolAction: moltbook.reconcile,
  moltbookEffectCommitFromResult: moltbook.commitFromResult,
  moltbookPublicToolResult: moltbook.publicResult,
}));

const tenantId = "tenant-moltbook-tools";
const authUserId = "33333333-3333-4333-8333-333333333333";
const actorId = "owner@moltbook-tools.test";
const context = {
  tenantId,
  actorId,
  role: "admin" as const,
  source: "session" as const,
  auth: {
    userId: authUserId,
    email: actorId,
    sessionId: "session-moltbook-tools",
    tenantName: "Moltbook tools",
  },
};

function agentScope(correlationId: string) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: "agent:moltbook-resident:g1",
    correlationId,
    delegationId: "delegation:moltbook-resident",
    capabilityGrantIds: ["capability:moltbook"],
    purpose: "agent.moltbook.resident",
  });
}

describe("Moltbook governed tools", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-moltbook-tools-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    moltbook.execute.mockReset();
    moltbook.reconcile.mockReset();
    moltbook.commitFromResult.mockReset();
    moltbook.publicResult.mockReset();
    moltbook.commitFromResult.mockImplementation((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
      return (value as Record<string, unknown>).__testMoltbookEffectCommit;
    });
    moltbook.publicResult.mockImplementation((value: unknown) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return value;
      const { __testMoltbookEffectCommit: _commit, ...publicValue } =
        value as Record<string, unknown>;
      void _commit;
      return publicValue;
    });
    moltbook.reconcile.mockResolvedValue(undefined);
    moltbook.execute.mockResolvedValue({
      state: "complete",
      providerAcknowledged: true,
    });
  });

  it("registers bounded read contracts and approval-gated public actions", async () => {
    const { getGovernedTool } = await import("@/lib/tools/registry");

    for (const toolId of [
      "moltbook.home.read",
      "moltbook.feed.read",
      "moltbook.thread.read",
    ]) {
      expect(getGovernedTool(toolId)).toMatchObject({
        category: "connector",
        riskLevel: 0,
        approvalRequired: false,
        operationClass: "read_only",
      });
    }
    for (const toolId of [
      "moltbook.post.create",
      "moltbook.comment.create",
      "moltbook.post.vote",
      "moltbook.comment.upvote",
      "moltbook.agent.follow",
      "moltbook.verify",
    ]) {
      expect(getGovernedTool(toolId)).toMatchObject({
        category: "connector",
        riskLevel: 2,
        approvalRequired: true,
        operationClass: "mutation",
      });
    }
    expect(getGovernedTool("moltbook.post.create")?.inputSchema).toMatchObject({
      additionalProperties: false,
      required: ["submoltName", "title"],
      properties: {
        title: { maxLength: 300 },
        content: { maxLength: 40_000 },
        url: { maxLength: 2_048, pattern: expect.stringContaining("https") },
      },
    });
  });

  it("executes reads without approval and forwards the exact agent scope", async () => {
    const executionScope = agentScope("moltbook-read-correlation");
    const { executeGovernedTool } = await import("@/lib/tools/executor");

    const result = await executeGovernedTool({
      toolId: "moltbook.feed.read",
      input: { sort: "new", limit: 12, filter: "following" },
      dryRun: false,
      context,
      executionScope,
      agentRunId: "run-moltbook-read",
      idempotencyKey: "run-moltbook-read:call-1",
    });

    expect(result.record.status).toBe("executed");
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(moltbook.execute).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "moltbook.feed.read",
      toolInput: { sort: "new", limit: 12, filter: "following" },
      context,
      executionScope,
      toolExecutionId: result.record.id,
      agentRunId: "run-moltbook-read",
    }));
  });

  it("creates approval for writes without calling Moltbook", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const result = await executeGovernedTool({
      toolId: "moltbook.post.create",
      input: {
        submoltName: "agents",
        title: "A bounded update",
        content: "A short public post.",
        type: "text",
      },
      dryRun: false,
      context,
      executionScope: agentScope("moltbook-write-pending"),
      agentRunId: "run-moltbook-write",
    });

    expect(result).toMatchObject({
      record: {
        status: "approval_required",
        riskLevel: 2,
        approvalRequired: true,
      },
      result: null,
    });
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("calls one approved write exactly once and preserves pending verification", async () => {
    const executionScope = agentScope("moltbook-approved-write");
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = {
      postId: "post_123",
      content: "Thanks for sharing this.",
    };
    const pending = await executor.executeGovernedTool({
      toolId: "moltbook.comment.create",
      input,
      dryRun: false,
      context,
      executionScope,
      agentRunId: "run-moltbook-comment",
    });
    const claimToken = "moltbook-comment-approval-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: actorId,
      approvedRole: "admin",
      claimToken,
    });
    moltbook.execute.mockImplementationOnce(async (call) => ({
      status: "pending_verification",
      verification: {
        verificationCode: "verify_123",
        challengeText: "Provide the numeric answer before this comment can publish.",
      },
      __testMoltbookEffectCommit: testEffectCommit(call, {
        status: "pending_verification",
        acknowledgement: "provider_response",
      }),
    }));

    const executed = await executor.executeGovernedTool({
      toolId: "moltbook.comment.create",
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
      agentRunId: "run-moltbook-comment",
    });

    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(moltbook.execute).toHaveBeenCalledWith(expect.objectContaining({
      context,
      executionScope,
      toolExecutionId: pending.record.id,
    }));
    expect(executed).toMatchObject({
      record: {
        status: "executed",
        effectReceipt: {
          schemaVersion: 2,
          toolId: "moltbook.comment.create",
          executingPrincipalType: "agent",
          targetType: "moltbook_action",
          verificationState: "unverifiable",
        },
        output: {
          status: "pending_verification",
          verification: { verificationCode: "verify_123" },
        },
      },
      result: {
        status: "pending_verification",
      },
    });
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
  });

  it("reconciles the same execution key from durable evidence without replaying the provider", async () => {
    const executionScope = agentScope("moltbook-same-key-reconcile");
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = { postId: "post_123", direction: "up" };
    const idempotencyKey = "moltbook-vote-stable-key";
    const pending = await executor.executeGovernedTool({
      toolId: "moltbook.post.vote",
      input,
      dryRun: false,
      context,
      executionScope,
      agentRunId: "run-moltbook-vote",
      idempotencyKey,
    });
    const claimToken = "moltbook-vote-approval-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: actorId,
      approvedRole: "admin",
      claimToken,
    });
    moltbook.execute.mockImplementationOnce(async (call) => ({
      status: "succeeded",
      __testMoltbookEffectCommit: testEffectCommit(call, {
        status: "succeeded",
        acknowledgement: "provider_response",
      }),
    }));
    // Simulate a crash after the provider receipt was durably stored but
    // before the canonical ToolExecution could consume its private commit.
    moltbook.commitFromResult.mockReturnValueOnce(undefined);
    await expect(executor.executeGovernedTool({
      toolId: "moltbook.post.vote",
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
      agentRunId: "run-moltbook-vote",
      idempotencyKey,
    })).rejects.toThrow("verification receipt is not finalized");

    const executing = await store.getToolExecution(pending.record.id, { tenantId });
    expect(executing?.status).toBe("executing");
    moltbook.reconcile.mockImplementationOnce(async (call) => {
      const result = {
        status: "succeeded",
        __testMoltbookEffectCommit: testEffectCommit(call, {
          status: "succeeded",
          acknowledgement: "provider_idempotency_reconciliation",
        }),
      };
      return { kind: "completed", result };
    });

    const retried = await executor.executeGovernedTool({
      toolId: "moltbook.post.vote",
      input: store.openToolExecutionInput(executing!),
      dryRun: false,
      approved: true,
      context,
      executionScope,
      idempotencyKey,
      existingRecord: executing,
      executionClaimToken: claimToken,
      agentRunId: "run-moltbook-vote",
    });
    expect(retried.record.status).toBe("executed");
    expect(retried.result).toEqual({ status: "succeeded" });
    expect(JSON.stringify(retried.record.output)).not.toContain("testMoltbook");
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(moltbook.reconcile).toHaveBeenCalledTimes(1);
  });

  it("holds an ambiguous prior mutation and never replays it on the same key", async () => {
    const executionScope = agentScope("moltbook-uncertain-reconcile");
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = { postId: "post_456", direction: "down" };
    const pending = await executor.executeGovernedTool({
      toolId: "moltbook.post.vote",
      input,
      dryRun: false,
      context,
      executionScope,
    });
    const claimToken = "moltbook-uncertain-approval-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: actorId,
      approvedRole: "admin",
      claimToken,
    });
    moltbook.execute.mockRejectedValueOnce(new Error("provider timeout"));
    await expect(executor.executeGovernedTool({
      toolId: "moltbook.post.vote",
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    })).rejects.toThrow("verification receipt is not finalized");
    const executing = await store.getToolExecution(pending.record.id, { tenantId });
    moltbook.reconcile.mockResolvedValueOnce({
      kind: "held",
      status: "uncertain",
      errorCode: "provider_timeout",
    });

    const retried = await executor.executeGovernedTool({
      toolId: "moltbook.post.vote",
      input: store.openToolExecutionInput(executing!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: executing,
      executionClaimToken: claimToken,
    });
    expect(retried).toMatchObject({ record: { status: "executing" }, result: null });
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(moltbook.reconcile).toHaveBeenCalledTimes(1);
  });

  it("holds crash-recovered pending verification without losing its non-replay fence", async () => {
    const executionScope = agentScope("moltbook-pending-verification-reconcile");
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = { postId: "post_789", content: "A governed reply." };
    const pending = await executor.executeGovernedTool({
      toolId: "moltbook.comment.create",
      input,
      dryRun: false,
      context,
      executionScope,
    });
    const claimToken = "moltbook-pending-verification-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: actorId,
      approvedRole: "admin",
      claimToken,
    });
    moltbook.execute.mockRejectedValueOnce(new Error("worker interrupted"));
    await expect(executor.executeGovernedTool({
      toolId: "moltbook.comment.create",
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    })).rejects.toThrow("verification receipt is not finalized");
    const executing = await store.getToolExecution(pending.record.id, { tenantId });
    moltbook.reconcile.mockResolvedValueOnce({
      kind: "held",
      status: "pending_verification",
    });

    const retried = await executor.executeGovernedTool({
      toolId: "moltbook.comment.create",
      input: store.openToolExecutionInput(executing!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: executing,
      executionClaimToken: claimToken,
    });
    expect(retried).toMatchObject({ record: { status: "executing" }, result: null });
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(moltbook.reconcile).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid IDs and non-HTTPS URLs before the adapter", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    await expect(executeGovernedTool({
      toolId: "moltbook.thread.read",
      input: { postId: "../../other-agent", sort: "best", limit: 10 },
      dryRun: false,
      context,
      executionScope: agentScope("moltbook-invalid-id"),
    })).rejects.toThrow();
    await expect(executeGovernedTool({
      toolId: "moltbook.post.create",
      input: {
        submoltName: "agents",
        title: "Unsafe URL",
        url: "http://example.test/not-https",
        type: "link",
      },
      dryRun: false,
      context,
      executionScope: agentScope("moltbook-invalid-url"),
    })).rejects.toThrow();
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("honors forceApproval and never calls Moltbook for dry runs or unknown tools", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const forced = await executeGovernedTool({
      toolId: "moltbook.home.read",
      input: {},
      dryRun: false,
      forceApproval: true,
      context,
      executionScope: agentScope("moltbook-force-approval"),
    });
    const preview = await executeGovernedTool({
      toolId: "moltbook.post.vote",
      input: { postId: "post_123", direction: "up" },
      dryRun: true,
      context,
      executionScope: agentScope("moltbook-dry-run"),
    });
    const unknown = await executeGovernedTool({
      toolId: "moltbook.post.delete",
      input: { postId: "post_123" },
      dryRun: false,
      context,
      executionScope: agentScope("moltbook-unknown-tool"),
    });

    expect(forced.record.status).toBe("approval_required");
    expect(unknown.record.status).toBe("blocked");
    expect(preview).toMatchObject({
      record: { status: "dry_run" },
      result: {
        wouldExecute: true,
        sideEffects: expect.arrayContaining([
          expect.stringMatching(/human approval/i),
          expect.stringMatching(/does not automatically retry/i),
        ]),
      },
    });
    expect(moltbook.execute).not.toHaveBeenCalled();
  });
});

function testEffectCommit(
  call: {
    toolId: string;
    toolExecutionId: string;
    toolInputSha256?: string;
    effectTargetId?: string;
  },
  options: {
    status: "succeeded" | "published" | "pending_verification";
    acknowledgement:
      | "provider_response"
      | "provider_idempotency_reconciliation";
  },
) {
  const acknowledgementSha256 = "a".repeat(64);
  return {
    version: "moltbook.effect-commit.v1",
    providerAcknowledgement: options.acknowledgement,
    providerAcknowledgementId: `moltbook_ack_${acknowledgementSha256.slice(0, 50)}`,
    providerAcknowledgementSha256: acknowledgementSha256,
    toolExecutionId: call.toolExecutionId,
    toolId: call.toolId,
    toolInputSha256: call.toolInputSha256,
    effectTargetId: call.effectTargetId,
    requestSha256: "b".repeat(64),
    responseSha256: "c".repeat(64),
    status: options.status,
  };
}
