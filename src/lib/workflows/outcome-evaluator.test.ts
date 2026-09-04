import { describe, expect, it } from "vitest";
import {
  WORKFLOW_OUTCOME_EVALUATION_SCHEMA_VERSION,
  buildWorkflowOutcomeEvaluationV1,
  parseWorkflowOutcomeEvaluationV1,
  workflowOutcomeEffectReceiptCandidateExecutionIds,
  workflowOutcomeEventPayloadV1,
} from "@/lib/workflows/outcome-evaluator";
import {
  buildEffectReceiptV1,
  canonicalJsonSha256,
  memoryEffectTargetIdV1,
  type BuildEffectReceiptV1Input,
  type EffectReceiptV1,
} from "@/lib/tools/effect-receipt";
import type { ToolExecutionRecord } from "@/lib/tools/types";
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
  const nodeExecutions = nodeStatuses.map((nodeStatus, index) => {
    const toolExecutions = index === 0 && nodeStatus !== "skipped"
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
      : [];
    return {
      id: `node_execution_${index + 1}`,
      workflowRunId: RUN_ID,
      planId: PLAN_ID,
      nodeId: `node_${index + 1}`,
      status: nodeStatus,
      toolExecutionIds: toolExecutions.map((tool) => tool.id),
      output: {
        dryRunOnly: dryRun && index === 0,
        toolExecutions,
      },
    };
  });
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

function attachVerifiedMemoryWriteReceipt(
  input: ReturnType<typeof fixture>,
  overrides: Partial<BuildEffectReceiptV1Input> = {},
  options: { authorizePlanTool?: boolean; planPolicy?: string } = {},
) {
  input.detail.run.approvedAt = NOW;
  const planStep = input.detail.steps.find((step) => step.stepKey === "plan");
  const executeStep = input.detail.steps.find(
    (step) => step.stepKey === "execute",
  );
  const planOutput = requiredRecord(planStep?.output);
  const plan = requiredRecord(planOutput.plan);
  const executeOutput = requiredRecord(executeStep?.output);
  const planExecution = requiredRecord(executeOutput.planExecution);
  const nodeExecution = requiredRecordArray(planExecution.nodeExecutions)[0];
  const planNode = requiredRecordArray(plan.nodes).find(
    (node) => node.id === nodeExecution.nodeId,
  );
  if (!planNode) {
    throw new Error("Expected the executed node in the workflow plan fixture.");
  }
  const nodeOutput = requiredRecord(nodeExecution.output);
  const toolExecution = requiredRecordArray(nodeOutput.toolExecutions)[0];
  const executionId = overrides.executionId || String(toolExecution.id);
  const tenantId = overrides.tenantId || input.detail.run.tenantId || "default";
  const workflowRunId = overrides.workflowRunId || input.detail.run.id;
  const planId = overrides.planId || String(planOutput.id);
  const planSha256 = overrides.planSha256 || canonicalJsonSha256({
    id: planOutput.id,
    plan,
  });
  const planNodeId = overrides.planNodeId || String(nodeExecution.nodeId);
  const authoritativeInput = {
    title: "private",
    content: "private",
  };
  const inputSha256 = overrides.inputSha256 ||
    canonicalJsonSha256(authoritativeInput);
  const idempotencyDigest = overrides.idempotencyKeySha256 ||
    canonicalJsonSha256({
      tenantId: input.detail.run.tenantId,
      idempotencyKey: "private",
    });
  const targetId = overrides.targetId || memoryEffectTargetIdV1({
    tenantId,
    executionId,
    workflowRunId,
    planId,
    planSha256,
    planNodeId,
    inputSha256,
    idempotencyKeySha256: idempotencyDigest,
  });
  const targetStateSha256 = canonicalJsonSha256({
    id: targetId,
    tenantId: input.detail.run.tenantId,
    claimStatus: "active",
  });

  Object.assign(toolExecution, {
    toolId: "memory.write",
    status: "executed",
    dryRun: false,
  });
  planNode.toolIds = options.authorizePlanTool === false
    ? []
    : ["memory.write"];
  if (options.planPolicy !== undefined) {
    planNode.policy = options.planPolicy;
  }
  const receipt = buildEffectReceiptV1({
    effectMode: "live",
    reversible: true,
    executionId,
    tenantId,
    actorId: "actor_effect_test",
    executingPrincipalType: "system",
    executingPrincipalId:
      overrides.executingPrincipalId || `workflow:${workflowRunId}`,
    workflowRunId,
    planId,
    planSha256,
    planNodeId,
    toolId: "memory.write",
    toolContractSha256: canonicalJsonSha256({
      id: "memory.write",
      riskLevel: 1,
      reversible: true,
    }),
    inputSha256,
    idempotencyKeySha256: idempotencyDigest,
    targetType: "memory",
    targetId,
    providerAcknowledgement: "first_party_store_commit",
    providerAcknowledgementId: targetId,
    providerAcknowledgementSha256: canonicalJsonSha256({
      provider: "first_party_memory_store",
      targetId,
    }),
    verificationMethod: "read_after_write",
    verificationState: "verified",
    verificationReasonCode: "state_matched",
    expectedTargetStateSha256: targetStateSha256,
    observedTargetStateSha256: targetStateSha256,
    ...overrides,
  });
  const authoritativeRecord: ToolExecutionRecord = {
    id: receipt.executionId,
    tenantId: receipt.tenantId,
    actorId: receipt.actorId,
    toolId: "memory.write",
    toolName: "Write memory",
    riskLevel: 1,
    status: "executed",
    dryRun: false,
    approvalRequired: false,
    input: authoritativeInput,
    effectReceipt: receipt,
    approvalDecision: "approved",
    approvedBy: receipt.actorId,
    approvedAt: NOW,
    createdAt: NOW,
    completedAt: NOW,
  };
  return {
    authoritativeRecord,
    nodeExecution,
    plan,
    planNode,
    receipt,
    toolExecution,
  };
}

