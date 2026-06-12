import { describe, expect, it } from "vitest";
import { shouldDryRunWorkflowTool } from "@/lib/workflows/executor";
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
});
