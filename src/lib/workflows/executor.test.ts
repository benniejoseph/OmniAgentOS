import { describe, expect, it } from "vitest";
import {
  createWorkflowExecutionBudget,
  isIndependentReadOnlyTool,
  reserveWorkflowToolBudget,
  selectScheduledMutationBinding,
  shouldDryRunWorkflowTool,
  workflowToolEffectBinding,
} from "@/lib/workflows/executor";
import {
  approvalGrantTargetSha256,
  approvalGrantToolContractSha256,
} from "@/lib/approval-grants/authorization";
import { canonicalJsonSha256 } from "@/lib/tools/effect-receipt";
import { toolInputSha256 } from "@/lib/tools/execution-scope";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanNode,
  WorkflowScheduleMutationBindingV1,
  WorkflowScheduleMutationPolicyV1,
} from "@/lib/workflows/types";
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
  operationClass: "mutation",
  reversible: true,
  inputSchema: { type: "object", additionalProperties: true },
};

const plan: WorkflowDynamicPlan = {
  objective: "Update the external system.",
  summary: "Create one record.",
  mode: "execute",
  assumptions: [],
  constraints: [],
  risks: [],
  acceptanceCriteria: ["External system was updated."],
  nodes: [node],
  edges: [],
  selectedToolIds: [connectorTool.id],
  connectorTargets: ["demo"],
  executionPolicy: {
    highestRiskLevel: 2,
    requiresApproval: true,
    defaultPolicy: "approval_required",
    notes: [],
  },
  verificationPlan: [],
  memoryPlan: [],
  confidence: 0.9,
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

describe("workflow effect binding", () => {
  it("binds an approved provider mutation to the exact persisted plan", () => {
    expect(workflowToolEffectBinding({
      workflowRunId: "workflow-1",
      plan,
      planId: "plan-1",
      node,
      toolId: connectorTool.id,
      tool: connectorTool,
      toolInput: { recordId: "record-1" },
      workflowApproved: true,
      dryRun: false,
      initiatingActorId: "owner-1",
    })).toMatchObject({
      workflowRunId: "workflow-1",
      planId: "plan-1",
      planSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      planNodeId: node.id,
    });
  });

  it("does not bind read-only, preview, or actorless executions", () => {
    const base = {
      workflowRunId: "workflow-1",
      plan,
      planId: "plan-1",
      node,
      toolId: connectorTool.id,
      tool: connectorTool,
      toolInput: {},
      workflowApproved: true,
      dryRun: false,
      initiatingActorId: "owner-1",
    };
    expect(workflowToolEffectBinding({
      ...base,
      tool: { ...connectorTool, operationClass: "read_only" },
    })).toBeUndefined();
    expect(workflowToolEffectBinding({ ...base, dryRun: true }))
      .toBeUndefined();
    expect(workflowToolEffectBinding({ ...base, initiatingActorId: null }))
      .toBeUndefined();
  });
});

describe("reviewed schedule mutation binding", () => {
  const buildBinding = (
    bindingIndex: number,
    toolInput: Record<string, unknown>,
  ): WorkflowScheduleMutationBindingV1 => {
    const body = {
      schemaVersion: 1 as const,
      bindingIndex,
      toolId: connectorTool.id,
      inputSha256: toolInputSha256(toolInput),
      targetSha256: approvalGrantTargetSha256(connectorTool, toolInput),
      toolContractSha256: approvalGrantToolContractSha256(connectorTool),
      riskLevel: 2 as const,
      reversible: true as const,
    };
    return Object.freeze({
      ...body,
      bindingSha256: canonicalJsonSha256(body),
    });
  };
  const buildPolicy = (
    bindings: readonly WorkflowScheduleMutationBindingV1[],
  ): WorkflowScheduleMutationPolicyV1 => {
    const body = {
      schemaVersion: 1 as const,
      policyKind: "reviewed_static_mutation" as const,
      procedureSnapshotSha256: "1".repeat(64),
      agentIdentityPinSha256: "2".repeat(64),
      agentPolicyPinSha256: "3".repeat(64),
      occurrenceBudgetSha256: "4".repeat(64),
      maximumOccurrences: 5,
      bindings,
    };
    return Object.freeze({ ...body, policySha256: canonicalJsonSha256(body) });
  };

  it("selects the exact input when one tool appears in multiple bindings", () => {
    const firstInput = { recordId: "record-one", title: "First" };
    const secondInput = { recordId: "record-two", title: "Second" };
    const first = buildBinding(0, firstInput);
    const second = buildBinding(1, secondInput);

    expect(selectScheduledMutationBinding({
      policy: buildPolicy([first, second]),
      tool: connectorTool,
      toolInput: secondInput,
    })).toEqual(second);
  });

  it("rejects ambiguous duplicate exact bindings", () => {
    const toolInput = { recordId: "record-one", title: "Same effect" };
    const first = buildBinding(0, toolInput);
    const duplicate = buildBinding(1, toolInput);

    expect(selectScheduledMutationBinding({
      policy: buildPolicy([first, duplicate]),
      tool: connectorTool,
      toolInput,
    })).toBeUndefined();
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
        operationClass: "read_only",
      }),
    ).toBe(true);
    expect(
      isIndependentReadOnlyTool({
        ...connectorTool,
        id: "knowledge.search",
        category: "knowledge",
        riskLevel: 0,
        approvalRequired: false,
        operationClass: "mutation",
      }),
    ).toBe(false);
  });
});
