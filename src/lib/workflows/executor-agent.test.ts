import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createExecutionScope } from "@/lib/security/execution-scope";

const mocks = vi.hoisted(() => ({
  generateModelStructured: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
  appendWorkflowEvent: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
  listWorkflowRunSummaries: vi.fn(),
  shareDelegationMissionArtifact: vi.fn(),
  sendDelegationMessage: vi.fn(),
}));

vi.mock("@/lib/models/gateway", () => ({
  generateModelStructured: mocks.generateModelStructured,
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolveRuntimeModelAssignment,
}));
vi.mock("@/lib/workflows/store", () => ({
  appendWorkflowEvent: mocks.appendWorkflowEvent,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
  listWorkflowRunSummaries: mocks.listWorkflowRunSummaries,
}));
vi.mock("@/lib/delegation/channel-store", () => ({
  shareDelegationMissionArtifact: mocks.shareDelegationMissionArtifact,
  sendDelegationMessage: mocks.sendDelegationMessage,
}));

import {
  createWorkflowExecutionBudget,
  executeAgentPlanNode,
  executeDynamicWorkflowPlan,
} from "@/lib/workflows/executor";
import { buildWorkflowNodeDelegationContractV1 } from "@/lib/delegation/workflow-adapter";
import {
  buildWorkflowNodeInput,
  withWorkflowNodeContract,
} from "@/lib/workflows/node-contract";
import type {
  WorkflowPlanNode,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

const node: WorkflowPlanNode = withWorkflowNodeContract({
  id: "analyze-goal",
  label: "Analyze goal",
  kind: "research",
  description: "Identify the two concrete deliverables in the goal.",
  dependsOn: [],
  toolIds: [],
  connectorTargets: [],
  riskLevel: 0,
  approvalRequired: false,
  policy: "auto",
  acceptanceCriteria: ["Two concrete deliverables are identified."],
  expectedOutputs: ["deliverable analysis"],
});

const detail: WorkflowRunDetail = {
  run: {
    id: "workflow-1",
    tenantId: "tenant-1",
    workflowType: "agent.workflow.v1",
    status: "running",
    goal: "Prepare a brief and publish a release note.",
    input: {
      goal: "Prepare a brief and publish a release note.",
      metadata: { actorId: "actor-1" },
    },
    currentStep: "execute",
    attempt: 1,
    maxAttempts: 3,
    approvalRequired: false,
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:01.000Z",
  },
  steps: [],
  events: [],
};

beforeAll(async () => {
  process.env.OMNIAGENT_DATA_DIR = await mkdtemp(
    path.join(tmpdir(), "omni-node-executor-"),
  );
  delete process.env.DATABASE_URL;
});

describe("workflow agent node execution", () => {
  beforeEach(() => {
    mocks.generateModelStructured.mockReset();
    mocks.resolveRuntimeModelAssignment.mockReset();
    mocks.appendWorkflowEvent.mockReset();
    mocks.getWorkflowRunExecutionAuthority.mockReset();
    mocks.shareDelegationMissionArtifact.mockReset();
    mocks.sendDelegationMessage.mockReset();
    mocks.getWorkflowRunExecutionAuthority.mockResolvedValue(undefined);
    mocks.resolveRuntimeModelAssignment.mockResolvedValue({
      configured: true,
      source: "deployment_environment",
      assignmentId: undefined,
      bind: <T>(request: T) => request,
    });
    mocks.shareDelegationMissionArtifact.mockResolvedValue({
      artifactId: `delegation-artifact:${"c".repeat(64)}`,
      artifactSha256: "c".repeat(64),
    });
    mocks.sendDelegationMessage.mockResolvedValue({
      messageId: `delegation-message:${"d".repeat(64)}`,
    });
  });

  it("requires a bounded model call and returns a content-free model receipt", async () => {
    mockSuccessfulNodeGeneration();
    const nodeInput = buildWorkflowNodeInput({
      objective: detail.run.goal,
      node,
      dependencyRecords: [],
    });

    const result = await executeAgentPlanNode({
      detail,
      node,
      nodeInput,
      delegationContract: delegationContract(nodeInput),
      dependencyRecords: [],
      budget: createWorkflowExecutionBudget(),
    });

    expect(result.nodeResult).toMatchObject({
      schemaVersion: 1,
      completionBasis: "model_receipt",
      status: "completed",
      sideEffectClaimed: false,
    });
    expect(result.executionReceipt).toMatchObject({
      schemaVersion: 1,
      nodeId: node.id,
      executor: "agent",
      inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      outputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      toolExecutionIds: [],
      model: {
        provider: "openai",
        model: "gpt-test",
        usageReceiptId: "usage-1",
        usageReceiptRecorded: true,
        attemptCount: 1,
      },
      delegation: {
        delegationId: expect.stringMatching(/^delegation:[a-f0-9]{64}$/),
        contractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        delegatePrincipalId: expect.any(String),
        verifierAgentId: "sentinel",
        taskId: expect.stringMatching(/^delegation-task:delegation:/),
        lifecycleState: "result_accepted",
        lifecycleRevision: 4,
        proposalReceiptSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    expect(mocks.generateModelStructured).toHaveBeenCalledOnce();
    expect(mocks.generateModelStructured.mock.calls[0]?.[0]).toMatchObject({
      name: "workflow_node_result_v1",
      maxOutputTokens: 1_800,
      reasoningEffort: "low",
      tier: "reasoning",
      usageScope: {
        tenantId: "tenant-1",
        actorId: "actor-1",
        purpose: "workflow.node.agent.execute",
      },
    });
    expect(mocks.generateModelStructured.mock.calls[0]?.[0].input)
      .toContain("<delegation_contract");
  });

  it("persists a completed plan node only with typed input, output, and receipt", async () => {
    mockSuccessfulNodeGeneration();
    const planDetail: WorkflowRunDetail = {
      ...detail,
      run: { ...detail.run, id: "workflow-integrated-1" },
      steps: [{
        id: "step-plan-1",
        tenantId: "tenant-1",
        workflowRunId: "workflow-integrated-1",
        stepKey: "plan",
        label: "Plan",
        status: "completed",
        attempt: 1,
        maxAttempts: 3,
        input: {},
        output: {
          id: "plan-integrated-1",
          planner: "deterministic",
          confidence: 1,
          validation: { isDag: true },
          plan: {
            objective: detail.run.goal,
            summary: "Analyze the goal.",
            mode: "orchestrate",
            assumptions: [],
            constraints: [],
            risks: [],
            acceptanceCriteria: node.acceptanceCriteria,
            nodes: [node],
            edges: [],
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
            confidence: 1,
          },
        },
        startedAt: "2026-09-06T00:00:00.000Z",
        completedAt: "2026-09-06T00:00:01.000Z",
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:01.000Z",
      }],
    };

    const summary = await executeDynamicWorkflowPlan(planDetail);

    expect(summary).toMatchObject({
      status: "completed",
      totalNodes: 1,
      completedNodes: 1,
      toolExecutions: 0,
      nodeExecutions: [{
        status: "completed",
        input: {
          schemaVersion: 1,
          executor: "agent",
          grants: { toolIds: [] },
          delegationContract: {
            version: "p8.1-delegation-contract:1",
            delegate: { agentId: "scout", definitionVersion: 1 },
          },
        },
        output: {
          nodeResult: { completionBasis: "model_receipt" },
          delegationContract: {
            version: "p8.1-delegation-contract:1",
          },
          executionReceipt: {
            schemaVersion: 1,
            executor: "agent",
            delegation: { verifierAgentId: "sentinel" },
            model: { usageReceiptId: "usage-1" },
          },
        },
      }],
    });
    expect(mocks.appendWorkflowEvent).toHaveBeenCalledWith(
      "workflow-integrated-1",
      "workflow.plan_node.started",
      expect.objectContaining({
        delegationId: expect.stringMatching(/^delegation:[a-f0-9]{64}$/),
        delegationContractSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("uses a new durable delegation boundary when a failed node is retried", async () => {
    mocks.generateModelStructured.mockRejectedValueOnce(
      new Error("Transient model failure."),
    );
    mockSuccessfulNodeGeneration();
    const workflowRunId = "workflow-delegation-retry-1";
    const planId = "plan-delegation-retry-1";
    const retryDetail: WorkflowRunDetail = {
      ...detail,
      run: { ...detail.run, id: workflowRunId },
      steps: [{
        id: "step-plan-retry-1",
        tenantId: "tenant-1",
        workflowRunId,
        stepKey: "plan",
        label: "Plan",
        status: "completed",
        attempt: 1,
        maxAttempts: 3,
        input: {},
        output: {
          id: planId,
          planner: "deterministic",
          confidence: 1,
          validation: { isDag: true },
          plan: {
            objective: detail.run.goal,
            summary: "Analyze the goal.",
            mode: "orchestrate",
            assumptions: [],
            constraints: [],
            risks: [],
            acceptanceCriteria: node.acceptanceCriteria,
            nodes: [node],
            edges: [],
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
            confidence: 1,
          },
        },
        createdAt: "2026-09-06T00:00:00.000Z",
        updatedAt: "2026-09-06T00:00:01.000Z",
        completedAt: "2026-09-06T00:00:01.000Z",
      }],
    };

    expect(await executeDynamicWorkflowPlan(retryDetail)).toMatchObject({
      status: "failed",
      failedNodes: 1,
    });
    expect(await executeDynamicWorkflowPlan(retryDetail)).toMatchObject({
      status: "completed",
      completedNodes: 1,
    });

    const starts = mocks.appendWorkflowEvent.mock.calls.filter(
      ([runId, type]) =>
        runId === workflowRunId && type === "workflow.plan_node.started",
    );
    expect(starts.map(([, , payload]) => payload)).toMatchObject([
      { delegationAttempt: 1 },
      { delegationAttempt: 2 },
    ]);
    expect(starts[0]?.[2].delegationId).not.toBe(starts[1]?.[2].delegationId);
  });

  it("shares a Mission completion proposal before parent acceptance", async () => {
    mockSuccessfulNodeGeneration();
    const executionScope = createExecutionScope({
      tenantId: "tenant-1",
      initiatingActorId: "actor-1",
      executingPrincipalType: "agent",
      executingPrincipalId: "principal:atlas:1",
      missionId: "mission-one",
      correlationId: detail.run.id,
      purpose: "workflow.run",
    });
    const nodeInput = buildWorkflowNodeInput({
      objective: detail.run.goal,
      node,
      dependencyRecords: [],
    });
    const contract = buildWorkflowNodeDelegationContractV1({
      detail,
      planId: "plan-test",
      node,
      nodeInput,
      dependencyRecords: [],
      parentExecutionScope: executionScope,
      remainingWallTimeMs: 30_000,
      createdAt: new Date().toISOString(),
    });

    const result = await executeAgentPlanNode({
      detail,
      node,
      nodeInput,
      delegationContract: contract,
      dependencyRecords: [],
      executionAuthority: { executionScope, requesterRole: "admin" },
      budget: createWorkflowExecutionBudget(),
    });

    expect(result.executionReceipt.delegation?.lifecycleState)
      .toBe("result_accepted");
    expect(mocks.shareDelegationMissionArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-one",
        recipients: { parent: true, delegationTaskIds: [] },
        task: expect.objectContaining({ state: "completed_proposed" }),
      }),
    );
    expect(mocks.sendDelegationMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        missionId: "mission-one",
        artifactReferences: [expect.objectContaining({
          artifactSha256: "c".repeat(64),
        })],
      }),
    );
  });
});

function delegationContract(nodeInput: ReturnType<typeof buildWorkflowNodeInput>) {
  return buildWorkflowNodeDelegationContractV1({
    detail,
    planId: "plan-test",
    node,
    nodeInput,
    dependencyRecords: [],
    remainingWallTimeMs: 30_000,
    createdAt: new Date().toISOString(),
  });
}

function mockSuccessfulNodeGeneration() {
  mocks.generateModelStructured.mockResolvedValue({
    text: JSON.stringify({
      status: "completed",
      summary: "The goal has two separate deliverables.",
      artifacts: [{
        name: "deliverable analysis",
        kind: "analysis",
        content: "1. Prepare a brief. 2. Publish a release note.",
        evidenceIds: [],
      }],
      acceptanceChecks: [{
        criterion: "Two concrete deliverables are identified.",
        passed: true,
        evidenceIds: [],
        note: "Both deliverables are explicit in the admitted objective.",
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
    usageReceiptId: "usage-1",
    providerRequestId: "provider-request-1",
  });
}
