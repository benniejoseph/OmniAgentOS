import { AGENT_MODEL, WORKFLOW_EXECUTOR_TIMEOUT_MS, hasOpenAIKey } from "@/lib/config";
import { saveMemory } from "@/lib/memory/store";
import { createStructuredResponse, embedTexts } from "@/lib/openai/client";
import { buildAgentInstructions } from "@/lib/orchestration/prompts";
import { buildContextPack } from "@/lib/rag/context-engine";
import { executeDynamicWorkflowPlan, parseWorkflowPlanOutput } from "@/lib/workflows/executor";
import { buildDynamicWorkflowPlan } from "@/lib/workflows/planner";
import {
  appendWorkflowEvent,
  getWorkflowRunDetail,
  getWorkflowStep,
  listWorkflowRuns,
  setWorkflowRunStatus,
  updateWorkflowRun,
  updateWorkflowStep,
  workflowStepDefinitions,
} from "@/lib/workflows/store";
import type {
  WorkflowRunDetail,
  WorkflowSignalType,
  WorkflowStepKey,
} from "@/lib/workflows/types";

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

export async function tickWorkflowRun(runId: string) {
  const detail = await getWorkflowRunDetail(runId);
  if (!detail) {
    throw new Error("Workflow run not found.");
  }

  if (TERMINAL_STATUSES.has(detail.run.status)) {
    return detail;
  }

  if (detail.run.status === "paused" || detail.run.status === "waiting_approval") {
    await appendWorkflowEvent(detail.run.id, "workflow.tick.noop", { status: detail.run.status });
    return getWorkflowRunDetail(runId) as Promise<WorkflowRunDetail>;
  }

  const stepKey = nextStepKey(detail);
  if (!stepKey) {
    await completeWorkflow(detail.run.id);
    return getWorkflowRunDetail(runId) as Promise<WorkflowRunDetail>;
  }

  await updateWorkflowRun(detail.run.id, {
    status: "running",
    currentStep: stepKey,
    attempt: detail.run.attempt + 1,
    error: undefined,
  });

  const step = await getWorkflowStep(detail.run.id, stepKey);
  if (!step) {
    throw new Error(`Workflow step ${stepKey} is not registered.`);
  }

  const attempt = step.attempt + 1;
  const startedAt = new Date().toISOString();
  await updateWorkflowStep(detail.run.id, stepKey, {
    status: "running",
    attempt,
    startedAt,
    error: undefined,
  });
  await appendWorkflowEvent(detail.run.id, "step.started", { stepKey, attempt });

  try {
    if (stepKey === "approval_gate" && detail.run.approvalRequired && !detail.run.approvedAt) {
      await updateWorkflowStep(detail.run.id, stepKey, {
        status: "running",
        output: {
          waitingFor: "approval",
          reason: "Workflow requires human approval before execution.",
        },
      });
      await setWorkflowRunStatus(detail.run.id, "waiting_approval", {
        currentStep: stepKey,
        error: undefined,
      });
      await appendWorkflowEvent(detail.run.id, "workflow.waiting_approval", { stepKey });
      return getWorkflowRunDetail(runId) as Promise<WorkflowRunDetail>;
    }

    const freshDetail = await getWorkflowRunDetail(runId);
    if (!freshDetail) {
      throw new Error("Workflow run disappeared during execution.");
    }
    const output = await executeStep(stepKey, freshDetail);
    await updateWorkflowStep(detail.run.id, stepKey, {
      status: "completed",
      output,
      completedAt: new Date().toISOString(),
    });
    await appendWorkflowEvent(detail.run.id, "step.completed", { stepKey, attempt });

    // Bounded replanning: one failed verification sends the workflow back to
    // planning with the failure evidence; a second failure stands.
    const verifyOutput = stepKey === "verify" ? (output as Record<string, unknown>) : undefined;
    if (verifyOutput && verifyOutput.passed === false && !hasReplanned(freshDetail)) {
      const verdict = verifyOutput.modelVerdict as { failures?: string[]; assessment?: string } | undefined;
      await appendWorkflowEvent(detail.run.id, "workflow.replan_triggered", {
        failures: verdict?.failures || [],
        assessment: verdict?.assessment || "Mechanical verification failed.",
        mechanicalPassed: verifyOutput.mechanicalPassed,
      });
      for (const resetKey of ["plan", "execute", "verify"] as const) {
        await updateWorkflowStep(detail.run.id, resetKey, {
          status: "pending",
          attempt: 0,
          output: undefined,
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
        });
      }

      // The human approved the OLD plan. A replanned workflow produces a new
      // plan the approver never saw, so the approval is revoked and the
      // approval gate re-opens before any side-effecting tool can execute.
      if (freshDetail.run.approvalRequired && freshDetail.run.approvedAt) {
        await updateWorkflowRun(detail.run.id, { approvedAt: undefined });
        await updateWorkflowStep(detail.run.id, "approval_gate", {
          status: "pending",
          attempt: 0,
          output: undefined,
          error: undefined,
          startedAt: undefined,
          completedAt: undefined,
        });
        await appendWorkflowEvent(detail.run.id, "workflow.approval_revoked_on_replan", {
          reason: "Replanning produced a new plan; prior approval applied to the old plan only.",
        });
      }
    }

    const nextKey = nextStepKey(await getWorkflowRunDetail(runId) as WorkflowRunDetail);
    if (nextKey) {
      await setWorkflowRunStatus(detail.run.id, "queued", { currentStep: nextKey, error: undefined });
    } else {
      await completeWorkflow(detail.run.id);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Workflow step failed.";
    await updateWorkflowStep(detail.run.id, stepKey, {
      status: "failed",
      error: message,
      completedAt: new Date().toISOString(),
    });
    await appendWorkflowEvent(detail.run.id, "step.failed", { stepKey, attempt, error: message });

    if (attempt < step.maxAttempts) {
      await setWorkflowRunStatus(detail.run.id, "queued", {
        currentStep: stepKey,
        error: `Retry scheduled for ${stepKey}: ${message}`,
      });
      await appendWorkflowEvent(detail.run.id, "step.retry_scheduled", { stepKey, nextAttempt: attempt + 1 });
    } else {
      await setWorkflowRunStatus(detail.run.id, "failed", {
        currentStep: stepKey,
        error: message,
      });
    }
  }

  return getWorkflowRunDetail(runId) as Promise<WorkflowRunDetail>;
}

export async function tickQueuedWorkflows(limit = 5) {
  const runs = await listWorkflowRuns(50);
  const candidates = runs
    .filter((run) => run.status === "queued" || run.status === "running")
    .slice(0, limit);
  const results = [];
  for (const run of candidates) {
    results.push(await tickWorkflowRun(run.id));
  }
  return results;
}

export async function signalWorkflowRun(
  runId: string,
  signal: WorkflowSignalType,
  options: { tenantId?: string } = {},
) {
  const detail = await getWorkflowRunDetail(runId, options);
  if (!detail) {
    throw new Error("Workflow run not found.");
  }

  if (TERMINAL_STATUSES.has(detail.run.status)) {
    return detail;
  }

  const now = new Date().toISOString();

  if (signal === "pause") {
    await setWorkflowRunStatus(runId, "paused", { pausedAt: now });
    await appendWorkflowEvent(runId, "workflow.paused", {});
  }

  if (signal === "resume") {
    await setWorkflowRunStatus(runId, "queued", { pausedAt: undefined, error: undefined });
    await appendWorkflowEvent(runId, "workflow.resumed", {});
  }

  if (signal === "cancel") {
    await setWorkflowRunStatus(runId, "canceled", { canceledAt: now });
    await appendWorkflowEvent(runId, "workflow.canceled", {});
  }

  if (signal === "approve") {
    await updateWorkflowRun(runId, {
      status: "queued",
      approvedAt: now,
      error: undefined,
      currentStep: detail.run.currentStep === "approval_gate" ? "execute" : detail.run.currentStep,
    });
    const approvalStep = detail.steps.find((step) => step.stepKey === "approval_gate");
    if (approvalStep && approvalStep.status !== "completed") {
      await updateWorkflowStep(runId, "approval_gate", {
        status: "completed",
        output: { approvedAt: now },
        completedAt: now,
      });
    }
    await appendWorkflowEvent(runId, "workflow.approved", {});
  }

  if (signal === "retry") {
    const failedStep = detail.steps.find((step) => step.status === "failed");
    await setWorkflowRunStatus(runId, "queued", {
      currentStep: failedStep?.stepKey || detail.run.currentStep || "preflight",
      error: undefined,
    });
    await appendWorkflowEvent(runId, "workflow.retry_requested", {
      stepKey: failedStep?.stepKey || detail.run.currentStep || "preflight",
    });
  }

  return getWorkflowRunDetail(runId, options) as Promise<WorkflowRunDetail>;
}

function nextStepKey(detail: WorkflowRunDetail): WorkflowStepKey | undefined {
  const current = detail.run.currentStep;
  if (current) {
    const currentStep = detail.steps.find((step) => step.stepKey === current);
    if (currentStep && currentStep.status !== "completed" && currentStep.status !== "skipped") {
      return current;
    }
  }

  return workflowStepDefinitions.find((definition) => {
    const step = detail.steps.find((item) => item.stepKey === definition.key);
    return step && step.status !== "completed" && step.status !== "skipped";
  })?.key;
}

async function executeStep(stepKey: WorkflowStepKey, detail: WorkflowRunDetail) {
  if (stepKey === "preflight") {
    return {
      workflowType: detail.run.workflowType,
      model: hasOpenAIKey() ? AGENT_MODEL : "fallback",
      storage: "durable ledger ready",
      approvalRequired: detail.run.approvalRequired,
    };
  }

  if (stepKey === "retrieve_context") {
    const retrieval = await buildContextPack(detail.run.goal, { limit: 6, tenantId: detail.run.tenantId });
    return {
      contextCount: retrieval.results.length,
      memoryCount: retrieval.memoryResults.length,
      knowledgeCount: retrieval.knowledgeResults.length,
      graphCount: retrieval.graphResults.length,
      mode: retrieval.profile.mode,
      intent: retrieval.profile.intent,
      traceId: retrieval.trace?.id,
      evidence: retrieval.results.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        confidence: item.confidence,
        utilityScore: item.utilityScore,
      })),
      contextBlock: retrieval.contextBlock.slice(0, 8000),
    };
  }

  if (stepKey === "plan") {
    return buildPlan(detail);
  }

  if (stepKey === "approval_gate") {
    return {
      approvedAt: detail.run.approvedAt || new Date().toISOString(),
      approvalRequired: detail.run.approvalRequired,
    };
  }

  if (stepKey === "execute") {
    return executeGoal(detail);
  }

  if (stepKey === "verify") {
    const executeOutput = stepOutput(detail, "execute");
    const planOutput = stepOutput(detail, "plan");
    const plan = parseWorkflowPlanOutput(planOutput);
    const planExecution = parsePlanExecutionOutput(executeOutput);
    const criteria = plan?.plan.acceptanceCriteria || [
      "workflow state persisted",
      "execution output captured",
      "report step can persist durable summary",
    ];
    const mechanicalPassed = Boolean(executeOutput?.response || executeOutput?.deliverable) &&
      (!planExecution || planExecution.failedNodes === 0);
    const modelVerdict = await verifyWithModel({
      goal: detail.run.goal,
      criteria,
      executeOutput,
      planExecution,
    });
    return {
      // The model can veto a mechanically-passing run, never rescue a failing one.
      passed: mechanicalPassed && (modelVerdict?.passed ?? true),
      mechanicalPassed,
      modelVerdict,
      checks: criteria,
      plannerValidation: plan?.validation,
      dynamicPlanId: plan?.id,
      planExecution: planExecution
        ? {
            status: planExecution.status,
            completedNodes: planExecution.completedNodes,
            totalNodes: planExecution.totalNodes,
            toolExecutions: planExecution.toolExecutions,
            dryRunTools: planExecution.dryRunTools,
            executedTools: planExecution.executedTools,
          }
        : undefined,
    };
  }

  if (stepKey === "persist_report") {
    return persistWorkflowReport(detail);
  }

  throw new Error(`No workflow step registered for ${stepKey}.`);
}

