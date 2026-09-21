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
const autonomy = vi.hoisted(() => ({
  authorize: vi.fn(),
}));

vi.mock("@/lib/moltbook/tool-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moltbook/tool-actions")>()),
  executeMoltbookToolAction: moltbook.execute,
  reconcileMoltbookToolAction: moltbook.reconcile,
  moltbookEffectCommitFromResult: moltbook.commitFromResult,
  moltbookPublicToolResult: moltbook.publicResult,
}));
vi.mock("@/lib/moltbook/autonomy-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/moltbook/autonomy-store")>()),
  authorizeMoltbookAutonomyAction: autonomy.authorize,
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

function autonomyAuthority(runId = "run-moltbook-autonomy") {
  const cycleId = "moltbook_cycle_governed_test";
  return {
    authority: {
      tenantId,
      ownerActorId: actorId,
      canonicalActorId: `actor:${authUserId}`,
      authUserId,
      connectionId: "moltbook_connection_test",
      enrollmentId: "moltbook_enrollment_test",
      enrollmentVersion: 1,
      authorityVersion: 2,
      cycleId,
      executionPurpose: "moltbook.autonomy.cycle.v1" as const,
      correlationId: cycleId,
      membershipRole: "admin" as const,
      agentId: "agent_molty",
      principalId: "agent:moltbook-resident:g1",
      principalGeneration: 7,
      principalSha256: "1".repeat(64),
      definitionVersion: 3,
      definitionSha256: "2".repeat(64),
      policyBoundarySha256: "3".repeat(64),
    },
    leaseToken: "ephemeral-cycle-lease-token-never-persist",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    runId,
  };
}

function autonomyScope(
  authority: ReturnType<typeof autonomyAuthority>["authority"],
) {
  return createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "agent",
    executingPrincipalId: authority.principalId,
    correlationId: authority.cycleId,
    contextGrantIds: [],
    capabilityGrantIds: [],
    purpose: "moltbook.autonomy.cycle.v1",
  });
}

const autonomyActorBinding = {
  version: 1 as const,
  kind: "auth_user" as const,
  authUserId,
  canonicalActorId: `actor:${authUserId}`,
  legacyOwnerActorIds: [actorId],
  readableOwnerActorIds: [`actor:${authUserId}`, actorId],
};

