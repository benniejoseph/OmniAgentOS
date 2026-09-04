import { WORKFLOW_EXECUTOR_TIMEOUT_MS } from "@/lib/config";
import { saveMemory } from "@/lib/memory/store";
import { generateModelStructured } from "@/lib/models/gateway";
import { embedTexts } from "@/lib/openai/client";
import { buildAgentInstructions } from "@/lib/orchestration/prompts";
import type { AgentRunRequest } from "@/lib/orchestration/types";
import { buildContextPack } from "@/lib/rag/context-engine";
import {
  resolveRuntimeModelAssignment,
  type RuntimeModelResolution,
} from "@/lib/settings/runtime-models";
import { appendThreadTurn } from "@/lib/threads/store";
import { getToolExecutionsByIds } from "@/lib/tools/audit-store";
import { EffectReceiptFinalizationError } from "@/lib/tools/executor";
import type { ToolExecutionRecord } from "@/lib/tools/types";
import {
  buildWorkflowSpecialistContext,
  inspectWorkflowSpecialistDependencies,
} from "@/lib/subagents/context";
import { executeDynamicWorkflowPlan, parseWorkflowPlanOutput } from "@/lib/workflows/executor";
import {
  buildWorkflowOutcomeEvaluationV1,
  workflowOutcomeEffectReceiptCandidateExecutionIds,
  workflowOutcomeEventPayloadV1,
} from "@/lib/workflows/outcome-evaluator";
import {
  buildDynamicWorkflowPlan,
  getWorkflowPlanById,
} from "@/lib/workflows/planner";
import {
  approveWorkflowRun,
  appendWorkflowEvent,
  getWorkflowRunExecutionAuthority,
  getWorkflowRunDetail,
  listRunnableWorkflowRuns,
  transitionWorkflowRun,
  updateWorkflowStep,
  updateWorkflowStepForRunFence,
  workflowStepDefinitions,
} from "@/lib/workflows/store";
import type {
  WorkflowRunDetail,
  WorkflowSignalType,
  WorkflowStepKey,
} from "@/lib/workflows/types";
import type { AiUsageOperation, AiUsageScope } from "@/lib/usage/types";

const TERMINAL_STATUSES = new Set(["completed", "failed", "canceled"]);

export class WorkflowNotFoundError extends Error {
  constructor() {
    super("Workflow run not found.");
    this.name = "WorkflowNotFoundError";
  }
}

export class WorkflowSignalConflictError extends Error {
  constructor(signal: WorkflowSignalType, status: string) {
    super(`Workflow cannot accept ${signal} while it is ${status}.`);
    this.name = "WorkflowSignalConflictError";
  }
}

