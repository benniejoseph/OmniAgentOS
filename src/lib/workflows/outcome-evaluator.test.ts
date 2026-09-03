import { describe, expect, it } from "vitest";
import {
  WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION,
  buildWorkflowOutcomeEvaluationV1,
  parseWorkflowOutcomeEvaluationV1,
  workflowOutcomeEventPayloadV1,
} from "@/lib/workflows/outcome-evaluator";
import type {
  WorkflowPlanNodeExecutionStatus,
  WorkflowRunDetail,
  WorkflowStepKey,
  WorkflowStepRecord,
} from "@/lib/workflows/types";

const NOW = "2026-09-03T10:00:00.000Z";
const RUN_ID = "00000000-0000-4000-8000-000000000001";
const PLAN_ID = "00000000-0000-4000-8000-000000000002";
const PRIVATE_GOAL = "Prepare the private quarterly launch brief.";
const PRIVATE_CRITERION = "Include the confidential launch decision.";
const PRIVATE_REPORT = "Confidential launch material must never enter event metadata.";

type FixtureOptions = {
  status?: "running" | "completed" | "waiting_approval" | "blocked" | "failed";
  sourceRunStatus?: WorkflowRunDetail["run"]["status"];
  nodeStatuses?: WorkflowPlanNodeExecutionStatus[];
  dryRun?: boolean;
  modelVerdict?: boolean;
  verificationPassed?: boolean;
  mechanicalVerificationPassed?: boolean;
  includePlan?: boolean;
  executionWorkflowRunId?: string;
  executionPlanId?: string;
};

function fixture(options: FixtureOptions = {}) {
  const status = options.status || "completed";
  const nodeStatuses = options.nodeStatuses || ["completed", "completed"];
  const dryRun = options.dryRun === true;
  const nodeExecutions = nodeStatuses.map((nodeStatus, index) => ({
    id: `node_execution_${index + 1}`,
    nodeId: `node_${index + 1}`,
    status: nodeStatus,
    output: {
      dryRunOnly: dryRun && index === 0,
      toolExecutions: index === 0 && nodeStatus !== "skipped"
        ? [{
            id: "tool_execution_1",
            toolId: "connector.example.write",
            status: nodeStatus === "waiting_approval"
              ? "approval_required"
              : nodeStatus === "blocked"
                ? "blocked"
                : nodeStatus === "failed"
                  ? "failed"
                  : dryRun
                    ? "dry_run"
                    : "executed",
            dryRun,
          }]
        : [],
    },
  }));
  const count = (nodeStatus: WorkflowPlanNodeExecutionStatus) =>
    nodeStatuses.filter((value) => value === nodeStatus).length;
  const toolExecutions = nodeExecutions.flatMap((node) =>
    node.output.toolExecutions
  );
  const planExecution = {
    workflowRunId: options.executionWorkflowRunId || RUN_ID,
    planId: options.executionPlanId || PLAN_ID,
    status,
    totalNodes: nodeStatuses.length,
    completedNodes: count("completed"),
    failedNodes: count("failed"),
    blockedNodes: count("blocked"),
    skippedNodes: count("skipped"),
    waitingApprovalNodes: count("waiting_approval"),
    toolExecutions: toolExecutions.length,
    dryRunTools: toolExecutions.filter((tool) => tool.dryRun).length,
    executedTools: toolExecutions.filter(
      (tool) => !tool.dryRun && tool.status === "executed",
    ).length,
    nodeExecutions,
  };
  const planOutput = options.includePlan === false
    ? undefined
    : {
        id: PLAN_ID,
        planner: "openai",
        plan: {
          acceptanceCriteria: [PRIVATE_CRITERION],
          nodes: nodeStatuses.map((_nodeStatus, index) => ({
            id: `node_${index + 1}`,
            policy: dryRun && index === 0 ? "dry_run" : "auto",
            acceptanceCriteria: index === 0
              ? ["Persist one reviewable artifact."]
              : [],
          })),
        },
      };
  const verifyOutput: Record<string, unknown> = {
    passed: options.verificationPassed ?? true,
    mechanicalPassed: options.mechanicalVerificationPassed ?? true,
  };
  if (options.modelVerdict !== false) {
    verifyOutput.modelVerdict = {
      passed: options.verificationPassed ?? true,
      score: 1,
      assessment: "private model assertion",
    };
  }

  const detail: WorkflowRunDetail = {
    run: {
      id: RUN_ID,
      tenantId: "tenant_test",
      workflowType: "agent_goal",
      status: options.sourceRunStatus || "running",
      goal: PRIVATE_GOAL,
      input: { goal: PRIVATE_GOAL, mode: "orchestrate" },
      attempt: 1,
      maxAttempts: 3,
      approvalRequired: false,
      createdAt: NOW,
      updatedAt: NOW,
    },
    steps: [
      workflowStep("plan", planOutput),
      workflowStep("execute", { response: "private execution output", planExecution }),
      workflowStep("verify", verifyOutput),
      workflowStep("persist_report", {
        report: PRIVATE_REPORT,
        memoryId: "workflow_memory_1",
        dynamicPlanId: PLAN_ID,
        planExecutionStatus: status,
      }),
    ],
    events: [],
  };
  const result: Record<string, unknown> = {
    report: PRIVATE_REPORT,
    memoryId: "workflow_memory_1",
    dynamicPlanId: options.includePlan === false ? undefined : PLAN_ID,
    planExecutionStatus: status,
  };
  return { detail, result };
}

