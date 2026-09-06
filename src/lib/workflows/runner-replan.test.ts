import { beforeEach, describe, expect, it, vi } from "vitest";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

const mocks = vi.hoisted(() => ({
  appendWorkflowEvent: vi.fn(),
  buildContextPack: vi.fn(),
  generateModelStructured: vi.fn(),
  getWorkflowRunDetail: vi.fn(),
  getWorkflowRunExecutionAuthority: vi.fn(),
  listWorkflowPlanNodeExecutionsForRun: vi.fn(),
  resolveRuntimeModelAssignment: vi.fn(),
  transitionWorkflowRun: vi.fn(),
  updateWorkflowStep: vi.fn(),
  updateWorkflowStepForRunFence: vi.fn(),
}));

vi.mock("@/lib/models/gateway", () => ({
  generateModelStructured: mocks.generateModelStructured,
}));
vi.mock("@/lib/rag/context-engine", () => ({
  buildContextPack: mocks.buildContextPack,
}));
vi.mock("@/lib/settings/runtime-models", () => ({
  resolveRuntimeModelAssignment: mocks.resolveRuntimeModelAssignment,
}));
vi.mock("@/lib/subagents/context", () => ({
  buildWorkflowSpecialistContext: vi.fn(async () => ({
    count: 0,
    evidence: [],
    contextBlock: "",
  })),
  inspectWorkflowSpecialistDependencies: vi.fn(async () => ({ state: "ready" })),
}));
vi.mock("@/lib/workflows/executor", () => ({
  executeDynamicWorkflowPlan: vi.fn(),
  listWorkflowPlanNodeExecutionsForRun: mocks.listWorkflowPlanNodeExecutionsForRun,
  parseWorkflowPlanOutput: (output: Record<string, unknown> | undefined) =>
    output && typeof output.id === "string" && output.plan
      ? {
          id: output.id,
          planner: String(output.planner || "deterministic"),
          confidence: Number(output.confidence || 0),
          validation: output.validation as Record<string, unknown>,
          plan: output.plan,
        }
      : undefined,
}));
vi.mock("@/lib/workflows/store", () => ({
  approveWorkflowRun: vi.fn(),
  appendWorkflowEvent: mocks.appendWorkflowEvent,
  getWorkflowRunExecutionAuthority: mocks.getWorkflowRunExecutionAuthority,
  getWorkflowRunDetail: mocks.getWorkflowRunDetail,
  listRunnableWorkflowRuns: vi.fn(),
  transitionWorkflowRun: mocks.transitionWorkflowRun,
  updateWorkflowStep: mocks.updateWorkflowStep,
  updateWorkflowStepForRunFence: mocks.updateWorkflowStepForRunFence,
  workflowStepDefinitions: [
    { key: "preflight", label: "Preflight" },
    { key: "retrieve_context", label: "Retrieve context" },
    { key: "plan", label: "Plan" },
    { key: "approval_gate", label: "Approval gate" },
    { key: "execute", label: "Execute" },
    { key: "verify", label: "Verify" },
    { key: "persist_report", label: "Persist report" },
  ],
}));

import { tickWorkflowRun } from "@/lib/workflows/runner";

let detail: WorkflowRunDetail;
let updateCounter = 0;

