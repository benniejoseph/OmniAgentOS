import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@/lib/tools/types";

const mocks = vi.hoisted(() => ({
  executeGovernedTool: vi.fn(),
  getGovernedTool: vi.fn(),
  appendWorkflowEvent: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
}));

vi.mock("@/lib/connectors/governed-tools", () => ({
  getMcpGovernedTool: vi.fn(),
  getOpenApiGovernedTool: vi.fn(),
}));
vi.mock("@/lib/tools/executor", () => ({
  EffectReceiptFinalizationError: class EffectReceiptFinalizationError extends Error {},
  executeGovernedTool: mocks.executeGovernedTool,
  governedToolOperationClass: vi.fn(() => "read_only"),
}));
vi.mock("@/lib/workflows/store", () => ({
  appendWorkflowEvent: mocks.appendWorkflowEvent,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
}));

const runsListTool: ToolDefinition = {
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
  inputSchema: { type: "object", additionalProperties: false },
};

vi.mock("@/lib/tools/registry", () => ({
  getGovernedTool: mocks.getGovernedTool,
}));

import { executeDynamicWorkflowPlan } from "@/lib/workflows/executor";
import { withWorkflowNodeContract } from "@/lib/workflows/node-contract";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-tool-node-executor-"),
  );
  delete process.env.DATABASE_URL;
});

beforeEach(() => {
  mocks.executeGovernedTool.mockReset();
  mocks.getGovernedTool.mockReset();
  mocks.appendWorkflowEvent.mockReset();
  mocks.getWorkflowRunExecutionAuthority.mockReset();
  mocks.getWorkflowRunExecutionAuthority.mockResolvedValue(undefined);
  mocks.getGovernedTool.mockImplementation((toolId: string) =>
    toolId === runsListTool.id ? runsListTool : undefined
  );
  mocks.executeGovernedTool.mockResolvedValue({
    record: {
      id: "tool-execution-1",
      toolId: "runs.list",
      status: "executed",
      dryRun: false,
      approvalRequired: false,
      riskLevel: 0,
    },
    result: { runs: [{ id: "run-123", status: "completed" }] },
  });
});

describe("workflow tool node execution contract", () => {
  it("binds governed tool output to typed input, artifacts, and receipts", async () => {
    const node = withWorkflowNodeContract({
      id: "inspect-runs",
      label: "Inspect runs",
      kind: "tool" as const,
      description: "Inspect recent workflow runs.",
      dependsOn: [],
      toolIds: [runsListTool.id],
      connectorTargets: [],
      riskLevel: 0 as const,
      approvalRequired: false,
      policy: "auto" as const,
      acceptanceCriteria: ["Recent run state is captured."],
      expectedOutputs: ["run list"],
    });
    const detail: WorkflowRunDetail = {
      run: {
        id: "workflow-tool-contract-1",
        tenantId: "tenant-1",
        workflowType: "agent.workflow.v1",
        status: "running",
        goal: "Inspect recent workflow runs.",
        input: { goal: "Inspect recent workflow runs." },
        currentStep: "execute",
        attempt: 1,
        maxAttempts: 3,
        approvalRequired: false,
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:01.000Z",
      },
      steps: [{
        id: "plan-step-1",
        tenantId: "tenant-1",
        workflowRunId: "workflow-tool-contract-1",
        stepKey: "plan",
        label: "Plan",
        status: "completed",
        attempt: 1,
        maxAttempts: 3,
        input: {},
        output: {
          id: "plan-tool-contract-1",
          planner: "deterministic",
          confidence: 1,
          validation: { isDag: true },
          plan: {
            objective: "Inspect recent workflow runs.",
            summary: "Inspect run state.",
            mode: "orchestrate",
            assumptions: [],
            constraints: [],
            risks: [],
            acceptanceCriteria: node.acceptanceCriteria,
            nodes: [node],
            edges: [],
            selectedToolIds: [runsListTool.id],
            connectorTargets: [],
            executionPolicy: {
              highestRiskLevel: 0,
              requiresApproval: false,
              defaultPolicy: "auto",
              notes: [],
            },
            verificationPlan: [],
            memoryPlan: [],
            confidence: 1,
          },
        },
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:01.000Z",
      }],
      events: [],
    };

    const summary = await executeDynamicWorkflowPlan(detail);

    expect(mocks.executeGovernedTool).toHaveBeenCalledWith(expect.objectContaining({
      toolId: "runs.list",
      input: { limit: 5 },
      dryRun: false,
    }));
    expect(summary).toMatchObject({
      status: "completed",
      completedNodes: 1,
      toolExecutions: 1,
      executedTools: 1,
      nodeExecutions: [{
        input: {
          schemaVersion: 1,
          executor: "tool",
          grants: { toolIds: ["runs.list"] },
        },
        output: {
          nodeResult: {
            schemaVersion: 1,
            completionBasis: "tool_receipts",
            artifacts: [{
              content: expect.stringContaining("run-123"),
              evidenceIds: ["tool-execution-1"],
            }],
          },
          executionReceipt: {
            schemaVersion: 1,
            executor: "tool",
            inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
            toolExecutionIds: ["tool-execution-1"],
          },
        },
      }],
    });
  });
});