function hasReplanned(detail: WorkflowRunDetail) {
  return detail.events.some((event) => event.type === "workflow.replan_triggered");
}

type ModelVerificationVerdict = {
  passed: boolean;
  score: number;
  failures: string[];
  assessment: string;
  error?: string;
};

async function verifyWithModel({
  goal,
  criteria,
  executeOutput,
  planExecution,
}: {
  goal: string;
  criteria: string[];
  executeOutput?: Record<string, unknown>;
  planExecution?: ReturnType<typeof parsePlanExecutionOutput>;
}): Promise<ModelVerificationVerdict | undefined> {
  if (!hasOpenAIKey()) {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Verification timed out.")),
    WORKFLOW_EXECUTOR_TIMEOUT_MS,
  );
  try {
    const raw = await createStructuredResponse({
      instructions:
        "You are a strict verification reviewer for an agent workflow. Judge ONLY from the evidence provided whether the acceptance criteria are satisfied. Dry-run or approval-pending tool results do not satisfy criteria that require real side effects. Be conservative: if evidence is missing or ambiguous, fail that criterion.",
      input: [
        `Goal: ${goal}`,
        `Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}`,
        `Execution output: ${JSON.stringify(executeOutput || {}, null, 2).slice(0, 6000)}`,
        `Plan execution summary: ${JSON.stringify(planExecution || {}, null, 2).slice(0, 3000)}`,
      ].join("\n\n"),
      name: "workflow_verification",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["passed", "score", "failures", "assessment"],
        properties: {
          passed: { type: "boolean" },
          score: { type: "number", description: "0-1 confidence that the goal was met." },
          failures: { type: "array", items: { type: "string" }, description: "Criteria that are not satisfied and why." },
          assessment: { type: "string", description: "One-paragraph verdict." },
        },
      },
      abortSignal: controller.signal,
    });
    const parsed = JSON.parse(raw) as ModelVerificationVerdict;
    return {
      passed: Boolean(parsed.passed),
      score: Number(parsed.score) || 0,
      failures: Array.isArray(parsed.failures) ? parsed.failures.map(String).slice(0, 10) : [],
      assessment: String(parsed.assessment || ""),
    };
  } catch (error) {
    // Verification is part of the production evidence gate. If the model
    // verifier is unavailable, do not silently pass autonomous work.
    return {
      passed: false,
      score: 0,
      failures: ["Model verification unavailable; rerun verification before promoting this result."],
      assessment: "Model verification unavailable; mechanical checks only.",
      error: error instanceof Error ? error.message : "Verification failed.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function buildPlan(detail: WorkflowRunDetail) {
  const retrieveOutput = stepOutput(detail, "retrieve_context");
  const replanEvent = [...detail.events]
    .reverse()
    .find((event) => event.type === "workflow.replan_triggered");
  const replanFeedback = replanEvent
    ? `\n\nIMPORTANT: a previous plan for this goal failed verification. Address these failures in the new plan:\n${JSON.stringify(replanEvent.payload || {}, null, 2).slice(0, 2000)}`
    : "";
  const record = await buildDynamicWorkflowPlan({
    tenantId: detail.run.tenantId,
    goal: `${detail.run.goal}${replanFeedback}`,
    mode: detail.run.input.mode || "orchestrate",
    workflowRunId: detail.run.id,
    requireApproval: detail.run.approvalRequired,
    reuseExisting: !replanEvent,
  });
  await appendWorkflowEvent(detail.run.id, "workflow.dynamic_plan.created", {
    planId: record.id,
    planner: record.planner,
    nodeCount: record.plan.nodes.length,
    highestRiskLevel: record.highestRiskLevel,
    approvalRequired: record.approvalRequired,
  });
  return {
    id: record.id,
    planner: record.planner,
    model: record.model,
    status: record.status,
    contextTraceId: record.contextTraceId,
    validation: record.validation,
    highestRiskLevel: record.highestRiskLevel,
    approvalRequired: record.approvalRequired,
    confidence: record.confidence,
    plan: record.plan,
    objective: detail.run.goal,
    tasks: record.plan.nodes.map((node) => node.label),
    acceptanceCriteria: record.plan.acceptanceCriteria,
    selectedToolIds: record.plan.selectedToolIds,
    connectorTargets: record.plan.connectorTargets,
    contextCount: Number(retrieveOutput?.contextCount || 0),
  };
}

async function executeGoal(detail: WorkflowRunDetail) {
  const retrieveOutput = stepOutput(detail, "retrieve_context");
  const planOutput = stepOutput(detail, "plan");
  const planExecution = await executeDynamicWorkflowPlan(detail);
  const fallback = buildExecutionFallback(detail, planExecution);
  const instructions = buildAgentInstructions({
    mode: detail.run.input.mode || "orchestrate",
    memoryContext: String(retrieveOutput?.contextBlock || "No context available."),
    tools: [],
  });
  const input = [
    `Goal: ${detail.run.goal}`,
    `Plan: ${JSON.stringify(planOutput || {}, null, 2)}`,
    `Plan execution: ${JSON.stringify(planExecution || {}, null, 2)}`,
    "Return a concise execution result and next best action.",
  ].join("\n\n");

  if (!hasOpenAIKey()) {
    return fallback;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Workflow executor synthesis timed out.")),
      WORKFLOW_EXECUTOR_TIMEOUT_MS,
    );
    const response = await createStructuredResponse({
      instructions,
      input,
      name: "workflow_execution_result",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          deliverable: { type: "string" },
          response: { type: "string" },
          nextAction: { type: "string" },
        },
        required: ["deliverable", "response", "nextAction"],
      },
      abortSignal: controller.signal,
    }).finally(() => clearTimeout(timer));

    return {
      ...JSON.parse(response) as Record<string, unknown>,
      planExecution,
    };
  } catch (error) {
    return {
      ...fallback,
      synthesisModel: "fallback-after-openai-error",
      synthesisError: error instanceof Error ? error.message : "Workflow executor synthesis failed.",
    };
  }
}

