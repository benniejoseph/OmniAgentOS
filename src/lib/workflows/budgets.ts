import { createHash } from "node:crypto";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import {
  RUN_BUDGET_DIMENSIONS,
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

export function createWorkflowBudgetSession(
  detail: WorkflowRunDetail,
  now = Date.now(),
): WorkflowBudgetSession {
  const limits = runBudgetCountersV1Schema.parse(
    detail.run.input.budgetLimits || WORKFLOW_RUN_BUDGET_LIMITS,
  );
  const persisted = latestPersistedBudgetState(detail.events, limits);
  const wallTimeMs = workflowActiveWallTimeMs(detail.events, now);
  let state = createRunBudgetState(limits, {
    startedAt: new Date(now - wallTimeMs).toISOString(),
    used: {
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

export async function reserveWorkflowModelCall(
  budget: WorkflowBudgetSession,
  context: WorkflowBudgetReservationContext,
  options: { agents?: number; fanOut?: number; allowRetry?: boolean } = {},
) {
  const remaining = budget.remaining();
  const retrySlots = options.allowRetry === false || remaining.retries === 0
    ? 0
    : 1;
  await budget.reserve({
    modelTurns: 1,
    tokens: modelCallShare(budget.limits.tokens, budget.limits.modelTurns),
    costMicrousd: modelCallShare(
      budget.limits.costMicrousd,
      budget.limits.modelTurns,
    ),
    retries: retrySlots,
    agents: options.agents || 0,
    fanOut: options.fanOut || 0,
  }, context);
  return { maxAttempts: 1 + retrySlots };
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

function latestPersistedBudgetState(
  events: readonly WorkflowEventRecord[],
  limits: RunBudgetCountersV1,
) {
  for (const event of [...events].reverse()) {
    if (event.type !== "workflow.budget_reserved") continue;
    const used = runBudgetCountersV1Schema.safeParse(event.payload.used);
    if (!used.success) continue;
    return createRunBudgetState(limits, { used: used.data });
  }
  return undefined;
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
  if (total === 0) return 0;
  return Math.max(1, Math.floor(total / Math.max(1, turns)));
}