beforeEach(() => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  updateCounter = 0;
  detail = workflowDetail();
  mocks.getWorkflowRunDetail.mockImplementation(async () => structuredClone(detail));
  mocks.getWorkflowRunExecutionAuthority.mockResolvedValue({
    requesterRole: "admin",
    executionScope: {
      version: 1,
      tenantId: "tenant-1",
      initiatingActorId: "actor-1",
      executingPrincipalType: "user",
      executingPrincipalId: "actor-1",
      workspaceId: null,
      projectId: null,
      missionId: null,
      delegationId: null,
      correlationId: "workflow-replan-1",
      causationId: null,
      contextGrantIds: ["context-old"],
      capabilityGrantIds: ["capability-old"],
      purpose: "workflow.run",
    },
  });
  mocks.resolveRuntimeModelAssignment.mockResolvedValue({
    configured: true,
    source: "deployment_environment",
    warnings: [],
    bind: <T>(request: T) => request,
  });
  mocks.generateModelStructured.mockResolvedValue({
    text: JSON.stringify({
      passed: false,
      score: 0.4,
      failures: ["report is missing direct source evidence"],
      assessment: "The report cannot be verified.",
    }),
  });
  mocks.buildContextPack.mockResolvedValue({
    results: [],
    memoryResults: [],
    knowledgeResults: [],
    graphResults: [],
    profile: { mode: "all", intent: "workflow" },
    trace: { id: "trace-new" },
    contextBlock: "",
  });
  mocks.listWorkflowPlanNodeExecutionsForRun.mockResolvedValue(
    detail.steps.find((step) => step.stepKey === "plan")?.output
      ? priorNodeExecutions()
      : [],
  );
  mocks.transitionWorkflowRun.mockImplementation(async (
    _runId: string,
    allowedStatuses: string[],
    patch: Record<string, unknown>,
  ) => {
    if (!allowedStatuses.includes(detail.run.status)) return null;
    updateCounter += 1;
    detail.run = {
      ...detail.run,
      ...patch,
      updatedAt: `2026-09-06T00:00:${String(updateCounter).padStart(2, "0")}.000Z`,
    };
    return structuredClone(detail.run);
  });
  mocks.updateWorkflowStep.mockImplementation(async (
    _runId: string,
    stepKey: string,
    patch: Record<string, unknown>,
  ) => updateStep(stepKey, patch));
  mocks.updateWorkflowStepForRunFence.mockImplementation(async (
    _runId: string,
    stepKey: string,
    patch: Record<string, unknown>,
  ) => updateStep(stepKey, patch));
  mocks.appendWorkflowEvent.mockImplementation(async (
    _runId: string,
    type: string,
    payload: Record<string, unknown>,
  ) => {
    detail.events.push({
      id: `event-${detail.events.length + 1}`,
      tenantId: "tenant-1",
      workflowRunId: detail.run.id,
      type,
      payload,
      createdAt: new Date().toISOString(),
    });
  });
});

describe("workflow runner bounded replan", () => {
  it("restarts at context retrieval, revokes approval, and narrows old grants", async () => {
    const replanning = await tickWorkflowRun(detail.run.id, {
      tenantId: "tenant-1",
    });

    expect(replanning.run).toMatchObject({
      status: "queued",
      currentStep: "retrieve_context",
      approvalRequired: true,
      approvedAt: undefined,
    });
    for (const stepKey of [
      "retrieve_context",
      "plan",
      "approval_gate",
      "execute",
      "verify",
    ]) {
      expect(replanning.steps.find((step) => step.stepKey === stepKey)?.status)
        .toBe("pending");
    }
    const triggered = replanning.events.find(
      (event) => event.type === "workflow.replan_triggered",
    );
    expect(triggered?.payload.directive).toMatchObject({
      schemaVersion: 1,
      previousPlanId: "plan-old",
      failureNodeIds: ["report"],
      affectedNodeIds: ["report"],
      approvalInvalidated: true,
      contextGrantsInvalidated: true,
      capabilityGrantsInvalidated: true,
    });
    expect(replanning.events.some(
      (event) => event.type === "workflow.approval_revoked_on_replan",
    )).toBe(true);

    const retrieved = await tickWorkflowRun(detail.run.id, {
      tenantId: "tenant-1",
    });

    expect(retrieved.run).toMatchObject({
      status: "queued",
      currentStep: "plan",
    });
    const usageScope = mocks.buildContextPack.mock.calls[0]?.[1]?.usageScope;
    expect(usageScope.executionScope).toMatchObject({
      contextGrantIds: [],
      capabilityGrantIds: [],
      purpose: "workflow.replan",
    });
  });

  it("stops before a replan when that authority was not granted", async () => {
    detail.run.input.budgetLimits = {
      ...WORKFLOW_RUN_BUDGET_LIMITS,
      replans: 0,
    };

    const stopped = await tickWorkflowRun(detail.run.id, {
      tenantId: "tenant-1",
    });

    expect(stopped.run).toMatchObject({
      status: "failed",
      currentStep: "verify",
      error: expect.stringMatching(/replan budget is exhausted/i),
    });
    expect(stopped.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "workflow.budget_exhausted",
        payload: expect.objectContaining({
          dimension: "replans",
          requiresAuthorization: true,
        }),
      }),
    ]));
    expect(stopped.events.some((event) =>
      event.type === "workflow.replan_triggered"
    )).toBe(false);
  });
});

