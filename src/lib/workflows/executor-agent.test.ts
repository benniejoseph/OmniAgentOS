import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  generateModelStructured: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
  appendWorkflowEvent: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
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
}));

import {
  createWorkflowExecutionBudget,
  executeAgentPlanNode,
  executeDynamicWorkflowPlan,
} from "@/lib/workflows/executor";
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
    mocks.getWorkflowRunExecutionAuthority.mockResolvedValue(undefined);
    mocks.resolveRuntimeModelAssignment.mockResolvedValue({
      configured: true,
      source: "deployment_environment",
      assignmentId: undefined,
      bind: <T>(request: T) => request,
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
        },
        output: {
          nodeResult: { completionBasis: "model_receipt" },
          executionReceipt: {
            schemaVersion: 1,
            executor: "agent",
            model: { usageReceiptId: "usage-1" },
          },
        },
      }],
    });
  });
});

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