function workflowStep(
  stepKey: WorkflowStepKey,
  output: Record<string, unknown> | undefined,
): WorkflowStepRecord {
  return {
    id: `step_${stepKey}`,
    workflowRunId: RUN_ID,
    stepKey,
    label: stepKey,
    status: "completed",
    attempt: 1,
    maxAttempts: 3,
    input: {},
    output,
    createdAt: NOW,
    updatedAt: NOW,
    completedAt: NOW,
  };
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .reverse()
      .map((key) => [key, reverseObjectKeys(record[key])]),
  );
}

describe("workflow outcome evaluator v1", () => {
  it("keeps a model-asserted legacy completion unverified", () => {
    const input = fixture();
    const evaluation = buildWorkflowOutcomeEvaluationV1(input);

    expect(evaluation.schemaVersion).toBe(
      WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION,
    );
    expect(evaluation.terminalReceipt.disposition).toBe("unverified");
    expect(evaluation.terminalReceipt.source).toBe("outcome_evaluator");
    expect(evaluation.terminalReceipt.legacyStatus).toBeNull();
    expect(evaluation.outcomeContractBindingState).toBe("posthoc");
    expect(evaluation.evidence.outcomeContractBindingState).toBe("posthoc");
    expect(evaluation.evidence.verificationEvidenceSource).toBe("model_assertion");
    expect(evaluation.outcomeContract.acceptanceCriteria).not.toHaveLength(0);
    expect(
      evaluation.outcomeContract.acceptanceCriteria.every(
        (criterion) => criterion.verificationMethod === "model_assertion",
      ),
    ).toBe(true);
    expect(evaluation.terminalReceipt.verifiedRequirementCount).toBe(0);
    expect(evaluation.terminalReceipt.artifactReceiptIds).toEqual([]);
    expect(JSON.stringify(evaluation)).not.toContain(PRIVATE_GOAL);
    expect(JSON.stringify(evaluation)).not.toContain(PRIVATE_CRITERION);
    expect(JSON.stringify(evaluation)).not.toContain(PRIVATE_REPORT);
    expect(parseWorkflowOutcomeEvaluationV1(evaluation, RUN_ID)).toEqual(
      evaluation,
    );
  });

  it.each([
    {
      name: "dry-run tool evidence",
      options: { dryRun: true },
    },
    {
      name: "a skipped plan node",
      options: {
        nodeStatuses: ["completed", "skipped"] as WorkflowPlanNodeExecutionStatus[],
      },
    },
  ])("reports $name as honest partial work", ({ options }) => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture(options));

    expect(evaluation.terminalReceipt.disposition).toBe("partial");
    expect(evaluation.terminalReceipt.reasonCode).toBe("requirements_unmet");
    expect(evaluation.terminalReceipt.usefulWorkUnitCount).toBeGreaterThan(0);
  });

  it.each([
    {
      status: "blocked" as const,
      nodeStatuses: ["completed", "blocked"] as WorkflowPlanNodeExecutionStatus[],
      disposition: "blocked",
      evidenceIds: "blockingDependencyIds" as const,
    },
    {
      status: "waiting_approval" as const,
      nodeStatuses: ["completed", "waiting_approval"] as WorkflowPlanNodeExecutionStatus[],
      disposition: "waiting_approval",
      evidenceIds: "pendingApprovalIds" as const,
    },
  ])("preserves $status instead of claiming success", (testCase) => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture(testCase));

    expect(evaluation.terminalReceipt.disposition).toBe(testCase.disposition);
    expect(evaluation.terminalReceipt[testCase.evidenceIds].length).toBeGreaterThan(0);
  });

  it("reports failed execution evidence as failed", () => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture({
      status: "failed",
      nodeStatuses: ["completed", "failed"],
    }));

    expect(evaluation.terminalReceipt.disposition).toBe("failed");
    expect(evaluation.terminalReceipt.reasonCode).toBe("execution_failed");
  });

  it("keeps missing and unassessed workflow evidence unverified", () => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture({
      includePlan: false,
      modelVerdict: false,
    }));

    expect(evaluation.evidence.planBindingState).toBe("missing");
    expect(evaluation.evidence.verificationEvidenceSource).toBe("unassessed");
    expect(evaluation.terminalReceipt.disposition).toBe("unverified");
  });

  it.each([
    ["foreign workflow", {
      executionWorkflowRunId: "00000000-0000-4000-8000-000000000099",
    }],
    ["foreign plan", {
      executionPlanId: "00000000-0000-4000-8000-000000000099",
    }],
  ] as const)("fails closed for a same-status %s execution", (_name, options) => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture(options));

    expect(evaluation.evidence.planExecutionBindingState).toBe("mismatched");
    expect(evaluation.terminalReceipt.disposition).toBe("unverified");
  });

  it("fails closed when matching plan IDs have no plan object", () => {
    const input = fixture();
    const planStep = input.detail.steps.find((step) => step.stepKey === "plan");
    planStep!.output = { id: PLAN_ID };

    const evaluation = buildWorkflowOutcomeEvaluationV1(input);

    expect(evaluation.evidence.planBindingState).toBe("invalid");
    expect(evaluation.evidence.planSha256).toBeNull();
    expect(evaluation.terminalReceipt.disposition).toBe("unverified");
  });

  it.each([
    "queued",
    "waiting_approval",
    "paused",
    "completed",
    "failed",
    "canceled",
  ] as const)("rejects unsupported source status %s", (sourceRunStatus) => {
    expect(() => buildWorkflowOutcomeEvaluationV1(fixture({
      sourceRunStatus,
    }))).toThrow(/pre-completion running seam/i);
  });

  it("does not count bookkeeping, memory IDs, or all-skipped work as useful", () => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture({
      nodeStatuses: ["skipped", "skipped"],
    }));

    expect(evaluation.evidence.completedStepCount).toBeGreaterThan(0);
    expect(evaluation.evidence.memoryId).not.toBeNull();
    expect(evaluation.evidence.usefulWorkUnitCount).toBe(0);
    expect(evaluation.terminalReceipt.artifactReceiptIds).toEqual([]);
    expect(evaluation.terminalReceipt.disposition).toBe("unverified");
  });

  it("preserves a mechanical failure without upgrading unassessed requirements", () => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture({
      modelVerdict: false,
      verificationPassed: false,
      mechanicalVerificationPassed: false,
    }));

    expect(evaluation.evidence.verificationEvidenceSource).toBe("unassessed");
    expect(evaluation.terminalReceipt.requirementResults.every(
      (result) => result.state === "not_assessed",
    )).toBe(true);
    expect(evaluation.terminalReceipt.disposition).toBe("failed");
    expect(evaluation.terminalReceipt.reasonCode).toBe("execution_failed");
  });

  it("rejects digest tampering, cross-run reads, and unknown fields", () => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture());
    const tampered = structuredClone(evaluation);
    tampered.evidence.goalSha256 = "0".repeat(64);

    expect(() => parseWorkflowOutcomeEvaluationV1(tampered, RUN_ID)).toThrow();
    expect(() => parseWorkflowOutcomeEvaluationV1(
      evaluation,
      "00000000-0000-4000-8000-000000000099",
    )).toThrow(/different run/i);
    expect(() => parseWorkflowOutcomeEvaluationV1({
      ...evaluation,
      rawReport: PRIVATE_REPORT,
    })).toThrow();
    expect(parseWorkflowOutcomeEvaluationV1(undefined)).toBeUndefined();
  });

  it("survives recursive JSONB-style object-key reordering", () => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture());
    const reordered = reverseObjectKeys(evaluation);

    expect(parseWorkflowOutcomeEvaluationV1(reordered, RUN_ID)).toEqual(
      evaluation,
    );
  });

  it("builds compact event metadata without raw workflow content", () => {
    const evaluation = buildWorkflowOutcomeEvaluationV1(fixture());
    const payload = workflowOutcomeEventPayloadV1(evaluation);
    const serialized = JSON.stringify(payload);

    expect(payload.payloadKind).toBe("workflow_outcome_evaluation");
    expect(payload.workflowRunId).toBe(RUN_ID);
    expect(payload.evaluationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(serialized).not.toContain(PRIVATE_GOAL);
    expect(serialized).not.toContain(PRIVATE_CRITERION);
    expect(serialized).not.toContain(PRIVATE_REPORT);
  });
});