async function persistWorkflowReport(detail: WorkflowRunDetail) {
  const executeOutput = stepOutput(detail, "execute");
  const verifyOutput = stepOutput(detail, "verify");
  const planOutput = stepOutput(detail, "plan");
  const plan = parseWorkflowPlanOutput(planOutput);
  const planExecution = parsePlanExecutionOutput(executeOutput);
  const content = [
    `Workflow: ${detail.run.workflowType}`,
    `Goal: ${detail.run.goal}`,
    `Status: completed`,
    plan ? `Dynamic plan: ${plan.id} (${plan.planner}, confidence ${plan.confidence.toFixed(2)})` : "",
    plan ? `Plan nodes: ${plan.plan.nodes.map((node) => node.label).join(" -> ")}` : "",
    plan ? `Selected tools: ${plan.plan.selectedToolIds.join(", ") || "none"}` : "",
    planExecution
      ? `Plan execution: ${planExecution.completedNodes}/${planExecution.totalNodes} nodes completed, ${planExecution.toolExecutions} governed tool decisions, ${planExecution.dryRunTools} dry-runs.`
      : "",
    `Execution: ${String(executeOutput?.response || executeOutput?.deliverable || "No execution output.")}`,
    `Verification: ${JSON.stringify(verifyOutput || {})}`,
  ].filter(Boolean).join("\n\n");
  const embedding = (await embedTexts([content]))?.[0];
  const memory = await saveMemory({
    tenantId: detail.run.tenantId,
    type: "episode",
    title: `Workflow report: ${detail.run.goal.slice(0, 72)}`,
    content,
    tags: ["workflow", "durable", detail.run.workflowType],
    source: "workflow",
    importance: 0.7,
    embedding,
  });

  return {
    report: content,
    memoryId: memory.id,
    dynamicPlanId: plan?.id,
    planExecutionStatus: planExecution?.status,
  };
}