function evaluateWithAuthority(
  input: ReturnType<typeof fixture>,
  authoritativeToolExecutions: readonly ToolExecutionRecord[],
) {
  return buildWorkflowOutcomeEvaluationV1({
    ...input,
    authoritativeToolExecutions,
  });
}

function rebuildEffectReceipt(
  receipt: EffectReceiptV1,
  overrides: Partial<BuildEffectReceiptV1Input>,
) {
  const {
    schemaVersion,
    receiptKind,
    effectReceiptId,
    receiptSha256,
    ...input
  } = receipt;
  void schemaVersion;
  void receiptKind;
  void effectReceiptId;
  void receiptSha256;
  return buildEffectReceiptV1({ ...input, ...overrides });
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a record in the workflow fixture.");
  }
  return value as Record<string, unknown>;
}

function requiredRecordArray(value: unknown) {
  if (!Array.isArray(value)) {
    throw new Error("Expected a record array in the workflow fixture.");
  }
  return value.map(requiredRecord);
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

  it("projects a strictly bound verified memory-write receipt without upgrading the post-hoc outcome", () => {
    const input = fixture();
    const { authoritativeRecord, receipt } =
      attachVerifiedMemoryWriteReceipt(input);
    const evaluation = evaluateWithAuthority(input, [authoritativeRecord]);

    expect(workflowOutcomeEffectReceiptCandidateExecutionIds(input.detail))
      .toEqual([receipt.executionId]);
    expect(evaluation.evidence.effectReceiptIds).toEqual([
      receipt.effectReceiptId,
    ]);
    expect(evaluation.terminalReceipt.effectReceiptIds).toEqual([
      receipt.effectReceiptId,
    ]);
    expect(evaluation.outcomeContract.effectRequirements).toEqual([]);
    expect(evaluation.outcomeContractBindingState).toBe("posthoc");
    expect(evaluation.evidence.verificationEvidenceSource).toBe(
      "model_assertion",
    );
    expect(evaluation.terminalReceipt.disposition).toBe("unverified");
    expect(workflowOutcomeEventPayloadV1(evaluation).effectReceiptCount).toBe(1);
  });

  it("requires one matching authoritative tenant-scoped tool record", () => {
    const input = fixture();
    const { authoritativeRecord, receipt } =
      attachVerifiedMemoryWriteReceipt(input);
    const crossActorReceipt = rebuildEffectReceipt(receipt, {
      actorId: "actor_other",
    });
    const mismatchedRecords: ToolExecutionRecord[] = [
      { ...authoritativeRecord, id: "tool_execution_other" },
      { ...authoritativeRecord, toolId: "knowledge.ingest" },
      { ...authoritativeRecord, status: "dry_run" },
      { ...authoritativeRecord, dryRun: true },
      { ...authoritativeRecord, tenantId: undefined },
      { ...authoritativeRecord, tenantId: "tenant_other" },
      { ...authoritativeRecord, actorId: undefined },
      { ...authoritativeRecord, actorId: "actor_other" },
      { ...authoritativeRecord, effectReceipt: undefined },
      { ...authoritativeRecord, effectReceipt: crossActorReceipt },
    ];

    expect(buildWorkflowOutcomeEvaluationV1(input).evidence.effectReceiptIds)
      .toEqual([]);
    for (const authoritativeMismatch of mismatchedRecords) {
      expect(
        evaluateWithAuthority(input, [authoritativeMismatch]).evidence
          .effectReceiptIds,
      ).toEqual([]);
    }
    expect(
      evaluateWithAuthority(input, [
        authoritativeRecord,
        structuredClone(authoritativeRecord),
      ]).evidence.effectReceiptIds,
    ).toEqual([]);
  });

  it.each([
    ["tool execution", { executionId: "tool_execution_other" }],
    ["workflow run", { workflowRunId: "workflow_run_other" }],
    ["plan", { planId: "plan_other" }],
    ["canonical plan digest", { planSha256: "0".repeat(64) }],
    ["plan node", { planNodeId: "node_2" }],
  ] as const)("rejects a receipt bound to a different %s", (_name, overrides) => {
    const input = fixture();
    const { authoritativeRecord } = attachVerifiedMemoryWriteReceipt(
      input,
      overrides,
    );

    const evaluation = evaluateWithAuthority(input, [authoritativeRecord]);

    expect(evaluation.evidence.effectReceiptIds).toEqual([]);
    expect(evaluation.terminalReceipt.effectReceiptIds).toEqual([]);
  });

  it("rejects failed, non-live, unapproved, or unscoped execution evidence", () => {
    const failedVerification = fixture();
    const failedAttachment = attachVerifiedMemoryWriteReceipt(failedVerification, {
      verificationState: "failed",
      verificationReasonCode: "target_missing",
      observedTargetStateSha256: null,
    });
    const dryRunSummary = fixture();
    const dryRunAttachment = attachVerifiedMemoryWriteReceipt(dryRunSummary);
    const { toolExecution } = dryRunAttachment;
    toolExecution.dryRun = true;
    const unapprovedRun = fixture();
    const unapprovedAttachment = attachVerifiedMemoryWriteReceipt(unapprovedRun);
    unapprovedRun.detail.run.approvedAt = undefined;
    const unscopedRun = fixture();
    const unscopedAttachment = attachVerifiedMemoryWriteReceipt(unscopedRun);
    unscopedRun.detail.run.tenantId = undefined;

    expect(
      evaluateWithAuthority(failedVerification, [
        failedAttachment.authoritativeRecord,
      ]).evidence.effectReceiptIds,
    ).toEqual([]);
    expect(
      evaluateWithAuthority(dryRunSummary, [
        dryRunAttachment.authoritativeRecord,
      ]).evidence.effectReceiptIds,
    ).toEqual([]);
    expect(
      evaluateWithAuthority(unapprovedRun, [
        unapprovedAttachment.authoritativeRecord,
      ]).evidence.effectReceiptIds,
    ).toEqual([]);
    expect(
      evaluateWithAuthority(unscopedRun, [
        unscopedAttachment.authoritativeRecord,
      ]).evidence.effectReceiptIds,
    ).toEqual([]);
  });

  it("rejects receipts detached from the persisted node execution or its declared tool set", () => {
    const wrongNodeRun = fixture();
    const wrongNodeRunAttachment = attachVerifiedMemoryWriteReceipt(
      wrongNodeRun,
    );
    wrongNodeRunAttachment.nodeExecution.workflowRunId = "workflow_run_other";

    const wrongNodePlan = fixture();
    const wrongNodePlanAttachment = attachVerifiedMemoryWriteReceipt(
      wrongNodePlan,
    );
    wrongNodePlanAttachment.nodeExecution.planId = "plan_other";

    const unlinkedExecution = fixture();
    const unlinkedAttachment = attachVerifiedMemoryWriteReceipt(
      unlinkedExecution,
    );
    unlinkedAttachment.nodeExecution.toolExecutionIds = [];

    const undeclaredTool = fixture();
    const undeclaredAttachment = attachVerifiedMemoryWriteReceipt(undeclaredTool, {}, {
      authorizePlanTool: false,
    });

    const multiToolNode = fixture();
    const multiToolAttachment = attachVerifiedMemoryWriteReceipt(multiToolNode);
    multiToolAttachment.planNode.toolIds = [
      "memory.write",
      "knowledge.search",
    ];

    const unsupportedPolicy = fixture();
    const unsupportedAttachment = attachVerifiedMemoryWriteReceipt(unsupportedPolicy, {}, {
      planPolicy: "unknown",
    });

    for (const [input, authoritativeRecord] of [
      [wrongNodeRun, wrongNodeRunAttachment.authoritativeRecord],
      [wrongNodePlan, wrongNodePlanAttachment.authoritativeRecord],
      [unlinkedExecution, unlinkedAttachment.authoritativeRecord],
      [undeclaredTool, undeclaredAttachment.authoritativeRecord],
      [multiToolNode, multiToolAttachment.authoritativeRecord],
      [unsupportedPolicy, unsupportedAttachment.authoritativeRecord],
    ] as const) {
      expect(
        evaluateWithAuthority(input, [authoritativeRecord]).evidence
          .effectReceiptIds,
      ).toEqual([]);
    }
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
