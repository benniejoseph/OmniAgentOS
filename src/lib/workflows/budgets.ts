import { createHash } from "node:crypto";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import type { ModelTextRequest } from "@/lib/models/types";
import {
  RUN_BUDGET_DIMENSIONS,
  RunBudgetExceededError,
  createRunBudgetState,
  refreshRunBudgetWallTime,
  remainingRunBudget,
  reserveRunBudget,
  runBudgetCountersV1Schema,
  type RunBudgetCountersV1,
  type RunBudgetStateV1,
} from "@/lib/runs/budgets";
import { appendWorkflowEvent } from "@/lib/workflows/store";
import type {
  WorkflowEventRecord,
  WorkflowRunDetail,
} from "@/lib/workflows/types";

type WorkflowBudgetReservationContext = {
  phase: string;
  nodeIds?: string[];
};

export type WorkflowBudgetSession = {
  readonly limits: RunBudgetCountersV1;
  snapshot(): RunBudgetStateV1;
  remaining(): RunBudgetCountersV1;
  reserve(
    reservation: Partial<RunBudgetCountersV1>,
    context: WorkflowBudgetReservationContext,
  ): Promise<RunBudgetStateV1>;
};

export function workflowRunBudgetAbortSignal(
  budget: WorkflowBudgetSession,
  external?: AbortSignal,
) {
  const wallSignal = AbortSignal.timeout(Math.max(
    1,
    budget.remaining().wallTimeMs,
  ));
  return external ? AbortSignal.any([external, wallSignal]) : wallSignal;
}

export function createWorkflowBudgetSession(
  detail: WorkflowRunDetail,
  now = Date.now(),
): WorkflowBudgetSession {
  const limits = runBudgetCountersV1Schema.parse(
    detail.run.input.budgetLimits || WORKFLOW_RUN_BUDGET_LIMITS,
  );
  const persisted = persistedBudgetState(detail.events, limits);
  const legacyUsed = detail.run.input.budgetLimits
    ? undefined
    : conservativeLegacyUsage(detail, limits);
  const wallTimeMs = workflowActiveWallTimeMs(detail.events, now);
  let state = createRunBudgetState(limits, {
    startedAt: new Date(now - wallTimeMs).toISOString(),
    used: {
      ...(legacyUsed || {}),
      ...(persisted?.used || {}),
      wallTimeMs: Math.max(persisted?.used.wallTimeMs || 0, wallTimeMs),
    },
  });

  return {
    limits,
    snapshot: () => refreshRunBudgetWallTime(state),
    remaining: () => remainingRunBudget(state),
    async reserve(reservation, context) {
      const next = reserveRunBudget(state, reservation);
      await appendWorkflowEvent(detail.run.id, "workflow.budget_reserved", {
        schemaVersion: 1,
        phase: context.phase,
        ...(context.nodeIds?.length ? { nodeIds: context.nodeIds } : {}),
        reservation: completeReservation(reservation),
        used: next.used,
        limitsSha256: budgetLimitsSha256(limits),
      });
      state = next;
      return state;
    },
  };
}

/** How many targets a workflow model call may try, and how a fallback is paid for. */
export type WorkflowModelAttempts = Pick<
  ModelTextRequest,
  "maxAttempts" | "beforeRetry"
>;

/**
 * Reserve one model call. The call may fall back to a second target. That
 * fallback draws on the retry budget that step retries and queue redelivery
 * also use, so it is charged only when the first target fails.
 */
export async function reserveWorkflowModelCall(
  budget: WorkflowBudgetSession,
  context: WorkflowBudgetReservationContext,
  options: { agents?: number; fanOut?: number; allowRetry?: boolean } = {},
): Promise<WorkflowModelAttempts> {
  await budget.reserve({
    modelTurns: 1,
    tokens: modelCallShare(budget.limits.tokens, budget.limits.modelTurns),
    costMicrousd: modelCallShare(
      budget.limits.costMicrousd,
      budget.limits.modelTurns,
    ),
    agents: options.agents || 0,
    fanOut: options.fanOut || 0,
  }, context);
  if (options.allowRetry === false || budget.remaining().retries === 0) {
    return { maxAttempts: 1 };
  }
  return {
    maxAttempts: 2,
    beforeRetry: async () => {
      try {
        await budget.reserve(
          { retries: 1 },
          { ...context, phase: `${context.phase}.fallback` },
        );
        return true;
      } catch (error) {
        if (error instanceof RunBudgetExceededError) return false;
        throw error;
      }
    },
  };
}

