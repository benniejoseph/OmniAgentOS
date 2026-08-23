import { describe, expect, it } from "vitest";
import {
  createWorkflowExecutionBudget,
  isIndependentReadOnlyTool,
  reserveWorkflowToolBudget,
  shouldDryRunWorkflowTool,
} from "@/lib/workflows/executor";
import type { WorkflowPlanNode } from "@/lib/workflows/types";
import type { ToolDefinition } from "@/lib/tools/types";

const node: WorkflowPlanNode = {
  id: "node-1",
  label: "Call connector",
  kind: "tool",
  description: "Call an external system.",
  dependsOn: [],
  toolIds: ["connector.demo"],
  connectorTargets: ["demo"],
  riskLevel: 2,
  approvalRequired: true,
  policy: "approval_required",
  acceptanceCriteria: ["External system was updated."],
  expectedOutputs: ["tool result"],
};

const connectorTool: ToolDefinition = {
  id: "connector.demo",
  name: "Demo connector",
  description: "Writes to a demo connector.",
  category: "connector",
  status: "active",
  riskLevel: 2,
  dryRunSupported: true,
  approvalRequired: true,
  reversible: true,
  inputSchema: { type: "object", additionalProperties: true },
};

describe("workflow executor dry-run policy", () => {
  it("dry-runs side-effecting tools before workflow approval", () => {
    expect(shouldDryRunWorkflowTool({ toolId: connectorTool.id, tool: connectorTool, node })).toBe(true);
  });

  it("allows side-effecting tools to execute after workflow approval", () => {
    expect(
      shouldDryRunWorkflowTool({
        toolId: connectorTool.id,
        tool: connectorTool,
        node,
        workflowApproved: true,
      }),
    ).toBe(false);
  });

  it("preserves an explicit dry-run node after workflow approval", () => {
    expect(
      shouldDryRunWorkflowTool({
        toolId: connectorTool.id,
        tool: connectorTool,
        node: {
          ...node,
          policy: "dry_run",
        },
        workflowApproved: true,
      }),
    ).toBe(true);
  });

  it("keeps risk-3 tools in preview mode after a single workflow approval", () => {
    expect(
      shouldDryRunWorkflowTool({
        toolId: connectorTool.id,
        tool: {
          ...connectorTool,
          riskLevel: 3,
          reversible: false,
        },
        node: {
          ...node,
          riskLevel: 3,
        },
        workflowApproved: true,
      }),
    ).toBe(true);
  });
});

describe("workflow execution budgets", () => {
  it("fails closed before exceeding the run-wide tool-call budget", () => {
    const budget = createWorkflowExecutionBudget({
      maxToolCalls: 2,
      maxCostUnits: 100,
      maxWallClockMs: 10_000,
      startedAt: 1_000,
    });
    reserveWorkflowToolBudget({
      budget,
      tool: connectorTool,
      dryRun: true,
      now: 1_001,
    });
    reserveWorkflowToolBudget({
      budget,
      tool: connectorTool,
      dryRun: true,
      now: 1_002,
    });

    expect(() =>
      reserveWorkflowToolBudget({
        budget,
        tool: connectorTool,
        dryRun: true,
        now: 1_003,
      }),
    ).toThrow("2-call tool budget");
  });

  it("bounds weighted external-tool cost and parallelizes only read-only work", () => {
    const budget = createWorkflowExecutionBudget({
      maxToolCalls: 10,
      maxCostUnits: 5,
      maxWallClockMs: 10_000,
      startedAt: 1_000,
    });
    reserveWorkflowToolBudget({
      budget,
      tool: connectorTool,
      dryRun: false,
      now: 1_001,
    });
    expect(() =>
      reserveWorkflowToolBudget({
        budget,
        tool: connectorTool,
        dryRun: false,
        now: 1_002,
      }),
    ).toThrow("5-unit cost budget");
    expect(isIndependentReadOnlyTool(connectorTool)).toBe(false);
    expect(
      isIndependentReadOnlyTool({
        ...connectorTool,
        id: "knowledge.search",
        category: "knowledge",
        riskLevel: 0,
        approvalRequired: false,
      }),
    ).toBe(true);
  });
});