async function completeWorkflow(runId: string) {
  const detail = await getWorkflowRunDetail(runId);
  const reportOutput = detail ? stepOutput(detail, "persist_report") : undefined;
  await setWorkflowRunStatus(runId, "completed", {
    currentStep: undefined,
    error: undefined,
    result: {
      report: reportOutput?.report || "Workflow completed.",
      memoryId: reportOutput?.memoryId,
      dynamicPlanId: reportOutput?.dynamicPlanId,
      planExecutionStatus: reportOutput?.planExecutionStatus,
    },
  });
  await appendWorkflowEvent(runId, "workflow.completed", {});
}

function stepOutput(detail: WorkflowRunDetail, stepKey: WorkflowStepKey) {
  return detail.steps.find((step) => step.stepKey === stepKey)?.output;
}

function buildExecutionFallback(detail: WorkflowRunDetail, planExecution: Awaited<ReturnType<typeof executeDynamicWorkflowPlan>>) {
  return {
    deliverable: `Workflow executed ${planExecution ? `${planExecution.completedNodes}/${planExecution.totalNodes} planned nodes` : "with no dynamic plan"} for: ${detail.run.goal}`,
    response: planExecution
      ? [
          `Executed dynamic plan ${planExecution.planId} with status ${planExecution.status}.`,
          `${planExecution.completedNodes}/${planExecution.totalNodes} nodes completed.`,
          `${planExecution.toolExecutions} governed tool decisions were recorded (${planExecution.dryRunTools} dry-runs, ${planExecution.executedTools} live executions).`,
        ].join(" ")
      : "No dynamic plan execution was available, so the durable workflow produced a deterministic fallback output.",
    nextAction: planExecution?.status === "completed"
      ? "Review verification output and persisted report."
      : "Review blocked, failed, or approval-required plan nodes before retrying.",
    planExecution,
  };
}

function parsePlanExecutionOutput(output: Record<string, unknown> | undefined) {
  if (!output || typeof output !== "object" || !output.planExecution || typeof output.planExecution !== "object") {
    return undefined;
  }

  return output.planExecution as {
    status: string;
    totalNodes: number;
    completedNodes: number;
    blockedNodes: number;
    failedNodes: number;
    skippedNodes: number;
    waitingApprovalNodes: number;
    toolExecutions: number;
    dryRunTools: number;
    executedTools: number;
  };
}