export function workflowActiveWallTimeMs(
  events: readonly WorkflowEventRecord[],
  now = Date.now(),
) {
  let activeSince: number | undefined;
  let total = 0;
  for (const event of [...events].sort((left, right) =>
    Date.parse(left.createdAt) - Date.parse(right.createdAt)
  )) {
    const at = Date.parse(event.createdAt);
    if (!Number.isFinite(at)) continue;
    if (event.type === "step.started" && activeSince === undefined) {
      activeSince = at;
      continue;
    }
    if (
      activeSince !== undefined &&
      [
        "step.completed",
        "step.failed",
        "step.interrupted",
        "workflow.waiting_approval",
        "workflow.plan_execution.requeued",
        "workflow.paused",
        "workflow.canceled",
      ].includes(event.type)
    ) {
      total += Math.max(0, at - activeSince);
      activeSince = undefined;
    }
  }
  if (activeSince !== undefined) {
    total += Math.max(0, now - activeSince);
  }
  return total;
}

function conservativeLegacyUsage(
  detail: WorkflowRunDetail,
  limits: RunBudgetCountersV1,
): Partial<RunBudgetCountersV1> {
  const step = (key: string) => detail.steps.find((item) => item.stepKey === key);
  const executeOutput = step("execute")?.output;
  const planExecution = executeOutput?.planExecution as
    | Record<string, unknown>
    | undefined;
  const historicalNodes = Math.max(
    0,
    Number(planExecution?.completedNodes || 0),
  );
  const toolCalls = Math.min(
    limits.toolCalls,
    Math.max(0, Number(planExecution?.toolCalls || 0)),
  );
  const explicitModelTurns = [
    step("plan")?.output?.planner &&
      !["deterministic", "fallback"].includes(String(step("plan")?.output?.planner)),
    executeOutput?.synthesisProvider,
    step("verify")?.output?.modelVerdict,
  ].filter(Boolean).length;
  const modelTurns = Math.min(
    limits.modelTurns,
    explicitModelTurns + historicalNodes,
  );
  return {
    modelTurns,
    tokens: Math.min(
      limits.tokens,
      modelTurns * modelCallShare(limits.tokens, limits.modelTurns),
    ),
    costMicrousd: Math.min(
      limits.costMicrousd,
      modelTurns * modelCallShare(
        limits.costMicrousd,
        limits.modelTurns,
      ),
    ),
    toolCalls,
    // Old receipts did not persist tool category. Do not silently grant new
    // browser authority after an upgrade if prior calls may have consumed it.
    browserActions: toolCalls > 0 ? limits.browserActions : 0,
    agents: Math.min(limits.agents, 1 + historicalNodes),
    fanOut: Math.min(
      limits.fanOut,
      detail.events
        .filter((event) => event.type === "workflow.plan_batch.started")
        .reduce((total, event) =>
          total + Math.max(0, Number(event.payload.nodeCount || 1) - 1), 0),
    ),
    retries: Math.min(
      limits.retries,
      detail.events.filter((event) =>
        ["step.retry_scheduled", "workflow.queue.redelivery_reclaimed"].includes(event.type)
      ).length,
    ),
    replans: Math.min(
      limits.replans,
      detail.events.filter((event) => event.type === "workflow.replan_triggered").length,
    ),
  };
}

/**
 * The run's recorded usage: each dimension's highest count across its
 * reservations. Usage only grows, so this is the latest usage however
 * reservations recorded in the same millisecond are ordered.
 */
function persistedBudgetState(
  events: readonly WorkflowEventRecord[],
  limits: RunBudgetCountersV1,
) {
  let used: RunBudgetCountersV1 | undefined;
  for (const event of events) {
    if (event.type !== "workflow.budget_reserved") continue;
    const recorded = runBudgetCountersV1Schema.safeParse(event.payload.used);
    if (!recorded.success) continue;
    const highest: RunBudgetCountersV1 = { ...recorded.data };
    for (const dimension of RUN_BUDGET_DIMENSIONS) {
      highest[dimension] = Math.max(used?.[dimension] || 0, highest[dimension]);
    }
    used = highest;
  }
  return used ? createRunBudgetState(limits, { used }) : undefined;
}

function completeReservation(
  reservation: Partial<RunBudgetCountersV1>,
) {
  return Object.fromEntries(
    RUN_BUDGET_DIMENSIONS.map((dimension) => [
      dimension,
      reservation[dimension] || 0,
    ]),
  ) as RunBudgetCountersV1;
}

function budgetLimitsSha256(limits: RunBudgetCountersV1) {
  return createHash("sha256")
    .update(JSON.stringify(limits))
    .digest("hex");
}

function modelCallShare(total: number, turns: number) {
  return Math.max(1, Math.floor(total / Math.max(1, turns)));
}