export async function tickWorkflowRun(
  runId: string,
  options: { tenantId?: string; abortSignal?: AbortSignal } = {},
) {
  throwIfAborted(options.abortSignal);
  const detail = await getWorkflowRunDetail(runId, { tenantId: options.tenantId });
  if (!detail) {
    throw new Error("Workflow run not found.");
  }

  if (TERMINAL_STATUSES.has(detail.run.status)) {
    return detail;
  }

  if (
    detail.run.input.executionAuthorityRequired &&
    !(await getWorkflowRunExecutionAuthority(detail.run.id, {
      tenantId: detail.run.tenantId,
    }))
  ) {
    throw new Error("Workflow execution authority is missing.");
  }

  if (detail.run.status === "queued") {
    const specialistGate = await inspectWorkflowSpecialistDependencies(detail);
    if (specialistGate.state === "pending") {
      await appendWorkflowEvent(detail.run.id, "workflow.specialists.pending", {
        taskIds: specialistGate.pendingTaskIds,
      });
      return detail;
    }
    if (specialistGate.state === "failed") {
      await transitionWorkflowRun(detail.run.id, ["queued"], {
        status: "failed",
        error: specialistGate.reason,
        completedAt: new Date().toISOString(),
      }, { tenantId: detail.run.tenantId });
      await appendWorkflowEvent(detail.run.id, "workflow.specialists.failed", {
        taskIds: specialistGate.failedTaskIds,
        reason: specialistGate.reason,
      });
      return getWorkflowRunDetail(runId, {
        tenantId: options.tenantId,
      }) as Promise<WorkflowRunDetail>;
    }
  }

  if (
    detail.run.status === "paused" ||
    detail.run.status === "waiting_approval" ||
    detail.run.status === "running"
  ) {
    await appendWorkflowEvent(detail.run.id, "workflow.tick.noop", { status: detail.run.status });
    return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
  }

  const stepKey = nextStepKey(detail);
  const claimedRun = await transitionWorkflowRun(detail.run.id, ["queued"], {
    status: "running",
    currentStep: stepKey,
    error: undefined,
  }, { tenantId: detail.run.tenantId });
  if (!claimedRun) {
    return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
  }
  let runFence = claimedRun.updatedAt;
  if (!stepKey) {
    await completeWorkflow(detail.run.id, detail.run.tenantId, runFence);
    return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
  }

  const claimedDetail = await getWorkflowRunDetail(runId, { tenantId: options.tenantId });
  const step = claimedDetail?.steps.find((item) => item.stepKey === stepKey);
  if (!step) {
    throw new Error(`Workflow step ${stepKey} is not registered.`);
  }

  const attempt = step.attempt + 1;
  const startedAt = new Date().toISOString();
  const startedStep = await updateWorkflowStepForRunFence(detail.run.id, stepKey, {
    status: "running",
    attempt,
    startedAt,
    error: undefined,
  }, {
    tenantId: detail.run.tenantId,
    expectedRunUpdatedAt: runFence,
  });
  if (!startedStep) {
    return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
  }
  await appendWorkflowEvent(detail.run.id, "step.started", { stepKey, attempt });

  try {
    throwIfAborted(options.abortSignal);
    if (stepKey === "approval_gate" && detail.run.approvalRequired && !detail.run.approvedAt) {
      const waitingStep = await updateWorkflowStepForRunFence(detail.run.id, stepKey, {
        status: "running",
        output: {
          waitingFor: "approval",
          reason: "Workflow requires human approval before execution.",
        },
      }, {
        tenantId: detail.run.tenantId,
        expectedRunUpdatedAt: runFence,
      });
      if (!waitingStep) {
        return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
      }
      await transitionWorkflowRun(detail.run.id, ["running"], {
        status: "waiting_approval",
        currentStep: stepKey,
        error: undefined,
      }, {
        tenantId: detail.run.tenantId,
        expectedUpdatedAt: runFence,
      });
      await appendWorkflowEvent(detail.run.id, "workflow.waiting_approval", { stepKey });
      return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
    }

    const freshDetail = await getWorkflowRunDetail(runId, { tenantId: options.tenantId });
    if (!freshDetail) {
      throw new Error("Workflow run disappeared during execution.");
    }
    const output = await executeStep(stepKey, freshDetail, options.abortSignal);
    throwIfAborted(options.abortSignal);
    if (
      stepKey === "execute" &&
      output &&
      typeof output === "object" &&
      "executionPending" in output &&
      output.executionPending === true
    ) {
      const pendingStep = await updateWorkflowStepForRunFence(
        detail.run.id,
        stepKey,
        {
          status: "pending",
          attempt: step.attempt,
          output,
          startedAt: undefined,
          completedAt: undefined,
          error: undefined,
        },
        {
          tenantId: detail.run.tenantId,
          expectedRunUpdatedAt: runFence,
        },
      );
      if (!pendingStep) {
        return getWorkflowRunDetail(runId, {
          tenantId: options.tenantId,
        }) as Promise<WorkflowRunDetail>;
      }
      const requeued = await transitionWorkflowRun(
        detail.run.id,
        ["running"],
        {
          status: "queued",
          currentStep: stepKey,
          error: undefined,
        },
        {
          tenantId: detail.run.tenantId,
          expectedUpdatedAt: runFence,
        },
      );
      if (requeued) {
        await appendWorkflowEvent(
          detail.run.id,
          "workflow.plan_execution.requeued",
          {
            stepKey,
            completedNodes:
              (output.planExecution as { completedNodes?: number } | undefined)
                ?.completedNodes || 0,
          },
        );
      }
      return getWorkflowRunDetail(runId, {
        tenantId: options.tenantId,
      }) as Promise<WorkflowRunDetail>;
    }
    const beforeCommit = await getWorkflowRunDetail(runId, { tenantId: options.tenantId });
    if (!beforeCommit) {
      throw new Error("Workflow run disappeared before step completion could be committed.");
    }
    if (beforeCommit.run.status !== "running") {
      return beforeCommit;
    }
    const completedStep = await updateWorkflowStepForRunFence(detail.run.id, stepKey, {
      status: "completed",
      output,
      completedAt: new Date().toISOString(),
    }, {
      tenantId: detail.run.tenantId,
      expectedRunUpdatedAt: runFence,
    });
    if (!completedStep) {
      return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
    }
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
        const revoked = await transitionWorkflowRun(detail.run.id, ["running"], {
          status: "running",
          approvedAt: undefined,
        }, {
          tenantId: detail.run.tenantId,
          expectedUpdatedAt: runFence,
        });
        if (!revoked) {
          return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
        }
        runFence = revoked.updatedAt;
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
    } else if (
      verifyOutput &&
      verifyOutput.passed === false &&
      hasReplanned(freshDetail)
    ) {
      const verdict = verifyOutput.modelVerdict as
        | { failures?: string[]; assessment?: string }
        | undefined;
      const failed = await transitionWorkflowRun(
        detail.run.id,
        ["running"],
        {
          status: "failed",
          currentStep: stepKey,
          error:
            verdict?.assessment ||
            "Workflow verification failed after the bounded replan.",
          completedAt: new Date().toISOString(),
        },
        {
          tenantId: detail.run.tenantId,
          expectedUpdatedAt: runFence,
        },
      );
      if (failed) {
        await appendWorkflowEvent(
          detail.run.id,
          "workflow.verification_failed",
          {
            failures: verdict?.failures || [],
            assessment:
              verdict?.assessment ||
              "Workflow verification failed after the bounded replan.",
            mechanicalPassed: verifyOutput.mechanicalPassed,
          },
        );
      }
      return getWorkflowRunDetail(runId, {
        tenantId: options.tenantId,
      }) as Promise<WorkflowRunDetail>;
    }

    const nextKey = nextStepKey(
      await getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as WorkflowRunDetail,
    );
    if (nextKey) {
      await transitionWorkflowRun(detail.run.id, ["running"], {
        status: "queued",
        currentStep: nextKey,
        error: undefined,
      }, {
        tenantId: detail.run.tenantId,
        expectedUpdatedAt: runFence,
      });
    } else {
      await completeWorkflow(detail.run.id, detail.run.tenantId, runFence);
    }
  } catch (error) {
    const current = await getWorkflowRunDetail(runId, { tenantId: options.tenantId });
    if (!current) {
      throw error;
    }
    if (isAbortError(error, options.abortSignal)) {
      if (current.run.status !== "running") {
        return current;
      }
      const resetStep = await updateWorkflowStepForRunFence(detail.run.id, stepKey, {
        status: "pending",
        attempt: step.attempt,
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
      }, {
        tenantId: detail.run.tenantId,
        expectedRunUpdatedAt: runFence,
      });
      if (!resetStep) {
        return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
      }
      const interrupted = await transitionWorkflowRun(detail.run.id, ["running"], {
        status: "queued",
        currentStep: stepKey,
        error: "Workflow execution was interrupted and safely requeued.",
      }, {
        tenantId: detail.run.tenantId,
        expectedUpdatedAt: runFence,
      });
      if (interrupted) {
        await appendWorkflowEvent(detail.run.id, "step.interrupted", { stepKey, attempt });
      }
      return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
    }
    if (error instanceof EffectReceiptFinalizationError) {
      if (current.run.status !== "running") {
        return current;
      }
      const resetStep = await updateWorkflowStepForRunFence(
        detail.run.id,
        stepKey,
        {
          status: "pending",
          attempt: step.attempt,
          startedAt: undefined,
          completedAt: undefined,
          error: undefined,
        },
        {
          tenantId: detail.run.tenantId,
          expectedRunUpdatedAt: runFence,
        },
      );
      if (!resetStep) {
        return getWorkflowRunDetail(runId, {
          tenantId: options.tenantId,
        }) as Promise<WorkflowRunDetail>;
      }
      const requeued = await transitionWorkflowRun(
        detail.run.id,
        ["running"],
        {
          status: "queued",
          currentStep: stepKey,
          error:
            "A governed effect is awaiting receipt reconciliation on its existing execution.",
        },
        {
          tenantId: detail.run.tenantId,
          expectedUpdatedAt: runFence,
        },
      );
      if (requeued) {
        await appendWorkflowEvent(
          detail.run.id,
          "workflow.effect_receipt.reconciliation_queued",
          { stepKey },
        );
      }
      return getWorkflowRunDetail(runId, {
        tenantId: options.tenantId,
      }) as Promise<WorkflowRunDetail>;
    }
    if (current.run.status !== "running") {
      return current;
    }
    const message = error instanceof Error ? error.message : "Workflow step failed.";
    const failedStep = await updateWorkflowStepForRunFence(detail.run.id, stepKey, {
      status: "failed",
      error: message,
      completedAt: new Date().toISOString(),
    }, {
      tenantId: detail.run.tenantId,
      expectedRunUpdatedAt: runFence,
    });
    if (!failedStep) {
      return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
    }
    await appendWorkflowEvent(detail.run.id, "step.failed", { stepKey, attempt, error: message });

    if (attempt < step.maxAttempts) {
      await transitionWorkflowRun(detail.run.id, ["running"], {
        status: "queued",
        currentStep: stepKey,
        attempt: current.run.attempt + 1,
        error: `Retry scheduled for ${stepKey}: ${message}`,
      }, {
        tenantId: detail.run.tenantId,
        expectedUpdatedAt: runFence,
      });
      await appendWorkflowEvent(detail.run.id, "step.retry_scheduled", { stepKey, nextAttempt: attempt + 1 });
    } else {
      await transitionWorkflowRun(detail.run.id, ["running"], {
        status: "failed",
        currentStep: stepKey,
        attempt: current.run.attempt + 1,
        error: message,
        completedAt: new Date().toISOString(),
      }, {
        tenantId: detail.run.tenantId,
        expectedUpdatedAt: runFence,
      });
    }
  }

  return getWorkflowRunDetail(runId, { tenantId: options.tenantId }) as Promise<WorkflowRunDetail>;
}

