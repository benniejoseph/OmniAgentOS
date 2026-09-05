import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
    reversible: false,
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

    const executed = await executor.executeGovernedTool({
      toolId: providers.openApiTool.id,
      input: { body: { name: "Ada" } },
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
      idempotencyKey: "workflow:provider:create-contact",
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
  });
});
