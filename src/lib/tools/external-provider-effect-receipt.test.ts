import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvalGrantExecutionKeySha256,
  buildToolApprovalGrantRequest,
} from "@/lib/approval-grants/authorization";
import {
  buildApprovalGrantClaimV1,
  buildApprovalGrantV1,
} from "@/lib/approval-grants/contracts";
import { McpToolContractDriftError } from "@/lib/connectors/contract-review";
import { listStreamEvents } from "@/lib/events/store";
import { createExecutionScope } from "@/lib/security/execution-scope";

const providers = vi.hoisted(() => {
  const now = "2026-09-06T00:00:00.000Z";
  const mcpTool = {
    id: "mcp:tasks:create_task",
    name: "Tasks: create_task",
    description: "Create one external task.",
    category: "mcp" as const,
    status: "active" as const,
    riskLevel: 2 as const,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation" as const,
    reversible: false,
    inputSchema: { type: "object", additionalProperties: true },
    approvalFingerprint: "reviewed-mcp-create-task-v1",
  };
  const openApiTool = {
    id: "openapi:crm:create_contact",
    name: "CRM: create_contact",
    description: "Create one external contact.",
    category: "openapi" as const,
    status: "active" as const,
    riskLevel: 2 as const,
    dryRunSupported: true,
    approvalRequired: true,
    operationClass: "mutation" as const,
    reversible: true,
    inputSchema: { type: "object", additionalProperties: true },
    approvalFingerprint: "reviewed-openapi-create-contact-v1",
  };
  return {
    mcpTool,
    openApiTool,
    mcpConnector: {
      id: "tasks",
      tenantId: "tenant-provider",
      name: "Tasks",
      endpoint: "https://mcp.example.test/mcp",
      transport: "streamable_http" as const,
      authType: "none" as const,
      status: "active" as const,
      defaultRiskLevel: 2 as const,
      approvalRequired: true,
      toolCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    mcpToolRecord: {
      id: mcpTool.id,
      tenantId: "tenant-provider",
      connectorId: "tasks",
      connectorName: "Tasks",
      name: "create_task",
      inputSchema: mcpTool.inputSchema,
      riskLevel: 2 as const,
      approvalRequired: true,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    },
    openApiConnector: {
      id: "crm",
      tenantId: "tenant-provider",
      name: "CRM",
      baseUrl: "https://api.example.test/v1",
      authType: "none" as const,
      status: "active" as const,
      defaultRiskLevel: 2 as const,
      approvalRequired: true,
      operationCount: 1,
      createdAt: now,
      updatedAt: now,
    },
    openApiOperation: {
      id: openApiTool.id,
      tenantId: "tenant-provider",
      connectorId: "crm",
      connectorName: "CRM",
      operationId: "create_contact",
      method: "POST" as const,
      path: "/contacts",
      inputSchema: openApiTool.inputSchema,
      responseContentTypes: ["application/json"],
      riskLevel: 2 as const,
      approvalRequired: true,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    },
    callMcpTool: vi.fn(),
    callOpenApiOperation: vi.fn(),
    holdMcpToolForReview: vi.fn(),
  };
});

vi.mock("@/lib/connectors/governed-tools", () => ({
  getMcpGovernedTool: vi.fn(async (id: string) =>
    id === providers.mcpTool.id ? providers.mcpTool : null),
  getOpenApiGovernedTool: vi.fn(async (id: string) =>
    id === providers.openApiTool.id ? providers.openApiTool : null),
}));

vi.mock("@/lib/connectors/store", () => ({
  getMcpConnector: vi.fn(async (id: string) =>
    id === providers.mcpConnector.id ? providers.mcpConnector : null),
  getMcpToolById: vi.fn(async (id: string) =>
    id === providers.mcpToolRecord.id ? providers.mcpToolRecord : null),
  holdMcpToolForReview: providers.holdMcpToolForReview,
}));

vi.mock("@/lib/connectors/openapi-store", () => ({
  getOpenApiConnector: vi.fn(async (id: string) =>
    id === providers.openApiConnector.id ? providers.openApiConnector : null),
  getOpenApiOperationById: vi.fn(async (id: string) =>
    id === providers.openApiOperation.id ? providers.openApiOperation : null),
}));

vi.mock("@/lib/connectors/mcp-client", () => ({
  callMcpTool: providers.callMcpTool,
}));

vi.mock("@/lib/connectors/openapi-client", () => ({
  callOpenApiOperation: providers.callOpenApiOperation,
}));

describe("external provider effect receipts", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-provider-effect-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    providers.callMcpTool.mockResolvedValue({
      content: [{ type: "text", text: "task-created" }],
      isError: false,
    });
    providers.callOpenApiOperation.mockResolvedValue({
      request: {
        method: "POST",
        url: "https://api.example.test/v1/contacts",
        headers: ["content-type", "idempotency-key"],
        bodySent: true,
      },
      response: {
        status: 201,
        ok: true,
        contentType: "application/json",
        body: { id: "contact-1" },
        truncated: false,
      },
    });
  });

  it("binds an approved MCP mutation to an intent and explicit unverifiable receipt", async () => {
    const tenantId = "tenant-provider";
    const actorId = "owner-provider";
    const context = {
      tenantId,
      actorId,
      role: "admin" as const,
      source: "default" as const,
    };
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "mcp-provider-effect",
      purpose: "tool.mcp.create_task",
    });
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = { title: "Prepare launch notes" };

    const pending = await executor.executeGovernedTool({
      toolId: providers.mcpTool.id,
      input,
      dryRun: false,
      context,
      executionScope,
    });
    const claimToken = "mcp-provider-effect-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: "provider-reviewer",
      approvedRole: "admin",
      claimToken,
    });
    const executed = await executor.executeGovernedTool({
      toolId: providers.mcpTool.id,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    });

    expect(providers.callMcpTool).toHaveBeenCalledTimes(1);
    expect(executed.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        toolId: providers.mcpTool.id,
        executionKind: "direct",
        targetType: "mcp_operation",
        providerAcknowledgement: "provider_response",
        verificationState: "unverifiable",
        verificationReasonCode: "read_unavailable",
      },
    });
    expect(store.getToolExecutionEffectIntentV2(executed.record)).toMatchObject({
      executionId: pending.record.id,
      toolId: providers.mcpTool.id,
      targetType: "mcp_operation",
    });
    const events = await listStreamEvents(
      `tool_execution:${pending.record.id}`,
      { tenantId, actorId },
    );
    expect(events.map((event) => event.type).filter((type) =>
      type.startsWith("tool.effect_")
    )).toEqual([
      "tool.effect_intent.recorded",
      "tool.effect_receipt.recorded",
    ]);
  });

  it("binds an OpenAPI workflow mutation to its exact persisted plan", async () => {
    const tenantId = "tenant-provider";
    const actorId = "owner-provider";
    const workflowRunId = "provider-workflow";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: `workflow:${workflowRunId}`,
      correlationId: workflowRunId,
      causationId: "workflow.tool:create-contact",
      purpose: "workflow.tool.execute",
    });
    const effectBinding = {
      workflowRunId,
      planId: "provider-plan",
      planSha256: "a".repeat(64),
      planNodeId: "create-contact",
    };
    const executor = await import("@/lib/tools/executor");
    const toolInput = { body: { name: "Ada" } };
    const idempotencyKey = "workflow:provider:create-contact";
    const request = buildToolApprovalGrantRequest({
      tool: providers.openApiTool,
      toolInput,
      executionScope,
      planId: effectBinding.planId,
      planSha256: effectBinding.planSha256,
    })!;
    const issuedAt = new Date(Date.now() - 1_000).toISOString();
    const claimedAt = new Date(Date.now() - 500).toISOString();
    const grant = buildApprovalGrantV1({
      version: "p9.4-approval-grant:1",
      grantId: "grant:11111111-1111-4111-8111-111111111111",
      ...request,
      approvedByActorId: actorId,
      sourceApprovalId: "workflow-approval-one",
      issuedAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      maxUses: 1,
      usedUses: 1,
      state: "exhausted",
      lifecycleRevision: 2,
      lastUsedAt: claimedAt,
      revokedAt: null,
    });
    const approvalGrantClaim = {
      grant,
      claim: buildApprovalGrantClaimV1({
        version: "p9.4-approval-grant-claim:1",
        claimId: "claim:22222222-2222-4222-8222-222222222222",
        grantId: grant.grantId,
        grantBindingSha256: grant.bindingSha256,
        tenantId,
        ownerActorId: actorId,
        executionKeySha256: approvalGrantExecutionKeySha256({
          tenantId,
          ownerActorId: actorId,
          executionKey: idempotencyKey,
        }),
        useOrdinal: 1,
        claimedAt,
      }),
    };

    const executed = await executor.executeGovernedTool({
      toolId: providers.openApiTool.id,
      input: toolInput,
      dryRun: false,
      approved: true,
      context: {
        tenantId,
        actorId,
        role: "admin",
        source: "default",
      },
      executionScope,
      effectBinding,
      approvalGrantClaim,
      idempotencyKey,
    });

    expect(providers.callOpenApiOperation).toHaveBeenCalledTimes(1);
    expect(executed.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        toolId: providers.openApiTool.id,
        executionKind: "workflow",
        workflowRunId,
        planId: effectBinding.planId,
        planSha256: effectBinding.planSha256,
        planNodeId: effectBinding.planNodeId,
        targetType: "openapi_operation",
        providerAcknowledgement: "provider_response",
        verificationState: "unverifiable",
        verificationReasonCode: "read_unavailable",
      },
    });
    const { listObservabilityEvents } = await import(
      "@/lib/observability/store"
    );
    expect(
      await listObservabilityEvents({
        action: "tool.authority_decided",
        tenantId,
      }),
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({
          source: "plan_grant",
          reviewed: true,
          bindingId: grant.grantId,
          bindingSha256: grant.bindingSha256,
          expiresAt: grant.expiresAt,
          executionId: executed.record.id,
        }),
      }),
    ]);
  });

  it("lets the signed-in user run their own reviewed action, and records it", async () => {
    const tenantId = "tenant-provider";
    const actorId = "owner-provider";
    const executor = await import("@/lib/tools/executor");
    const executed = await executor.executeGovernedTool({
      toolId: providers.openApiTool.id,
      input: { body: { name: "Ada" } },
      dryRun: false,
      approved: true,
      context: { tenantId, actorId, role: "admin", source: "default" },
      executionScope: createExecutionScope({
        tenantId,
        initiatingActorId: actorId,
        executingPrincipalType: "user",
        executingPrincipalId: actorId,
        correlationId: "provider-direct-user",
        purpose: "tool.execute",
      }),
      idempotencyKey: "provider:create-contact:direct-user",
    });

    expect(executed.record.status).toBe("executed");
    expect(providers.callOpenApiOperation).toHaveBeenCalledTimes(1);
    const { listObservabilityEvents } = await import(
      "@/lib/observability/store"
    );
    expect(
      await listObservabilityEvents({
        action: "tool.authority_decided",
        tenantId,
      }),
    ).toEqual([
      expect.objectContaining({
        message: `${providers.openApiTool.name} was authorized by the signed-in user's own request.`,
        metadata: expect.objectContaining({
          source: "direct_user",
          reviewed: true,
          executionId: executed.record.id,
        }),
      }),
    ]);
  });

  it("holds a risk-3 action for its quorum even when the signed-in user runs it", async () => {
    const tenantId = "tenant-provider";
    const actorId = "owner-provider";
    const tool = providers.openApiTool as { riskLevel: number };
    const executor = await import("@/lib/tools/executor");
    tool.riskLevel = 3;
    try {
      const result = await executor.executeGovernedTool({
        toolId: providers.openApiTool.id,
        input: { body: { name: "Linus" } },
        dryRun: false,
        approved: true,
        context: { tenantId, actorId, role: "admin", source: "default" },
        executionScope: createExecutionScope({
          tenantId,
          initiatingActorId: actorId,
          executingPrincipalType: "user",
          executingPrincipalId: actorId,
          correlationId: "provider-risk-three",
          purpose: "tool.execute",
        }),
        idempotencyKey: "provider:create-contact:risk-three",
      });

      expect(result.record).toMatchObject({
        status: "approval_required",
        riskLevel: 3,
      });
      expect(providers.callOpenApiOperation).not.toHaveBeenCalled();
    } finally {
      tool.riskLevel = 2;
    }
  });

  it("does not honor a workflow's bare approved flag without an exact grant claim", async () => {
    const tenantId = "tenant-provider";
    const actorId = "owner-provider";
    const workflowRunId = "provider-workflow-unbound";
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "system",
      executingPrincipalId: `workflow:${workflowRunId}`,
      correlationId: workflowRunId,
      purpose: "workflow.tool.execute",
    });
    const executor = await import("@/lib/tools/executor");
    const result = await executor.executeGovernedTool({
      toolId: providers.openApiTool.id,
      input: { body: { name: "Grace" } },
      dryRun: false,
      approved: true,
      context: { tenantId, actorId, role: "admin", source: "default" },
      executionScope,
      effectBinding: {
        workflowRunId,
        planId: "provider-plan-unbound",
        planSha256: "f".repeat(64),
        planNodeId: "create-contact",
      },
      idempotencyKey: "workflow:provider:create-contact:unbound",
    });

    expect(result.record.status).toBe("approval_required");
    expect(providers.callOpenApiOperation).not.toHaveBeenCalled();
  });

  it("leaves an uncertain MCP delivery intent-bound and unreplayed", async () => {
    const tenantId = "tenant-provider";
    const actorId = "owner-provider";
    const context = {
      tenantId,
      actorId,
      role: "admin" as const,
      source: "default" as const,
    };
    const executionScope = createExecutionScope({
      tenantId,
      initiatingActorId: actorId,
      executingPrincipalType: "user",
      executingPrincipalId: actorId,
      correlationId: "mcp-provider-uncertain",
      purpose: "tool.mcp.create_task",
    });
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const pending = await executor.executeGovernedTool({
      toolId: providers.mcpTool.id,
      input: { title: "Uncertain task" },
      dryRun: false,
      context,
      executionScope,
    });
    const claimToken = "mcp-provider-uncertain-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId,
      approvedBy: "provider-reviewer",
      approvedRole: "admin",
      claimToken,
    });
    providers.callMcpTool.mockRejectedValueOnce(
      new Error("connection closed after provider delivery"),
    );

    await expect(executor.executeGovernedTool({
      toolId: providers.mcpTool.id,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    })).rejects.toBeInstanceOf(executor.EffectReceiptFinalizationError);

    const retained = await store.getToolExecution(pending.record.id, {
      tenantId,
    });
    expect(retained).toMatchObject({ status: "executing" });
    expect(store.getToolExecutionEffectIntentV2(retained!)).toMatchObject({
      executionId: pending.record.id,
      targetType: "mcp_operation",
    });
    expect(retained?.effectReceipt).toBeUndefined();
    expect(providers.callMcpTool).toHaveBeenCalledTimes(1);
    expect(providers.holdMcpToolForReview).not.toHaveBeenCalled();
  });

  it.each([
    ["changed the tool since its review, and holds it for review", { ...providers.mcpToolRecord, inputSchema: { type: "object", required: ["title"] } }, false],
    ["stopped listing the tool, and holds it for review", undefined, false],
    ["changed the tool, even when the hold cannot be saved", { ...providers.mcpToolRecord, annotations: { destructiveHint: true } }, true],
  ])("refuses an approved MCP call once its server %s", async (_drift, liveTool, holdFails) => {
    const { executor, run } = await approvedMcpTask("mcp-provider-drift");
    const drift = new McpToolContractDriftError({ toolLabel: '"create_task"', liveTool });
    providers.callMcpTool.mockRejectedValueOnce(drift);
    if (holdFails) {
      providers.holdMcpToolForReview.mockRejectedValueOnce(new Error("connector store unavailable"));
    }

    const failure = await run().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(executor.EffectReceiptFinalizationError);
    expect((failure as Error).cause).toBe(drift);
    expect(providers.callMcpTool).toHaveBeenCalledWith(
      expect.objectContaining({ reviewedTool: providers.mcpToolRecord }),
    );
    expect(providers.holdMcpToolForReview).toHaveBeenCalledTimes(1);
    expect(providers.holdMcpToolForReview).toHaveBeenCalledWith(
      { connector: providers.mcpConnector, reviewed: providers.mcpToolRecord, live: liveTool },
      { executionScope: expect.objectContaining({ tenantId: "tenant-provider" }) },
    );
  });
});

