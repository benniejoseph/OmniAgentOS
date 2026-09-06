import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  appendWorkflowEvent: vi.fn(),
  executeGovernedTool: vi.fn(),
  generateModelStructured: vi.fn(),
  getGovernedTool: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
  governedToolOperationClass: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
}));

vi.mock("@/lib/connectors/governed-tools", () => ({
  getMcpGovernedTool: vi.fn(),
  getOpenApiGovernedTool: vi.fn(),
}));
vi.mock("@/lib/models/gateway", () => ({
  generateModelStructured: mocks.generateModelStructured,
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolveRuntimeModelAssignment,
}));
vi.mock("@/lib/tools/executor", () => ({
  EffectReceiptFinalizationError: class EffectReceiptFinalizationError extends Error {},
  executeGovernedTool: mocks.executeGovernedTool,
  governedToolOperationClass: mocks.governedToolOperationClass,
}));
vi.mock("@/lib/tools/registry", () => ({
  getGovernedTool: mocks.getGovernedTool,
}));
vi.mock("@/lib/workflows/store", () => ({
  appendWorkflowEvent: mocks.appendWorkflowEvent,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
}));

import { executeDynamicWorkflowPlan } from "@/lib/workflows/executor";
import { withWorkflowNodeContract } from "@/lib/workflows/node-contract";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanNode,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

const readTools: ToolDefinition[] = [
  {
    id: "runs.list",
    name: "List runs",
    description: "List recent runs.",
    category: "runs",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: { type: "object" },
  },
  {
    id: "knowledge.search",
    name: "Search knowledge",
    description: "Search tenant knowledge.",
    category: "knowledge",
    status: "active",
    riskLevel: 0,
    dryRunSupported: true,
    approvalRequired: false,
    operationClass: "read_only",
    reversible: true,
    inputSchema: { type: "object" },
  },
];

const writeTool: ToolDefinition = {
  id: "memory.write",
  name: "Write memory",
  description: "Write a durable memory.",
  category: "memory",
  status: "active",
  riskLevel: 2,
  dryRunSupported: true,
  approvalRequired: true,
  operationClass: "mutation",
  reversible: true,
  inputSchema: { type: "object" },
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-parallel-node-executor-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.getWorkflowRunExecutionAuthority.mockResolvedValue(undefined);
  mocks.resolveRuntimeModelAssignment.mockResolvedValue({
    configured: true,
    source: "deployment_environment",
    assignmentId: undefined,
    bind: <T>(request: T) => request,
  });
  mocks.governedToolOperationClass.mockImplementation(
    (tool: ToolDefinition | undefined) => tool?.operationClass || "mutation",
  );
  mocks.getGovernedTool.mockImplementation((toolId: string) =>
    [...readTools, writeTool].find((tool) => tool.id === toolId)
  );
});

describe("workflow parallel DAG scheduling", () => {
  it("runs independent model-only branches concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    mocks.generateModelStructured.mockImplementation(async () => {
      callCount += 1;
      const receiptIndex = callCount;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(25);
      active -= 1;
      return successfulModelResult(receiptIndex);
    });
    const nodes = [agentNode("branch-a"), agentNode("branch-b")];

    const summary = await executeDynamicWorkflowPlan(
      workflowDetail("workflow-parallel-agents", nodes),
    );

    expect(summary).toMatchObject({
      status: "completed",
      totalNodes: 2,
      completedNodes: 2,
    });
    expect(maxActive).toBe(2);
    expect(mocks.appendWorkflowEvent).toHaveBeenCalledWith(
      "workflow-parallel-agents",
      "workflow.plan_batch.started",
      expect.objectContaining({
        nodeIds: ["branch-a", "branch-b"],
        nodeCount: 2,
        concurrent: true,
      }),
    );
  });

  it("serializes independent nodes that may produce side effects", async () => {
    let active = 0;
    let maxActive = 0;
    let callCount = 0;
    mocks.executeGovernedTool.mockImplementation(async ({ toolId }) => {
      callCount += 1;
      const executionIndex = callCount;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await delay(20);
      active -= 1;
      return {
        record: {
          id: `write-execution-${executionIndex}`,
          toolId,
          status: "dry_run",
          dryRun: true,
          approvalRequired: true,
          riskLevel: 2,
        },
        result: { preview: `memory ${executionIndex}` },
      };
    });
    const nodes = [toolNode("write-a", "memory.write"), toolNode("write-b", "memory.write")];

    const summary = await executeDynamicWorkflowPlan(
      workflowDetail("workflow-serialized-effects", nodes),
    );

    expect(summary).toMatchObject({ status: "completed", completedNodes: 2 });
    expect(maxActive).toBe(1);
    const batchEvents = mocks.appendWorkflowEvent.mock.calls.filter(
      ([, event]) => event === "workflow.plan_batch.started",
    );
    expect(batchEvents).toHaveLength(2);
    expect(batchEvents.every(([, , payload]) =>
      payload.nodeCount === 1 && payload.concurrent === false
    )).toBe(true);
  });

  it("binds a typed upstream artifact into the downstream governed tool input", async () => {
    let callCount = 0;
    mocks.executeGovernedTool.mockImplementation(async ({ toolId }) => {
      callCount += 1;
      return {
        record: {
          id: `read-execution-${callCount}`,
          toolId,
          status: "executed",
          dryRun: false,
          approvalRequired: false,
          riskLevel: 0,
        },
        result: toolId === "runs.list"
          ? { runs: [{ id: "run-123", status: "completed" }] }
          : { matches: [{ id: "knowledge-1" }] },
      };
    });
    const inspect = toolNode("inspect-runs", "runs.list");
    const search = withWorkflowNodeContract({
      ...toolNode("search-result", "knowledge.search"),
      dependsOn: [inspect.id],
      inputBindings: [{
        dependencyNodeId: inspect.id,
        targetToolId: "knowledge.search",
        targetPath: "/query",
        artifactName: "runs.list result",
      }],
    });

    const summary = await executeDynamicWorkflowPlan(
      workflowDetail("workflow-bound-input", [inspect, search]),
    );

    const searchCall = mocks.executeGovernedTool.mock.calls.find(
      ([input]) => input.toolId === "knowledge.search",
    );
    expect(searchCall?.[0].input.query).toContain("run-123");
    expect(summary).toMatchObject({
      status: "completed",
      completedNodes: 2,
      nodeExecutions: [
        { nodeId: "inspect-runs", status: "completed" },
        {
          nodeId: "search-result",
          status: "completed",
          input: {
            dependencies: [{ nodeId: "inspect-runs" }],
            inputBindings: [{
              dependencyNodeId: "inspect-runs",
              targetToolId: "knowledge.search",
              targetPath: "/query",
              artifactName: "runs.list result",
            }],
          },
        },
      ],
    });
  });
});