const autonomyContext = {
  tenantId,
  actorId,
  role: "admin" as const,
  source: "service" as const,
};

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
    autonomy.authorize.mockReset();
    autonomy.authorize.mockImplementation(async (input) => ({
      claimId: "moltbook_action_test",
      cycleId: input.authority.cycleId,
      agentRunId: input.agentRunId,
      toolId: input.toolId,
      toolInputSha256: input.toolInputSha256,
      effectTargetId: input.effectTargetId,
      idempotencyKey: input.idempotencyKey,
      toolExecutionId: input.toolExecutionId,
      claimedAt: new Date().toISOString(),
      consumedAt: new Date().toISOString(),
      reused: false,
    }));
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
      "moltbook.submolts.list",
      "moltbook.submolt.read",
      "moltbook.submolt.feed",
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
      "moltbook.submolt.subscribe",
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
    expect(getGovernedTool("moltbook.post.vote")?.reversible).toBe(false);
    expect(getGovernedTool("moltbook.comment.upvote")?.reversible).toBe(false);
    expect(getGovernedTool("moltbook.agent.follow")?.reversible).toBe(true);
    expect(getGovernedTool("moltbook.submolt.subscribe")).toMatchObject({
      reversible: true,
      inputSchema: {
        additionalProperties: false,
        required: ["name", "subscribe"],
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
    }),
    );
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

  it("executes one exactly bound autonomy mutation and reuses its receipt", async () => {
    const grant = autonomyAuthority();
    const idempotencyKey = `${grant.runId}:call-1`;
    const input = { postId: "post_123", direction: "up" };
    moltbook.execute.mockImplementationOnce(async (call) => ({
      status: "succeeded",
      __testMoltbookEffectCommit: testEffectCommit(call, {
        status: "succeeded",
        acknowledgement: "provider_response",
      }),
    }));
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const request = {
      toolId: "moltbook.post.vote",
      input,
      dryRun: false,
      approved: false,
      context: autonomyContext,
      requestActorBinding: autonomyActorBinding,
      executionScope: autonomyScope(grant.authority),
      agentRunId: grant.runId,
      idempotencyKey,
      moltbookAutonomy: {
        authority: grant.authority,
        leaseToken: grant.leaseToken,
        leaseExpiresAt: grant.leaseExpiresAt,
      },
    } as const;

    const first = await executeGovernedTool(request);
    const retried = await executeGovernedTool(request);

    expect(first.record).toMatchObject({
      status: "executed",
      approvalRequired: true,
      approvalDecision: "approved",
      approvedBy: actorId,
    });
    expect(retried.record.id).toBe(first.record.id);
    expect(autonomy.authorize).toHaveBeenCalledTimes(1);
    expect(autonomy.authorize).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: grant.authority,
        leaseToken: grant.leaseToken,
        agentRunId: grant.runId,
        executionPurpose: "moltbook.autonomy.cycle.v1",
        correlationId: grant.authority.cycleId,
        principalId: grant.authority.principalId,
        principalGeneration: 7,
        toolId: "moltbook.post.vote",
        toolExecutionId: first.record.id,
        toolInputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        effectTargetId: expect.stringMatching(/^moltbook_target_[a-f0-9]{52}$/),
      }),
    );
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.record)).not.toContain(grant.leaseToken);
    expect(JSON.stringify(retried.record)).not.toContain(grant.leaseToken);
  });

  it("refuses elevated-risk standing-mandate contracts before budget authorization", async () => {
    const grant = autonomyAuthority("run-moltbook-autonomy-risk");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { getGovernedTool } = await import("@/lib/tools/registry");
    const tool = getGovernedTool("moltbook.post.vote");
    expect(tool).toBeDefined();
    const originalRisk = tool!.riskLevel;
    try {
      tool!.riskLevel = 3;
      await expect(
        executeGovernedTool({
          toolId: "moltbook.post.vote",
          input: { postId: "post_risk", direction: "up" },
          dryRun: false,
          context: autonomyContext,
          requestActorBinding: autonomyActorBinding,
          executionScope: autonomyScope(grant.authority),
          agentRunId: grant.runId,
          idempotencyKey: `${grant.runId}:call-1`,
          moltbookAutonomy: grant,
        }),
      ).rejects.toThrow(/never authorizes risk-3 or higher/i);
    } finally {
      tool!.riskLevel = originalRisk;
    }
    expect(autonomy.authorize).not.toHaveBeenCalled();
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("pins active approval and reversibility metadata for standing mandates", async () => {
    const grant = autonomyAuthority("run-moltbook-autonomy-contract");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const { getGovernedTool } = await import("@/lib/tools/registry");
    const tool = getGovernedTool("moltbook.agent.follow");
    expect(tool).toBeDefined();
    const original = {
      status: tool!.status,
      approvalRequired: tool!.approvalRequired,
      reversible: tool!.reversible,
    };
    const request = (call: number) =>
      executeGovernedTool({
        toolId: "moltbook.agent.follow",
        input: { name: `useful_agent_${call}`, follow: true },
        dryRun: false,
        context: autonomyContext,
        requestActorBinding: autonomyActorBinding,
        executionScope: autonomyScope(grant.authority),
        agentRunId: grant.runId,
        idempotencyKey: `${grant.runId}:call-${call}`,
        moltbookAutonomy: grant,
      });
    try {
      tool!.status = "planned";
      await expect(request(1)).rejects.toThrow(/inactive or unapproved/i);
      tool!.status = original.status;
      tool!.approvalRequired = false;
      await expect(request(2)).rejects.toThrow(/inactive or unapproved/i);
      tool!.approvalRequired = original.approvalRequired;
      tool!.reversible = false;
      await expect(request(3)).rejects.toThrow(/reversibility changed/i);
    } finally {
      Object.assign(tool!, original);
    }
    expect(autonomy.authorize).not.toHaveBeenCalled();
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("limits autonomous posts to text without any URL-bearing payload", async () => {
    const grant = autonomyAuthority("run-moltbook-autonomy-post-shape");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const inputs = [
      {
        submoltName: "agents",
        title: "External link",
        content: "A link post.",
        type: "link",
        url: "https://example.com/research",
      },
      {
        submoltName: "agents",
        title: "External image",
        content: "An image post.",
        type: "image",
        url: "https://example.com/image.png",
      },
      {
        submoltName: "agents",
        title: "Implicit link",
        content: "A URL without an explicit type.",
        url: "https://example.com/implicit",
      },
      {
        submoltName: "agents",
        title: "Text with URL field",
        content: "A text post that still carries a URL field.",
        type: "text",
        url: "https://example.com/still-blocked",
      },
    ] as const;
    for (const [index, input] of inputs.entries()) {
      await expect(
        executeGovernedTool({
          toolId: "moltbook.post.create",
          input,
          dryRun: false,
          context: autonomyContext,
          requestActorBinding: autonomyActorBinding,
          executionScope: autonomyScope(grant.authority),
          agentRunId: grant.runId,
          idempotencyKey: `${grant.runId}:call-${index + 1}`,
          moltbookAutonomy: grant,
        }),
      ).rejects.toThrow(/text-only posts without URL, link, or image/i);
    }
    expect(autonomy.authorize).not.toHaveBeenCalled();
    expect(moltbook.execute).not.toHaveBeenCalled();

    moltbook.execute.mockImplementationOnce(async (call) => ({
      status: "published",
      __testMoltbookEffectCommit: testEffectCommit(call, {
        status: "published",
        acknowledgement: "provider_response",
      }),
    }));
    const textResult = await executeGovernedTool({
      toolId: "moltbook.post.create",
      input: {
        submoltName: "agents",
        title: "A text-only update",
        content: "No external payload is attached.",
        type: "text",
      },
      dryRun: false,
      context: autonomyContext,
      requestActorBinding: autonomyActorBinding,
      executionScope: autonomyScope(grant.authority),
      agentRunId: grant.runId,
      idempotencyKey: `${grant.runId}:call-5`,
      moltbookAutonomy: grant,
    });
    expect(textResult.record.status).toBe("executed");
    expect(autonomy.authorize).toHaveBeenCalledTimes(1);
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
  });

  it("rejects external links embedded in autonomous post and comment text", async () => {
    const grant = autonomyAuthority("run-moltbook-autonomy-authored-links");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const attempts = [
      {
        toolId: "moltbook.post.create",
        input: {
          submoltName: "agents",
          title: "Read HTTPS://example.com/research",
          content: "A text-only post.",
          type: "text",
        },
      },
      {
        toolId: "moltbook.post.create",
        input: {
          submoltName: "agents",
          title: "An autonomous update",
          content: "More details are available at www.example.com.",
          type: "text",
        },
      },
      {
        toolId: "moltbook.comment.create",
        input: {
          postId: "post_external_link",
          content: "The source is HTTP://example.com/source.",
        },
      },
    ] as const;

    for (const [index, attempt] of attempts.entries()) {
      await expect(
        executeGovernedTool({
          toolId: attempt.toolId,
          input: attempt.input,
          dryRun: false,
          context: autonomyContext,
          requestActorBinding: autonomyActorBinding,
          executionScope: autonomyScope(grant.authority),
          agentRunId: grant.runId,
          idempotencyKey: `${grant.runId}:call-${index + 1}`,
          moltbookAutonomy: grant,
        }),
      ).rejects.toThrow(/does not permit external links/i);
    }
    expect(autonomy.authorize).not.toHaveBeenCalled();
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("keeps DM, delete, and moderation tools outside standing authority", async () => {
    const grant = autonomyAuthority("run-moltbook-autonomy-exclusions");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    for (const [index, toolId] of [
      "moltbook.dm.send",
      "moltbook.post.delete",
      "moltbook.submolt.moderate",
    ].entries()) {
      const result = await executeGovernedTool({
        toolId,
        input: {},
        dryRun: false,
        context: autonomyContext,
        requestActorBinding: autonomyActorBinding,
        executionScope: autonomyScope(grant.authority),
        agentRunId: grant.runId,
        idempotencyKey: `${grant.runId}:call-${index + 1}`,
        moltbookAutonomy: grant,
      });
      expect(result.record.status).toBe("blocked");
    }
    expect(autonomy.authorize).not.toHaveBeenCalled();
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("fails closed when autonomy scope is mismatched or its budget rejects", async () => {
    const grant = autonomyAuthority("run-moltbook-autonomy-fail");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    await expect(
      executeGovernedTool({
        toolId: "moltbook.agent.follow",
        input: { name: "useful_agent", follow: true },
        dryRun: false,
        context: autonomyContext,
        requestActorBinding: autonomyActorBinding,
        executionScope: createExecutionScope({
          ...autonomyScope(grant.authority),
          purpose: "agent.tool.execute",
        }),
        agentRunId: grant.runId,
        idempotencyKey: `${grant.runId}:call-1`,
        moltbookAutonomy: grant,
      }),
    ).rejects.toThrow(/does not match the exact owner, Agent, run, and cycle/i);
    expect(autonomy.authorize).not.toHaveBeenCalled();
    expect(moltbook.execute).not.toHaveBeenCalled();

    await expect(
      executeGovernedTool({
        toolId: "moltbook.agent.follow",
        input: { name: "useful_agent", follow: true },
        dryRun: false,
        context: { ...autonomyContext, role: "operator" },
        requestActorBinding: autonomyActorBinding,
        executionScope: autonomyScope(grant.authority),
        agentRunId: grant.runId,
        idempotencyKey: `${grant.runId}:call-role-mismatch`,
        moltbookAutonomy: grant,
      }),
    ).rejects.toThrow(/does not match the exact owner, Agent, run, and cycle/i);
    expect(autonomy.authorize).not.toHaveBeenCalled();
    expect(moltbook.execute).not.toHaveBeenCalled();

    autonomy.authorize.mockRejectedValueOnce(
      Object.assign(new Error("The vote autonomy budget is exhausted."), {
        code: "budget_exhausted",
      }),
    );
    await expect(
      executeGovernedTool({
        toolId: "moltbook.post.vote",
        input: { postId: "post_456", direction: "up" },
        dryRun: false,
        context: autonomyContext,
        requestActorBinding: autonomyActorBinding,
        executionScope: autonomyScope(grant.authority),
        agentRunId: grant.runId,
        idempotencyKey: `${grant.runId}:call-2`,
        moltbookAutonomy: grant,
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("never extends standing autonomy authority to verification", async () => {
    const grant = autonomyAuthority("run-moltbook-autonomy-verify");
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const result = await executeGovernedTool({
      toolId: "moltbook.verify",
      input: { verificationCode: "verify_12345", answer: "42" },
      dryRun: false,
      context: autonomyContext,
      requestActorBinding: autonomyActorBinding,
      executionScope: autonomyScope(grant.authority),
      agentRunId: grant.runId,
      idempotencyKey: `${grant.runId}:call-1`,
      moltbookAutonomy: grant,
    });
    expect(result.record.status).toBe("approval_required");
    expect(autonomy.authorize).not.toHaveBeenCalled();
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
    }),
    );
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
    }),
    ).rejects.toThrow("verification receipt is not finalized");

    const executing = await store.getToolExecution(pending.record.id, { tenantId,
    });
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
    }),
    ).rejects.toThrow("verification receipt is not finalized");
    const executing = await store.getToolExecution(pending.record.id, { tenantId,
    });
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
    expect(retried).toMatchObject({ record: { status: "executing" }, result: null,
    });
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(moltbook.reconcile).toHaveBeenCalledTimes(1);
  });

  it("holds crash-recovered pending verification without losing its non-replay fence", async () => {
    const executionScope = agentScope("moltbook-pending-verification-reconcile",
    );
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
    }),
    ).rejects.toThrow("verification receipt is not finalized");
    const executing = await store.getToolExecution(pending.record.id, { tenantId,
    });
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
    expect(retried).toMatchObject({ record: { status: "executing" }, result: null,
    });
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
    }),
    ).rejects.toThrow();
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
    }),
    ).rejects.toThrow();
    expect(moltbook.execute).not.toHaveBeenCalled();
  });

  it("preserves forced approval while resuming a claimed risk-0 read", async () => {
    const { executeGovernedTool } = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const pending = await executeGovernedTool({
      toolId: "moltbook.home.read",
      input: {},
      dryRun: false,
      forceApproval: true,
      context,
      executionScope: agentScope("moltbook-forced-read-resume"),
      agentRunId: "run-moltbook-forced-read-resume",
    });
    expect(pending.record).toMatchObject({
      status: "approval_required",
      approvalRequired: true,
      riskLevel: 0,
    });

    const claimToken = "moltbook-forced-read-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: actorId,
      approvedRole: "admin",
      claimToken,
    });
    expect(claim).toMatchObject({
      outcome: "claimed",
      record: { status: "executing", approvalRequired: true },
    });

    const executed = await executeGovernedTool({
      toolId: "moltbook.home.read",
      input: {},
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
      agentRunId: "run-moltbook-forced-read-resume",
    });

    expect(executed.record).toMatchObject({
      status: "executed",
      approvalRequired: true,
      approvalDecision: "approved",
      riskLevel: 0,
    });
    expect(moltbook.execute).toHaveBeenCalledTimes(1);
    expect(moltbook.execute).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "moltbook.home.read",
      toolExecutionId: pending.record.id,
      agentRunId: "run-moltbook-forced-read-resume",
    }),
    );
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
      "provider_response"
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
