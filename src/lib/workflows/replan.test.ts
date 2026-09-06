import { describe, expect, it } from "vitest";
import {
  applyWorkflowSubtreeReplan,
  createWorkflowReplanDirective,
  resolveWorkflowReusedNodeExecutions,
} from "@/lib/workflows/replan";
import type {
  WorkflowDynamicPlan,
  WorkflowPlanNode,
  WorkflowPlanNodeExecutionRecord,
} from "@/lib/workflows/types";

const nodes: WorkflowPlanNode[] = [
  node("source-a", []),
  node("source-b", []),
  node("join", ["source-a", "source-b"]),
  node("report", ["join"]),
];
const previousPlan = plan(nodes);
const executions = nodes.map((item, index) => execution(item, index));

describe("bounded workflow subtree replanning", () => {
  it("targets the failed node and descendants while binding reusable evidence", () => {
    const directive = createWorkflowReplanDirective({
      previousPlanId: "plan-old",
      previousPlan,
      nodeExecutions: executions,
      verificationFailures: ["The join node failed its acceptance check."],
      approvalInvalidated: true,
      previousContextTraceId: "trace-old",
    });

    expect(directive).toMatchObject({
      schemaVersion: 1,
      previousPlanId: "plan-old",
      trigger: "verification",
      failureNodeIds: ["join"],
      affectedNodeIds: ["join", "report"],
      approvalInvalidated: true,
      contextGrantsInvalidated: true,
      capabilityGrantsInvalidated: true,
    });
    expect(directive.reusedNodes.map((reference) => reference.nodeId)).toEqual([
      "source-a",
      "source-b",
    ]);
  });

  it("preserves unaffected nodes exactly and accepts material affected changes", () => {
    const directive = createWorkflowReplanDirective({
      previousPlanId: "plan-old",
      previousPlan,
      nodeExecutions: executions,
      verificationFailures: ["join did not synthesize the sources"],
      approvalInvalidated: false,
    });
    const candidate = plan(nodes.map((item) =>
      item.id === "join"
        ? { ...item, description: "Synthesize both typed source artifacts with evidence." }
        : { ...item, description: `Untrusted candidate edit to ${item.id}.` }
    ));

    const replanned = applyWorkflowSubtreeReplan({
      previousPlanId: "plan-old",
      previousPlan,
      candidatePlan: candidate,
      directive,
    });

    expect(replanned.nodes.find((item) => item.id === "source-a"))
      .toEqual(previousPlan.nodes[0]);
    expect(replanned.nodes.find((item) => item.id === "source-b"))
      .toEqual(previousPlan.nodes[1]);
    expect(replanned.nodes.find((item) => item.id === "join")?.description)
      .toContain("typed source artifacts");
    expect(resolveWorkflowReusedNodeExecutions(replanned, executions).map((record) => record.nodeId))
      .toEqual(["source-a", "source-b"]);
  });

  it("fails closed on topology, no-op, or reusable-output tampering", () => {
    const directive = createWorkflowReplanDirective({
      previousPlanId: "plan-old",
      previousPlan,
      nodeExecutions: executions,
      verificationFailures: ["join failed"],
      approvalInvalidated: false,
    });
    expect(() => applyWorkflowSubtreeReplan({
      previousPlanId: "plan-old",
      previousPlan,
      candidatePlan: plan(nodes.slice(0, -1)),
      directive,
    })).toThrow("exact bounded node ID set");
    expect(() => applyWorkflowSubtreeReplan({
      previousPlanId: "plan-old",
      previousPlan,
      candidatePlan: previousPlan,
      directive,
    })).toThrow("did not materially change");

    const changed = plan(nodes.map((item) =>
      item.id === "join" ? { ...item, description: "Changed join." } : item
    ));
    const replanned = applyWorkflowSubtreeReplan({
      previousPlanId: "plan-old",
      previousPlan,
      candidatePlan: changed,
      directive,
    });
    const tampered = executions.map((record) =>
      record.nodeId === "source-a"
        ? { ...record, output: { ...record.output, artifact: "tampered" } }
        : record
    );
    expect(() => resolveWorkflowReusedNodeExecutions(replanned, tampered))
      .toThrow("failed lineage validation");
  });
});

function node(id: string, dependsOn: string[]): WorkflowPlanNode {
  return {
    id,
    label: id,
    kind: id === "report" ? "report" : "research",
    description: `Execute ${id}.`,
    dependsOn,
    toolIds: [],
    inputBindings: [],
    connectorTargets: [],
    riskLevel: 0,
    approvalRequired: false,
    policy: "auto",
    acceptanceCriteria: [`${id} is complete.`],
    expectedOutputs: [`${id} artifact`],
  };
}

function plan(planNodes: WorkflowPlanNode[]): WorkflowDynamicPlan {
  return {
    objective: "Build a report from two sources.",
    summary: "Combine two independent sources.",
    mode: "orchestrate",
    assumptions: [],
    constraints: [],
    risks: [],
    acceptanceCriteria: ["The report uses both sources."],
    nodes: planNodes,
    edges: planNodes.flatMap((item) => item.dependsOn.map((dependencyId) => ({
      from: dependencyId,
      to: item.id,
      condition: "completed",
    }))),
    selectedToolIds: [],
    connectorTargets: [],
    executionPolicy: {
      highestRiskLevel: 0,
      requiresApproval: false,
      defaultPolicy: "auto",
      notes: [],
    },
    verificationPlan: [],
    memoryPlan: [],
    confidence: 0.8,
  };
}

function execution(
  planNode: WorkflowPlanNode,
  index: number,
): WorkflowPlanNodeExecutionRecord {
  return {
    id: `execution-${planNode.id}`,
    tenantId: "tenant-1",
    workflowRunId: "workflow-1",
    planId: "plan-old",
    nodeId: planNode.id,
    nodeLabel: planNode.label,
    nodeKind: planNode.kind,
    status: "completed",
    policy: "auto",
    riskLevel: 0,
    approvalRequired: false,
    toolExecutionIds: [],
    input: { schemaVersion: 1, nodeId: planNode.id },
    output: {
      nodeResult: {
        artifacts: [{ name: `${planNode.id} artifact`, content: `result ${index}` }],
        acceptanceChecks: [{ criterion: `${planNode.id} is complete.`, passed: true }],
      },
    },
    startedAt: "2026-09-06T00:00:00.000Z",
    completedAt: "2026-09-06T00:00:01.000Z",
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:01.000Z",
  };
}