export async function tickQueuedWorkflows(limit = 5) {
  const candidates = await listRunnableWorkflowRuns(limit);
  const results = [];
  for (const run of candidates) {
    results.push(await tickWorkflowRun(run.id));
  }
  return results;
}

export async function signalWorkflowRun(
  runId: string,
  signal: WorkflowSignalType,
  options: {
    tenantId?: string;
    actorId?: string;
    reason?: string;
  } = {},
) {
  const detail = await getWorkflowRunDetail(runId, options);
  if (!detail) {
    throw new WorkflowNotFoundError();
  }

  if (
    signal === "approve" &&
    detail.run.approvedAt &&
    detail.run.status !== "canceled"
  ) {
    return detail;
  }

  if (TERMINAL_STATUSES.has(detail.run.status)) {
    if (signal === "cancel" && detail.run.status === "canceled") {
      return detail;
    }
    if (!(signal === "retry" && detail.run.status === "failed")) {
      throw new WorkflowSignalConflictError(signal, detail.run.status);
    }
  }
  const allowedStatuses: Record<WorkflowSignalType, WorkflowRunDetail["run"]["status"][]> = {
    pause: ["queued", "running"],
    resume: ["paused"],
    cancel: ["queued", "running", "paused", "waiting_approval"],
    approve: ["waiting_approval"],
    retry: ["failed"],
  };
  if (!allowedStatuses[signal].includes(detail.run.status)) {
    throw new WorkflowSignalConflictError(signal, detail.run.status);
  }

  const now = new Date().toISOString();

  if (signal === "pause") {
    const transitioned = await transitionWorkflowRun(runId, ["queued", "running"], {
      status: "paused",
      pausedAt: now,
    }, { tenantId: detail.run.tenantId });
    if (!transitioned) {
      throw new WorkflowSignalConflictError(signal, detail.run.status);
    }
    await appendWorkflowEvent(runId, "workflow.paused", {});
  }

  if (signal === "resume") {
    const transitioned = await transitionWorkflowRun(runId, ["paused"], {
      status: "queued",
      pausedAt: undefined,
      error: undefined,
      completedAt: undefined,
    }, { tenantId: detail.run.tenantId });
    if (!transitioned) {
      throw new WorkflowSignalConflictError(signal, detail.run.status);
    }
    await appendWorkflowEvent(runId, "workflow.resumed", {});
  }

  if (signal === "cancel") {
    const transitioned = await transitionWorkflowRun(
      runId,
      ["queued", "running", "paused", "waiting_approval"],
      { status: "canceled", canceledAt: now, completedAt: now },
      { tenantId: detail.run.tenantId },
    );
    if (!transitioned) {
      throw new WorkflowSignalConflictError(signal, detail.run.status);
    }
    await appendWorkflowEvent(runId, "workflow.canceled", {
      actorId: options.actorId,
      reason: options.reason,
    });
  }

  if (signal === "approve") {
    const transitioned = await approveWorkflowRun(runId, {
      tenantId: detail.run.tenantId,
      approvedAt: now,
    });
    if (!transitioned) {
      const latest = await getWorkflowRunDetail(runId, {
        tenantId: detail.run.tenantId,
      });
      if (latest?.run.approvedAt && latest.run.status !== "canceled") {
        return latest;
      }
      throw new WorkflowSignalConflictError(signal, detail.run.status);
    }
    await appendWorkflowEvent(runId, "workflow.approved", {
      actorId: options.actorId,
      reason: options.reason,
    });
  }

  if (signal === "retry") {
    const failedStep = detail.steps.find((step) => step.status === "failed");
    const transitioned = await transitionWorkflowRun(runId, ["failed"], {
      status: "queued",
      currentStep: failedStep?.stepKey || detail.run.currentStep || "preflight",
      error: undefined,
      completedAt: undefined,
    }, { tenantId: detail.run.tenantId });
    if (!transitioned) {
      throw new WorkflowSignalConflictError(signal, detail.run.status);
    }
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

async function executeStep(
  stepKey: WorkflowStepKey,
  detail: WorkflowRunDetail,
  abortSignal?: AbortSignal,
) {
  throwIfAborted(abortSignal);
  if (stepKey === "preflight") {
    const runtimeModel = await resolveWorkflowRuntimeModel(detail);
    return {
      workflowType: detail.run.workflowType,
      model: runtimeModel.configured
        ? `${runtimeModel.provider}/${runtimeModel.model}`
        : "fallback",
      modelRoutingSource: runtimeModel.source,
      modelRoutingWarnings: runtimeModel.warnings,
      storage: "durable ledger ready",
      approvalRequired: detail.run.approvalRequired,
    };
  }

  if (stepKey === "retrieve_context") {
    const profile = workflowAgentProfile(detail);
    const specialistContext = await buildWorkflowSpecialistContext(detail);
    if (profile?.memoryScope === "session") {
      return {
        contextCount: specialistContext.count,
        memoryCount: 0,
        knowledgeCount: 0,
        graphCount: 0,
        specialistCount: specialistContext.count,
        mode: "session",
        intent: "owner_configured",
        evidence: specialistContext.evidence,
        contextBlock: specialistContext.contextBlock,
      };
    }
    const contextSelection = workflowContextSelection(detail);
    const usageScope = await workflowUsageScope(
      detail,
      "embedding",
      "workflow.context.retrieve",
    );
    const retrieval = await buildContextPack(contextSelection?.query || detail.run.goal, {
      limit: 6,
      tenantId: detail.run.tenantId,
      evidenceIds: contextSelection?.evidenceIds,
      ...(usageScope ? { usageScope } : {}),
    });
    return {
      contextCount: retrieval.results.length + specialistContext.count,
      memoryCount: retrieval.memoryResults.length,
      knowledgeCount: retrieval.knowledgeResults.length,
      graphCount: retrieval.graphResults.length,
      specialistCount: specialistContext.count,
      mode: retrieval.profile.mode,
      intent: retrieval.profile.intent,
      traceId: retrieval.trace?.id,
      evidence: [
        ...specialistContext.evidence,
        ...retrieval.results.map((item) => ({
          id: item.id,
          kind: item.kind,
          title: item.title,
          confidence: item.confidence,
          utilityScore: item.utilityScore,
        })),
      ],
      contextBlock: [
        retrieval.contextBlock.slice(0, 8_000),
        specialistContext.contextBlock,
      ].filter(Boolean).join("\n\n").slice(0, 20_000),
    };
  }

  if (stepKey === "plan") {
    return buildPlan(detail, abortSignal);
  }

  if (stepKey === "approval_gate") {
    return {
      approvedAt: detail.run.approvedAt || new Date().toISOString(),
      approvalRequired: detail.run.approvalRequired,
    };
  }

  if (stepKey === "execute") {
    return executeGoal(detail, abortSignal);
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
      detail,
      runtimeModel: await resolveWorkflowRuntimeModel(detail),
      goal: detail.run.goal,
      criteria,
      executeOutput,
      planExecution,
      abortSignal,
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
    return persistWorkflowReport(detail, abortSignal);
  }

  throw new Error(`No workflow step registered for ${stepKey}.`);
}

function hasReplanned(detail: WorkflowRunDetail) {
  return detail.events.some((event) => event.type === "workflow.replan_triggered");
}

async function resolveWorkflowRuntimeModel(detail: WorkflowRunDetail) {
  const { actorId } = await workflowAttribution(detail);
  return resolveRuntimeModelAssignment({
    tenantId: detail.run.tenantId || "",
    actorId,
    scope: "orchestrator",
    tier: "reasoning",
    requiredFeature: "json_schema",
  });
}

async function workflowUsageScope(
  detail: WorkflowRunDetail,
  operation: AiUsageOperation,
  purpose: string,
  runtimeModel?: RuntimeModelResolution,
): Promise<AiUsageScope | undefined> {
  const { actorId, executionScope } = await workflowAttribution(detail);
  const tenantId = detail.run.tenantId?.trim();
  if (!tenantId || !actorId) return undefined;
  return {
    tenantId,
    actorId,
    sourceStreamId: `workflow:${detail.run.id}`,
    operation,
    purpose,
    correlationId: executionScope?.correlationId || detail.run.id,
    causationId: executionScope?.causationId || undefined,
    executionScope,
    assignmentId: runtimeModel?.assignmentId,
    credentialSource: runtimeModel?.source === "tenant_assignment"
      ? "tenant_vault" as const
      : "deployment_environment" as const,
  };
}

async function workflowAttribution(detail: WorkflowRunDetail) {
  const metadataActorId = typeof detail.run.input.metadata?.actorId === "string"
    ? detail.run.input.metadata.actorId.trim()
    : "";
  const authority = await getWorkflowRunExecutionAuthority(detail.run.id, {
    tenantId: detail.run.tenantId,
  });
  const executionScope = authority?.executionScope;
  const scopedActorId = executionScope?.initiatingActorId?.trim() || "";
  if (scopedActorId && metadataActorId && scopedActorId !== metadataActorId) {
    throw new Error(
      "Workflow usage metadata actor does not match its immutable execution scope.",
    );
  }
  const authorityActorId = scopedActorId ||
    (executionScope?.executingPrincipalType === "system"
      ? executionScope.executingPrincipalId?.trim() || "omniagent-system"
      : "");
  const actorId = authority
    ? authorityActorId
    : metadataActorId;
  return {
    actorId,
    executionScope,
  };
}

type ModelVerificationVerdict = {
  passed: boolean;
  score: number;
  failures: string[];
  assessment: string;
  error?: string;
};

async function verifyWithModel({
  detail,
  runtimeModel,
  goal,
  criteria,
  executeOutput,
  planExecution,
  abortSignal,
}: {
  detail: WorkflowRunDetail;
  runtimeModel: RuntimeModelResolution;
  goal: string;
  criteria: string[];
  executeOutput?: Record<string, unknown>;
  planExecution?: ReturnType<typeof parsePlanExecutionOutput>;
  abortSignal?: AbortSignal;
}): Promise<ModelVerificationVerdict | undefined> {
  if (!runtimeModel.configured) {
    return undefined;
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Verification timed out.")),
    WORKFLOW_EXECUTOR_TIMEOUT_MS,
  );
  try {
    const usageScope = await workflowUsageScope(
      detail,
      "structured_generation",
      "workflow.verify",
      runtimeModel,
    );
    const generated = await generateModelStructured(runtimeModel.bind({
      instructions:
        "You are a strict verification reviewer for an agent workflow. Judge ONLY from the evidence provided whether the acceptance criteria are satisfied. Dry-run or approval-pending tool results do not satisfy criteria that require real side effects. Be conservative: if evidence is missing or ambiguous, fail that criterion.",
      input: [
        `Goal: ${goal}`,
        `Acceptance criteria:\n${criteria.map((item) => `- ${item}`).join("\n")}`,
        `<untrusted_execution_evidence provenance="workflow_tool_outputs">\n${escapeUntrustedPromptText(JSON.stringify(executeOutput || {}, null, 2).slice(0, 6000))}\n</untrusted_execution_evidence>`,
        `<untrusted_plan_summary provenance="workflow_state">\n${escapeUntrustedPromptText(JSON.stringify(planExecution || {}, null, 2).slice(0, 3000))}\n</untrusted_plan_summary>`,
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
      abortSignal: combineAbortSignals(controller.signal, abortSignal),
      tier: "reasoning",
      ...(usageScope ? { usageScope } : {}),
    }));
    const parsed = JSON.parse(generated.text) as ModelVerificationVerdict;
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

async function buildPlan(detail: WorkflowRunDetail, abortSignal?: AbortSignal) {
  const profile = workflowAgentProfile(detail);
  const contextSelection = workflowContextSelection(detail);
  const retrieveOutput = stepOutput(detail, "retrieve_context");
  const replanEvent = [...detail.events]
    .reverse()
    .find((event) => event.type === "workflow.replan_triggered");
  const replanFeedback = replanEvent
    ? `\n\nIMPORTANT: a previous plan for this goal failed verification. Address these failures in the new plan:\n${JSON.stringify(replanEvent.payload || {}, null, 2).slice(0, 2000)}`
    : "";
  const selectedPlan =
    !replanEvent && detail.run.input.planId
      ? await getWorkflowPlanById(detail.run.input.planId, {
          tenantId: detail.run.tenantId,
        })
      : undefined;
  const usageAttribution = await workflowUsageScope(
    detail,
    "structured_generation",
    "workflow.plan",
  );
  if (
    detail.run.input.planId &&
    !replanEvent &&
    (
      !selectedPlan ||
      selectedPlan.status !== "planned" ||
      selectedPlan.workflowRunId !== detail.run.id ||
      selectedPlan.goal.trim() !== detail.run.goal.trim() ||
      selectedPlan.plan.mode !== (detail.run.input.mode || "orchestrate")
    )
  ) {
    throw new Error(
      "The reviewed workflow plan is missing or no longer matches this run.",
    );
  }
  const record =
    selectedPlan ||
    await buildDynamicWorkflowPlan({
      tenantId: detail.run.tenantId,
      actorId: typeof detail.run.input.metadata?.actorId === "string"
        ? detail.run.input.metadata.actorId
        : usageAttribution?.actorId,
      ...(usageAttribution ? {
        usageAttribution: {
          actorId: usageAttribution.actorId,
          executionScope: usageAttribution.executionScope,
          correlationId: usageAttribution.correlationId,
          causationId: usageAttribution.causationId,
        },
      } : {}),
      goal: detail.run.goal,
      mode: detail.run.input.mode || "orchestrate",
      workflowRunId: detail.run.id,
      requireApproval: detail.run.approvalRequired,
      contextSelection,
      allowedToolIds: profile ? [...new Set([...profile.toolIds, ...profile.skills.flatMap((skill) => skill.toolIds)])] : undefined,
      readOnlyTools: profile ? profile.approvalPolicy === "read_only" || profile.autonomy === "assist" : undefined,
      agentInstructions: [
        profile ? [profile.instructions, ...profile.skills.map((skill) => `${skill.name}: ${skill.instructions}`)].join("\n\n") : "",
        replanFeedback.trim(),
      ].filter(Boolean).join("\n\n") || undefined,
      reuseExisting: !replanEvent,
      abortSignal,
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

async function executeGoal(detail: WorkflowRunDetail, abortSignal?: AbortSignal) {
  const retrieveOutput = stepOutput(detail, "retrieve_context");
  const planOutput = stepOutput(detail, "plan");
  const planExecution = await executeDynamicWorkflowPlan(detail, { abortSignal });
  if (planExecution?.status === "running") {
    return {
      executionPending: true,
      deliverable: "Workflow plan execution is continuing in resumable queue deliveries.",
      response: `${planExecution.completedNodes} of ${planExecution.totalNodes} plan nodes are complete.`,
      nextAction: "Continue processing the next DAG-ready plan nodes.",
      planExecution,
    };
  }
  const fallback = buildExecutionFallback(detail, planExecution);
  const instructions = buildAgentInstructions({
    mode: detail.run.input.mode || "orchestrate",
    agentId: typeof detail.run.input.metadata?.primaryAgentId === "string" ? detail.run.input.metadata.primaryAgentId : undefined,
    profile: workflowAgentProfile(detail),
  });
  const input = [
    `Goal: ${detail.run.goal}`,
    `<untrusted_retrieved_context provenance="memory_and_rag">\n${escapeUntrustedPromptText(String(retrieveOutput?.contextBlock || "No context available."))}\n</untrusted_retrieved_context>`,
    `<untrusted_plan_data provenance="planner_output">\n${escapeUntrustedPromptText(JSON.stringify(planOutput || {}, null, 2))}\n</untrusted_plan_data>`,
    `<untrusted_execution_data provenance="tool_results">\n${escapeUntrustedPromptText(JSON.stringify(planExecution || {}, null, 2))}\n</untrusted_execution_data>`,
    "Return a concise execution result and next best action.",
  ].join("\n\n");

  const runtimeModel = await resolveWorkflowRuntimeModel(detail);
  if (!runtimeModel.configured) {
    return fallback;
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Workflow executor synthesis timed out.")),
      WORKFLOW_EXECUTOR_TIMEOUT_MS,
    );
    const usageScope = await workflowUsageScope(
      detail,
      "structured_generation",
      "workflow.synthesize",
      runtimeModel,
    );
    const generated = await generateModelStructured(runtimeModel.bind({
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
      abortSignal: combineAbortSignals(controller.signal, abortSignal),
      tier: "reasoning",
      ...(usageScope ? { usageScope } : {}),
    })).finally(() => clearTimeout(timer));

    return {
      ...JSON.parse(generated.text) as Record<string, unknown>,
      planExecution,
      synthesisProvider: generated.provider,
      synthesisModel: generated.model,
    };
  } catch (error) {
    return {
      ...fallback,
      synthesisModel: "fallback-after-model-error",
      synthesisError: error instanceof Error ? error.message : "Workflow executor synthesis failed.",
    };
  }
}

async function persistWorkflowReport(detail: WorkflowRunDetail, abortSignal?: AbortSignal) {
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
  let embedding: number[] | undefined;
  try {
    const usageScope = await workflowUsageScope(
      detail,
      "embedding",
      "workflow.report.embedding",
    );
    embedding = (await embedTexts([content], abortSignal, usageScope))?.[0];
  } catch (error) {
    if (abortSignal?.aborted) {
      throw abortSignal.reason || error;
    }
    // A workflow report remains durable and lexically searchable even when
    // the optional embedding provider is temporarily unavailable.
  }
  const threadId = detail.run.input.metadata?.threadId;
  const memory = await saveMemory({
    id: `workflow_report_${detail.run.id}`,
    tenantId: detail.run.tenantId,
    type: "episode",
    title: `Workflow report: ${detail.run.goal.slice(0, 72)}`,
    content,
    tags: ["workflow", "durable", detail.run.workflowType],
    source: "workflow",
    importance: 0.7,
    evidenceRefs: [
      `workflow:${detail.run.id}`,
      ...(typeof threadId === "string" && threadId.trim()
        ? [`thread:${threadId.trim()}`]
        : []),
    ],
    embedding,
  });

  return {
    report: content,
    memoryId: memory.id,
    dynamicPlanId: plan?.id,
    planExecutionStatus: planExecution?.status,
  };
}

async function completeWorkflow(
  runId: string,
  tenantId?: string,
  expectedUpdatedAt?: string,
) {
  const detail = await getWorkflowRunDetail(runId, { tenantId });
  const reportOutput = detail ? stepOutput(detail, "persist_report") : undefined;
  const result: Record<string, unknown> = {
    report: reportOutput?.report || "Workflow completed.",
    memoryId: reportOutput?.memoryId,
    dynamicPlanId: reportOutput?.dynamicPlanId,
    planExecutionStatus: reportOutput?.planExecutionStatus,
  };
  let outcomeEventPayload: Record<string, unknown> | undefined;
  if (detail) {
    let authoritativeToolExecutions: ToolExecutionRecord[] = [];
    const effectReceiptCandidateIds =
      workflowOutcomeEffectReceiptCandidateExecutionIds(detail);
    if (detail.run.tenantId && effectReceiptCandidateIds.length) {
      try {
        authoritativeToolExecutions = await getToolExecutionsByIds(
          effectReceiptCandidateIds,
          { tenantId: detail.run.tenantId },
        );
      } catch {
        // Receipt authority is additive. Failure to load it cannot make an
        // embedded workflow summary count as effect evidence.
        console.error("Workflow effect receipt authority lookup failed.");
      }
    }
    try {
      const outcomeEvaluation = buildWorkflowOutcomeEvaluationV1({
        detail,
        result,
        authoritativeToolExecutions,
      });
      result.outcomeEvaluation = outcomeEvaluation;
      outcomeEventPayload = workflowOutcomeEventPayloadV1(outcomeEvaluation);
    } catch {
      // Outcome receipts are an additive shadow projection during P1.3. A
      // malformed evaluator result must not change the legacy state machine.
      console.error("Workflow outcome evaluation failed.");
    }
  }
  const completed = await transitionWorkflowRun(runId, ["running"], {
    status: "completed",
    currentStep: undefined,
    error: undefined,
    completedAt: new Date().toISOString(),
    result,
  }, { tenantId, expectedUpdatedAt });
  if (completed) {
    if (outcomeEventPayload) {
      try {
        await appendWorkflowEvent(
          runId,
          "workflow.outcome_evaluated",
          outcomeEventPayload,
        );
      } catch {
        // The validated receipt is already stored atomically with the legacy
        // completion record; event transactionalization belongs to P1.1.
        console.error("Workflow outcome event persistence failed.");
      }
    }
    await appendWorkflowEvent(runId, "workflow.completed", {});
    const threadId = detail?.run.input.metadata?.threadId;
    if (typeof threadId === "string" && threadId) {
      try {
        await appendThreadTurn({
          tenantId,
          threadId,
          role: "user",
          content: detail.run.goal,
        });
        await appendThreadTurn({
          tenantId,
          threadId,
          role: "assistant",
          content: String(reportOutput?.report || "Workflow completed."),
        });
      } catch (error) {
        console.error("Workflow thread result persistence failed.", error instanceof Error ? error.message : "Unknown persistence error.");
      }
    }
  }
}

function stepOutput(detail: WorkflowRunDetail, stepKey: WorkflowStepKey) {
  return detail.steps.find((step) => step.stepKey === stepKey)?.output;
}

function workflowAgentProfile(detail: WorkflowRunDetail): AgentRunRequest["agentProfile"] | undefined {
  const value = detail.run.input.metadata?.agentProfile;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const profile = value as Record<string, unknown>;
  const skills = Array.isArray(profile.skills) ? profile.skills : undefined;
  const validSkills = skills?.every((skill) => skill && typeof skill === "object" && !Array.isArray(skill)
    && typeof (skill as Record<string, unknown>).id === "string"
    && typeof (skill as Record<string, unknown>).name === "string"
    && typeof (skill as Record<string, unknown>).description === "string"
    && typeof (skill as Record<string, unknown>).instructions === "string"
    && Array.isArray((skill as Record<string, unknown>).toolIds));
  if (
    typeof profile.name !== "string" || typeof profile.role !== "string"
    || typeof profile.description !== "string" || typeof profile.instructions !== "string"
    || !["auto", "openai_fast", "openai_reasoning", "gemini_fast", "anthropic_fast", "anthropic_reasoning"].includes(String(profile.modelPolicy))
    || !["assist", "governed", "execute"].includes(String(profile.autonomy))
    || !["always", "risk_based", "read_only"].includes(String(profile.approvalPolicy))
    || !["session", "project", "all"].includes(String(profile.memoryScope))
    || !Array.isArray(profile.toolIds) || !validSkills
  ) return undefined;
  return profile as AgentRunRequest["agentProfile"];
}

function workflowContextSelection(detail: WorkflowRunDetail): AgentRunRequest["contextSelection"] | undefined {
  const value = detail.run.input.metadata?.contextSelection;
  if (value === undefined) return undefined;

  const noSavedContext = {
    query: detail.run.goal,
    evidenceIds: [],
  };
  if (!value || typeof value !== "object" || Array.isArray(value)) return noSavedContext;

  const selection = value as Record<string, unknown>;
  if (
    typeof selection.query !== "string"
    || !selection.query.trim()
    || selection.query.length > 4_000
    || !Array.isArray(selection.evidenceIds)
    || selection.evidenceIds.length > 24
  ) return noSavedContext;

  const evidenceIds = selection.evidenceIds.map((id) => typeof id === "string" ? id.trim() : "");
  if (
    evidenceIds.some((id) => id.length > 200 || !/^(?:memory|knowledge|graph):[^\s]+$/.test(id))
    || new Set(evidenceIds).size !== evidenceIds.length
    || !contextSelectionMatchesGoal(selection.query, detail.run.goal)
  ) return noSavedContext;

  return {
    query: selection.query.trim(),
    evidenceIds,
  };
}

function contextSelectionMatchesGoal(selectionQuery: string, goal: string) {
  const normalizedSelection = normalizeTaskQuery(selectionQuery);
  if (normalizedSelection === normalizeTaskQuery(goal)) return true;

  const marker = "Current instruction:";
  const markerIndex = goal.lastIndexOf(marker);
  return markerIndex >= 0
    && normalizedSelection === normalizeTaskQuery(goal.slice(markerIndex + marker.length));
}

function normalizeTaskQuery(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeUntrustedPromptText(value: string) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

function combineAbortSignals(primary: AbortSignal, secondary?: AbortSignal) {
  return secondary ? AbortSignal.any([primary, secondary]) : primary;
}

function throwIfAborted(signal?: AbortSignal) {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException("Workflow execution was aborted.", "AbortError");
}

function isAbortError(error: unknown, signal?: AbortSignal) {
  return Boolean(
    signal?.aborted ||
    (error && typeof error === "object" && "name" in error && error.name === "AbortError"),
  );
}
