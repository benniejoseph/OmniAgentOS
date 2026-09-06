import { describe, expect, it } from "vitest";
import {
  buildWorkflowNodeInput,
  deriveWorkflowNodeContract,
  parseWorkflowNodeAgentResult,
  resolveWorkflowNodeContract,
  withWorkflowNodeContract,
} from "@/lib/workflows/node-contract";
import type {
  WorkflowPlanNode,
  WorkflowPlanNodeExecutionRecord,
} from "@/lib/workflows/types";

const baseNode: WorkflowPlanNode = {
  id: "verify-output",
  label: "Verify output",
  kind: "verify",
  description: "Compare the dependency result with the declared acceptance criterion.",
  dependsOn: ["execute-work"],
  toolIds: [],
  connectorTargets: [],
  riskLevel: 0,
  approvalRequired: false,
  policy: "auto",
  acceptanceCriteria: ["The dependency contains a durable execution result."],
  expectedOutputs: ["verification result"],
};

function completedDependency(
  overrides: Partial<WorkflowPlanNodeExecutionRecord> = {},
): WorkflowPlanNodeExecutionRecord {
  return {
    id: "execution-1",
    tenantId: "tenant-1",
    workflowRunId: "workflow-1",
    planId: "plan-1",
    nodeId: "execute-work",
    nodeLabel: "Execute work",
    nodeKind: "execute",
    status: "completed",
    policy: "auto",
    riskLevel: 0,
    approvalRequired: false,
    toolExecutionIds: ["tool-execution-1"],
    input: {},
    output: {
      nodeResult: {
        artifacts: [{
          name: "tool result",
          kind: "result",
          content: "The governed tool returned record-123.",
          evidenceIds: ["tool-execution-1"],
        }],
      },
    },
    startedAt: "2026-09-06T00:00:00.000Z",
    completedAt: "2026-09-06T00:00:01.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:01.000Z",
    ...overrides,
  };
}

describe("workflow node execution contract", () => {
  it("derives bounded executor and grant declarations from the admitted node", () => {
    expect(deriveWorkflowNodeContract(baseNode)).toEqual({
      schemaVersion: 1,
      executor: "agent",
      dependencyNodeIds: ["execute-work"],
      grantedToolIds: [],
      maxToolCalls: 0,
      maxModelCalls: 1,
      maxOutputChars: 6_000,
    });
    expect(deriveWorkflowNodeContract({
      ...baseNode,
      kind: "tool",
      toolIds: ["knowledge.search", "knowledge.search"],
    })).toMatchObject({
      executor: "tool",
      grantedToolIds: ["knowledge.search"],
      maxToolCalls: 1,
      maxModelCalls: 0,
    });
  });

  it("rejects a persisted contract that broadens dependencies or tool grants", () => {
    const contracted = withWorkflowNodeContract(baseNode);
    expect(() => resolveWorkflowNodeContract({
      ...contracted,
      execution: {
        ...contracted.execution!,
        grantedToolIds: ["connector.undeclared"],
      },
    })).toThrow("does not match its declared dependencies and grants");
  });

  it("builds input only from declared completed dependency artifacts", () => {
    const input = buildWorkflowNodeInput({
      objective: "Verify the work.",
      node: withWorkflowNodeContract(baseNode),
      dependencyRecords: [completedDependency()],
    });
    expect(input).toMatchObject({
      schemaVersion: 1,
      nodeId: "verify-output",
      executor: "agent",
      grants: { toolIds: [] },
      dependencies: [{
        nodeId: "execute-work",
        executionId: "execution-1",
        outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        artifacts: [{ evidenceIds: ["tool-execution-1"] }],
      }],
    });
    expect(() => buildWorkflowNodeInput({
      objective: "Verify the work.",
      node: withWorkflowNodeContract(baseNode),
      dependencyRecords: [completedDependency({ nodeId: "undeclared" })],
    })).toThrow("received an undeclared dependency artifact");
  });

  it("accepts substantive typed agent output and rejects task restatement", () => {
    const input = buildWorkflowNodeInput({
      objective: "Verify the work.",
      node: withWorkflowNodeContract(baseNode),
      dependencyRecords: [completedDependency()],
    });
    const agentOutput = {
      status: "completed",
      summary: "The dependency includes a governed execution result.",
      artifacts: [{
        name: "verification",
        kind: "verification",
        content: "record-123 is supported by tool execution tool-execution-1.",
        evidenceIds: ["tool-execution-1"],
      }],
      acceptanceChecks: [{
        criterion: "The dependency contains a durable execution result.",
        passed: true,
        evidenceIds: ["tool-execution-1"],
        note: "The dependency artifact names the governed execution.",
      }],
      sideEffectClaimed: false,
    } as const;
    const result = parseWorkflowNodeAgentResult(agentOutput, input);
    expect(result.completionBasis).toBe("model_receipt");
    expect(() => parseWorkflowNodeAgentResult({
      ...agentOutput,
      artifacts: [{
        name: "restatement",
        kind: "analysis",
        content: baseNode.description,
        evidenceIds: [],
      }],
    }, input)).toThrow("only restated its task description");
  });
});