function updateStep(stepKey: string, patch: Record<string, unknown>) {
  const index = detail.steps.findIndex((step) => step.stepKey === stepKey);
  if (index < 0) return null;
  detail.steps[index] = {
    ...detail.steps[index],
    ...patch,
    updatedAt: "2026-09-06T00:01:00.000Z",
  };
  return structuredClone(detail.steps[index]);
}

function workflowDetail(): WorkflowRunDetail {
  const plan = {
    objective: "Build a sourced report.",
    summary: "Collect, synthesize, and report.",
    mode: "orchestrate" as const,
    assumptions: [],
    constraints: [],
    risks: [],
    acceptanceCriteria: ["The report cites source evidence."],
    nodes: [
      workflowNode("source", []),
      workflowNode("synthesize", ["source"]),
      workflowNode("report", ["synthesize"]),
    ],
    edges: [
      { from: "source", to: "synthesize", condition: "completed" },
      { from: "synthesize", to: "report", condition: "completed" },
    ],
    selectedToolIds: [],
    connectorTargets: [],
    executionPolicy: {
      highestRiskLevel: 0 as const,
      requiresApproval: true,
      defaultPolicy: "approval_required" as const,
      notes: [],
    },
    verificationPlan: [],
    memoryPlan: [],
    confidence: 0.8,
  };
  const stepKeys = [
    "preflight",
    "retrieve_context",
    "plan",
    "approval_gate",
    "execute",
    "verify",
    "persist_report",
  ] as const;
  return {
    run: {
      id: "workflow-replan-1",
      tenantId: "tenant-1",
      workflowType: "agent.workflow.v1",
      status: "queued",
      goal: plan.objective,
      input: {
        goal: plan.objective,
        budgetLimits: WORKFLOW_RUN_BUDGET_LIMITS,
        metadata: { actorId: "actor-1" },
        executionAuthorityRequired: true,
      },
      currentStep: "verify",
      attempt: 1,
      maxAttempts: 3,
      approvalRequired: true,
      approvedAt: "2026-09-06T00:00:00.000Z",
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
    steps: stepKeys.map((stepKey) => ({
      id: `step-${stepKey}`,
      tenantId: "tenant-1",
      workflowRunId: "workflow-replan-1",
      stepKey,
      label: stepKey,
      status: stepKey === "verify" || stepKey === "persist_report"
        ? "pending"
        : "completed",
      attempt: stepKey === "verify" || stepKey === "persist_report" ? 0 : 1,
      maxAttempts: 3,
      input: {},
      output: stepKey === "plan"
        ? {
            id: "plan-old",
            planner: "deterministic",
            confidence: 0.8,
            validation: { isDag: true },
            contextTraceId: "trace-old",
            plan,
          }
        : stepKey === "execute"
          ? {
              response: "A report was produced.",
              planExecution: {
                status: "completed",
                totalNodes: 3,
                completedNodes: 3,
                blockedNodes: 0,
                failedNodes: 0,
                skippedNodes: 0,
                waitingApprovalNodes: 0,
                toolExecutions: 0,
                dryRunTools: 0,
                executedTools: 0,
              },
            }
          : {},
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    })),
    events: [],
  };
}

function workflowNode(id: string, dependsOn: string[]) {
  return {
    id,
    label: id,
    kind: id === "report" ? "report" as const : "research" as const,
    description: `Execute ${id}.`,
    dependsOn,
    toolIds: [],
    inputBindings: [],
    connectorTargets: [],
    riskLevel: 0 as const,
    approvalRequired: false,
    policy: "auto" as const,
    acceptanceCriteria: [`${id} is complete.`],
    expectedOutputs: [`${id} artifact`],
  };
}

function priorNodeExecutions() {
  return ["source", "synthesize", "report"].map((nodeId) => ({
    id: `execution-${nodeId}`,
    tenantId: "tenant-1",
    workflowRunId: "workflow-replan-1",
    planId: "plan-old",
    nodeId,
    nodeLabel: nodeId,
    nodeKind: nodeId === "report" ? "report" : "research",
    status: "completed",
    policy: "auto",
    riskLevel: 0,
    approvalRequired: false,
    toolExecutionIds: [],
    input: { schemaVersion: 1, nodeId },
    output: {
      nodeResult: {
        artifacts: [{ name: `${nodeId} artifact`, content: `${nodeId} result` }],
        acceptanceChecks: [{ criterion: `${nodeId} is complete.`, passed: true }],
      },
    },
    createdAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
  }));
}
