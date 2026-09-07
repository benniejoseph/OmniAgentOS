import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanNode,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

const mocks = vi.hoisted(() => {
  const now = "2026-09-07T00:00:00.000Z";
  const connector = {
    id: "browser",
    tenantId: "tenant-browser",
    name: "Playwright Browser",
    endpoint: "https://asael.bennierichard.com/api/integrations/playwright/mcp",
    transport: "streamable_http" as const,
    authType: "none" as const,
    status: "active" as const,
    defaultRiskLevel: 1 as const,
    approvalRequired: false,
    toolCount: 2,
    createdAt: now,
    updatedAt: now,
  };
  const records = [
    {
      id: "mcp:browser:browser_navigate",
      tenantId: "tenant-browser",
      connectorId: connector.id,
      connectorName: connector.name,
      name: "browser_navigate",
      inputSchema: { type: "object", additionalProperties: true },
      riskLevel: 1 as const,
      approvalRequired: false,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "mcp:browser:browser_click",
      tenantId: "tenant-browser",
      connectorId: connector.id,
      connectorName: connector.name,
      name: "browser_click",
      inputSchema: { type: "object", additionalProperties: true },
      riskLevel: 2 as const,
      approvalRequired: true,
      status: "active" as const,
      createdAt: now,
      updatedAt: now,
    },
  ];
  const definitions = records.map((record) => ({
    id: record.id,
    name: `${record.connectorName}: ${record.name}`,
    description: "Managed Playwright operation.",
    category: "mcp" as const,
    status: "active" as const,
    riskLevel: record.riskLevel,
    dryRunSupported: true,
    approvalRequired: record.approvalRequired,
    operationClass: "mutation" as const,
    reversible: false,
    inputSchema: record.inputSchema,
    approvalFingerprint: `base-${record.name}`,
  }));
  return {
    connector,
    records,
    definitions,
    callMcpTool: vi.fn(),
    resolveBrowserProfileSession: vi.fn(),
  };
});

vi.mock("@/lib/connectors/governed-tools", () => ({
  getMcpGovernedTool: vi.fn(async (id: string) =>
    mocks.definitions.find((tool) => tool.id === id) || null),
  getOpenApiGovernedTool: vi.fn(async () => null),
}));

vi.mock("@/lib/connectors/store", () => ({
  getMcpConnector: vi.fn(async (id: string) =>
    id === mocks.connector.id ? mocks.connector : null),
  getMcpToolById: vi.fn(async (id: string) =>
    mocks.records.find((tool) => tool.id === id) || null),
}));

vi.mock("@/lib/connectors/mcp-client", () => ({
  callMcpTool: mocks.callMcpTool,
}));

vi.mock("@/lib/browser/profiles", () => ({
  browserProfileTargetHostname: vi.fn((name: string, input: Record<string, unknown>) =>
    name === "browser_navigate" && typeof input.url === "string"
      ? new URL(input.url).hostname
      : undefined),
  resolveBrowserProfileSession: mocks.resolveBrowserProfileSession,
}));

vi.mock("@/lib/browser/frames", () => ({
  captureBrowserFrameAfterToolSafely: vi.fn(async () => undefined),
}));

