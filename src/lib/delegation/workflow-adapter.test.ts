import { describe, expect, it } from "vitest";

import { buildWorkflowNodeDelegationContractV1 } from "@/lib/delegation/workflow-adapter";
import { createExecutionScope } from "@/lib/security/execution-scope";
import {
  buildWorkflowNodeInput,
  withWorkflowNodeContract,
} from "@/lib/workflows/node-contract";
import type {
  WorkflowPlanNode,
  WorkflowPlanNodeExecutionRecord,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

describe("P8.1 workflow delegation adapter", () => {
  it("creates an independently understandable model-only contract using artifact references", () => {
    const nodeInput = buildWorkflowNodeInput({
      objective: detail.run.goal,
      node,
      dependencyRecords: [dependency],
    });
    const contract = buildWorkflowNodeDelegationContractV1({
      detail,
      planId: "plan-one",
      node,
      nodeInput,
      dependencyRecords: [dependency],
      parentExecutionScope,
      remainingWallTimeMs: 30_000,
      createdAt: "2026-09-07T06:00:00.000Z",
    });

    expect(contract).toMatchObject({
      delegator: { agentId: "atlas", definitionVersion: 1 },
      delegate: { agentId: "scout", definitionVersion: 1 },
      purpose: "workflow.node.research.execute",
      grants: {
        contextGrantIds: [],
        capabilityGrantIds: [],
        governedToolIds: [],
        connectorTargets: [],
      },
      budgets: {
        modelTurns: 1,
        toolCalls: 0,
        agents: 1,
        retries: 0,
      },
      verifier: {
        agentId: "sentinel",
        completionDisposition: "proposed_only",
      },
    });
    expect(contract.objective).toContain(node.description);
    expect(contract.objective).toContain(detail.run.goal);
    expect(contract.inputArtifacts).toHaveLength(1);
    expect(contract.inputArtifacts[0]).toMatchObject({
      sourceExecutionId: dependency.id,
      name: "source brief",
      kind: "analysis",
      byteCount: Buffer.byteLength(secretFreeArtifact, "utf8"),
    });
    expect(JSON.stringify(contract)).not.toContain(secretFreeArtifact);
    expect(contract.dataBoundary).toMatchObject({
      parentTranscriptIncluded: false,
      credentialMaterialIncluded: false,
      inputArtifactsByReferenceOnly: true,
    });
  });

  it("fails closed when a stored Agent identity does not match the execution scope", () => {
    expect(() => buildWorkflowNodeDelegationContractV1({
      detail: {
        ...detail,
        run: {
          ...detail.run,
          input: {
            ...detail.run.input,
            metadata: { ...detail.run.input.metadata, agentIdentity: {} },
          },
        },
      },
      planId: "plan-one",
      node,
      nodeInput: buildWorkflowNodeInput({
        objective: detail.run.goal,
        node,
        dependencyRecords: [dependency],
      }),
      dependencyRecords: [dependency],
      parentExecutionScope,
      remainingWallTimeMs: 30_000,
    })).toThrow();
  });
});

const secretFreeArtifact = "The release requires a migration and a focused verification receipt.";

const dependency: WorkflowPlanNodeExecutionRecord = {
  id: "execution-one",
  tenantId: "tenant-one",
  workflowRunId: "workflow-one",
  planId: "plan-one",
  nodeId: "collect-input",
  nodeLabel: "Collect input",
  nodeKind: "research",
  status: "completed",
  policy: "auto",
  riskLevel: 0,
  approvalRequired: false,
  toolExecutionIds: [],
  input: {},
  output: {
    nodeResult: {
      artifacts: [{
        name: "source brief",
        kind: "analysis",
        content: secretFreeArtifact,
        evidenceIds: ["evidence-one"],
      }],
    },
  },
  createdAt: "2026-09-07T05:59:00.000Z",
  updatedAt: "2026-09-07T05:59:30.000Z",
  completedAt: "2026-09-07T05:59:30.000Z",
};

const node: WorkflowPlanNode = withWorkflowNodeContract({
  id: "research-release",
  label: "Research release",
  kind: "research",
  description: "Identify the evidence required to release the feature.",
  dependsOn: [dependency.nodeId],
  toolIds: [],
  connectorTargets: [],
  riskLevel: 0,
  approvalRequired: false,
  policy: "auto",
  acceptanceCriteria: ["Every required release check is named."],
  expectedOutputs: ["release evidence checklist"],
});

const detail: WorkflowRunDetail = {
  run: {
    id: "workflow-one",
    tenantId: "tenant-one",
    workflowType: "agent.workflow.v1",
    status: "running",
    goal: "Prepare the release evidence for the delegated feature.",
    input: {
      goal: "Prepare the release evidence for the delegated feature.",
      metadata: { actorId: "actor-one", primaryAgentId: "atlas" },
    },
    attempt: 1,
    maxAttempts: 3,
    approvalRequired: false,
    createdAt: "2026-09-07T05:58:00.000Z",
    updatedAt: "2026-09-07T05:59:00.000Z",
  },
  steps: [],
  events: [],
};

const parentExecutionScope = createExecutionScope({
  tenantId: "tenant-one",
  initiatingActorId: "actor-one",
  executingPrincipalType: "agent",
  executingPrincipalId: "principal:parent",
  correlationId: "correlation-one",
  contextGrantIds: ["context-one"],
  capabilityGrantIds: ["capability-one"],
  purpose: "workflow.run",
});