function agentNode(id: string): WorkflowPlanNode {
  return withWorkflowNodeContract({
    id,
    label: `Analyze ${id}`,
    kind: "research",
    description: `Produce substantive analysis for ${id}.`,
    dependsOn: [],
    toolIds: [],
    connectorTargets: [],
    riskLevel: 0,
    approvalRequired: false,
    policy: "auto",
    acceptanceCriteria: ["The branch produced substantive analysis."],
    expectedOutputs: ["branch analysis"],
  });
}

function toolNode(id: string, toolId: string): WorkflowPlanNode {
  return withWorkflowNodeContract({
    id,
    label: `Execute ${id}`,
    kind: "tool",
    description: `Execute the governed ${toolId} tool.`,
    dependsOn: [],
    toolIds: [toolId],
    connectorTargets: [],
    riskLevel: toolId === "memory.write" ? 2 : 0,
    approvalRequired: toolId === "memory.write",
    policy: toolId === "memory.write" ? "dry_run" : "auto",
    acceptanceCriteria: ["The governed tool returned a typed artifact."],
    expectedOutputs: ["tool result"],
  });
}

function workflowDetail(
  workflowRunId: string,
  nodes: WorkflowPlanNode[],
): WorkflowRunDetail {
  const plan: WorkflowDynamicPlan = {
    objective: "Execute a bounded test workflow.",
    summary: "Exercise DAG scheduling and typed dependencies.",
    mode: "orchestrate",
    assumptions: [],
    constraints: [],
    risks: [],
    acceptanceCriteria: nodes.flatMap((node) => node.acceptanceCriteria),
    nodes,
    edges: nodes.flatMap((node) => node.dependsOn.map((dependencyId) => ({
      from: dependencyId,
      to: node.id,
      condition: "completed",
    }))),
    selectedToolIds: [...new Set(nodes.flatMap((node) => node.toolIds))],
    connectorTargets: [],
    executionPolicy: {
      highestRiskLevel: Math.max(0, ...nodes.map((node) => node.riskLevel)) as 0 | 1 | 2 | 3,
      requiresApproval: nodes.some((node) => node.approvalRequired),
      defaultPolicy: "auto",
      notes: [],
    },
    verificationPlan: [],
    memoryPlan: [],
    confidence: 1,
  };
  return {
    run: {
      id: workflowRunId,
      tenantId: "tenant-1",
      workflowType: "agent.workflow.v1",
      status: "running",
      goal: plan.objective,
      input: { goal: plan.objective, metadata: { actorId: "actor-1" } },
      currentStep: "execute",
      attempt: 1,
      maxAttempts: 3,
      approvalRequired: false,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:01.000Z",
    },
    steps: [{
      id: `plan-step-${workflowRunId}`,
      tenantId: "tenant-1",
      workflowRunId,
      stepKey: "plan",
      label: "Plan",
      status: "completed",
      attempt: 1,
      maxAttempts: 3,
      input: {},
      output: {
        id: `plan-${workflowRunId}`,
        planner: "deterministic",
        confidence: 1,
        validation: { isDag: true },
        plan,
      },
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:01.000Z",
    }],
    events: [],
  };
}

function successfulModelResult(index: number) {
  return {
    text: JSON.stringify({
      status: "completed",
      summary: `Branch ${index} completed with substantive analysis.`,
      artifacts: [{
        name: "branch analysis",
        kind: "analysis",
        content: `Substantive independently derived result ${index}.`,
        evidenceIds: [],
      }],
      acceptanceChecks: [{
        criterion: "The branch produced substantive analysis.",
        passed: true,
        evidenceIds: [],
        note: "The artifact contains a concrete result.",
      }],
      sideEffectClaimed: false,
    }),
    provider: "openai",
    model: "gpt-test",
    usage: {
      inputTokens: 100,
      outputTokens: 40,
      cachedInputTokens: 0,
      totalTokens: 140,
    },
    latencyMs: 12,
    costKnown: false,
    attempts: [{
      provider: "openai",
      model: "gpt-test",
      status: "completed",
      latencyMs: 12,
    }],
    usageReceiptRecorded: true,
    usageReceiptId: `usage-${index}`,
    providerRequestId: `provider-request-${index}`,
  };
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