/** An approved and claimed MCP task creation, with the call that runs it. */
async function approvedMcpTask(correlationId: string) {
  const tenantId = "tenant-provider";
  const actorId = "owner-provider";
  const context = {
    tenantId,
    actorId,
    role: "admin" as const,
    source: "default" as const,
  };
  const executionScope = createExecutionScope({
    tenantId,
    initiatingActorId: actorId,
    executingPrincipalType: "user",
    executingPrincipalId: actorId,
    correlationId,
    purpose: "tool.mcp.create_task",
  });
  const executor = await import("@/lib/tools/executor");
  const store = await import("@/lib/tools/audit-store");
  const pending = await executor.executeGovernedTool({
    toolId: providers.mcpTool.id,
    input: { title: "Reviewed task" },
    dryRun: false,
    context,
    executionScope,
  });
  const claimToken = `${correlationId}-claim`;
  const claim = await store.approveAndClaimToolExecution({
    id: pending.record.id,
    tenantId,
    approvedBy: "provider-reviewer",
    approvedRole: "admin",
    claimToken,
  });
  return {
    executor,
    run: () => executor.executeGovernedTool({
      toolId: providers.mcpTool.id,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context,
      existingRecord: claim.record,
      executionClaimToken: claimToken,
    }),
  };
}