describe("governed browser action policy", () => {
  beforeEach(async () => {
    process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
      path.join(tmpdir(), "asael-browser-policy-"),
    );
    delete process.env.DATABASE_URL;
    vi.clearAllMocks();
    mocks.resolveBrowserProfileSession.mockResolvedValue({
      id: "browser_profile:owner",
      revision: 3,
      allowedDomains: ["example.test"],
    });
    mocks.callMcpTool.mockResolvedValue({
      content: [{ type: "text", text: "browser action complete" }],
      isError: false,
    });
  });

  it("executes routine navigation without creating an external-effect receipt", async () => {
    const executor = await import("@/lib/tools/executor");
    const input = { url: "https://example.test/docs" };
    const executed = await executor.executeGovernedTool({
      toolId: "mcp:browser:browser_navigate",
      input,
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("navigate"),
      mcpSessionScope: sessionScope(),
      idempotencyKey: "browser-policy:navigate",
    });

    expect(executed.record).toMatchObject({
      status: "executed",
      riskLevel: 1,
      approvalRequired: false,
    });
    expect(executed.record.effectReceipt).toBeUndefined();
    expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
  });

  it("keeps a click behind approval and governed effect verification", async () => {
    const executor = await import("@/lib/tools/executor");
    const store = await import("@/lib/tools/audit-store");
    const input = { target: "e7", element: "Send order" };
    const pending = await executor.executeGovernedTool({
      toolId: "mcp:browser:browser_click",
      input,
      dryRun: false,
      context: securityContext(),
      executionScope: executionScope("click"),
      mcpSessionScope: sessionScope(),
      idempotencyKey: "browser-policy:click",
    });

    expect(pending.record).toMatchObject({
      status: "approval_required",
      riskLevel: 2,
      approvalRequired: true,
    });
    expect(mocks.callMcpTool).not.toHaveBeenCalled();

    const claimToken = "browser-policy-click-claim";
    const claim = await store.approveAndClaimToolExecution({
      id: pending.record.id,
      tenantId: "tenant-browser",
      approvedBy: "reviewer-browser",
      approvedRole: "admin",
      claimToken,
    });
    const executed = await executor.executeGovernedTool({
      toolId: pending.record.toolId,
      input: store.openToolExecutionInput(claim.record!),
      dryRun: false,
      approved: true,
      context: securityContext(),
      existingRecord: claim.record,
      executionClaimToken: claimToken,
      mcpSessionScope: sessionScope(),
    });

    expect(executed.record).toMatchObject({
      status: "executed",
      effectReceipt: {
        schemaVersion: 2,
        targetType: "mcp_operation",
        verificationState: "unverifiable",
        verificationReasonCode: "read_unavailable",
      },
    });
    expect(mocks.callMcpTool).toHaveBeenCalledTimes(1);
  });

  it("issues a bounded workflow grant for exact reviewed navigation", async () => {
    const { authorizeWorkflowToolWithGrant } = await import(
      "@/lib/workflows/executor"
    );
    const tool = mocks.definitions[0];
    const toolInput = { url: "https://example.test/docs" };
    const node = browserWorkflowNode(tool.id, toolInput);
    const plan = browserWorkflowPlan(node);
    const approvedAt = new Date(Date.now() - 1_000).toISOString();
    const grant = await authorizeWorkflowToolWithGrant({
      detail: browserWorkflowDetail(approvedAt),
      plan,
      planId: "browser-plan",
      node,
      tool,
      toolInput,
      executionScope: createExecutionScope({
        tenantId: "tenant-browser",
        initiatingActorId: "owner-browser",
        executingPrincipalType: "system",
        executingPrincipalId: "workflow:browser-run",
        correlationId: "browser-workflow",
        purpose: "workflow.tool.execute",
      }),
      executionKey: "browser-workflow:navigate",
    });

    expect(grant?.grant).toMatchObject({
      domain: "mcp",
      actionClass: tool.id,
      toolId: tool.id,
      riskLevel: 1,
      reversible: true,
      maxUses: 1,
      usedUses: 1,
    });
  });
});

function securityContext() {
  return {
    tenantId: "tenant-browser",
    actorId: "owner-browser",
    role: "admin" as const,
    source: "default" as const,
  };
}

function executionScope(action: string) {
  return createExecutionScope({
    tenantId: "tenant-browser",
    initiatingActorId: "owner-browser",
    executingPrincipalType: "user",
    executingPrincipalId: "owner-browser",
    correlationId: `browser-policy-${action}`,
    purpose: `browser.${action}`,
  });
}

function sessionScope() {
  return {
    tenantId: "tenant-browser",
    actorId: "owner-browser",
    executionId: "agent-run:browser-policy",
  };
}

function browserWorkflowNode(
  toolId: string,
  toolInput: Record<string, unknown>,
): WorkflowPlanNode {
  return {
    id: "browser-node",
    label: "Open documentation",
    kind: "tool",
    description: "Open the exact reviewed documentation URL.",
    dependsOn: [],
    toolIds: [toolId],
    toolInputs: [{ toolId, inputJson: JSON.stringify(toolInput) }],
    connectorTargets: ["example.test"],
    riskLevel: 1,
    approvalRequired: false,
    policy: "auto_allowed",
    acceptanceCriteria: ["Documentation is visible."],
    expectedOutputs: ["page"],
  };
}

function browserWorkflowPlan(node: WorkflowPlanNode): WorkflowDynamicPlan {
  return {
    objective: "Read documentation.",
    summary: "Open one reviewed documentation page.",
    mode: "execute",
    assumptions: [],
    constraints: [],
    risks: [],
    acceptanceCriteria: ["Documentation is visible."],
    nodes: [node],
    edges: [],
    selectedToolIds: [...node.toolIds],
    connectorTargets: ["example.test"],
    executionPolicy: {
      highestRiskLevel: 1,
      requiresApproval: true,
      defaultPolicy: "approval_required",
      notes: [],
    },
    verificationPlan: [],
    memoryPlan: [],
    confidence: 0.9,
  };
}

function browserWorkflowDetail(approvedAt: string): WorkflowRunDetail {
  return {
    run: {
      id: "browser-run",
      tenantId: "tenant-browser",
      workflowType: "dynamic",
      status: "running",
      goal: "Read documentation.",
      input: { goal: "Read documentation." },
      currentStep: "execute",
      attempt: 1,
      maxAttempts: 3,
      approvalRequired: true,
      approvedAt,
      createdAt: approvedAt,
      updatedAt: approvedAt,
    },
    steps: [],
    events: [{
      id: "browser-workflow-approval",
      tenantId: "tenant-browser",
      workflowRunId: "browser-run",
      type: "workflow.approved",
      payload: { actorId: "owner-browser" },
      createdAt: approvedAt,
    }],
  };
}
