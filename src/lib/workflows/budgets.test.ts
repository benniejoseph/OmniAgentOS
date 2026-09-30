import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import {
  RUN_BUDGET_DIMENSIONS,
  type RunBudgetCountersV1,
} from "@/lib/runs/budgets";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

vi.mock("@/lib/workflows/store", () => ({
  appendWorkflowEvent: vi.fn(async () => undefined),
}));

import {
  createWorkflowBudgetSession,
  reserveWorkflowModelCall,
  workflowActiveWallTimeMs,
} from "@/lib/workflows/budgets";
import { appendWorkflowEvent } from "@/lib/workflows/store";

function detail(retries = WORKFLOW_RUN_BUDGET_LIMITS.retries): WorkflowRunDetail {
  return {
    run: {
      id: "workflow-budget",
      workflowType: "agent.workflow.v1",
      status: "queued",
      goal: "Stay bounded",
      input: {
        goal: "Stay bounded",
        budgetLimits: { ...WORKFLOW_RUN_BUDGET_LIMITS, toolCalls: 1, retries },
      },
      attempt: 0,
      maxAttempts: 3,
      approvalRequired: false,
      createdAt: "2026-09-06T00:00:00.000Z",
      updatedAt: "2026-09-06T00:00:00.000Z",
    },
    steps: [],
    events: [],
  };
}

describe("durable workflow budgets", () => {
  it("fails before a persisted run-wide dimension is exceeded", async () => {
    const budget = createWorkflowBudgetSession(detail());
    await budget.reserve({ toolCalls: 1 }, { phase: "execute" });
    await expect(
      budget.reserve({ toolCalls: 1 }, { phase: "execute" }),
    ).rejects.toMatchObject({ dimension: "toolCalls" });
  });

  it("resumes from each dimension's highest recorded usage, whatever order its records are read in", async () => {
    const reserved = (id: string, used: Record<string, unknown>) => ({
      id,
      workflowRunId: "workflow-budget",
      type: "workflow.budget_reserved",
      // Records made in the same millisecond come back in either order.
      createdAt: "2026-09-06T00:00:01.000Z",
      payload: {
        used: {
          ...Object.fromEntries(RUN_BUDGET_DIMENSIONS.map((dimension) => [dimension, 0])),
          ...used,
        } as Partial<RunBudgetCountersV1>,
      },
    });
    const run = detail();
    run.events = [
      reserved("model-call", { modelTurns: 2, toolCalls: 1 }),
      // A redelivery reserved from the same usage as the model call.
      reserved("redelivery", { modelTurns: 1, toolCalls: 1, retries: 1 }),
      reserved("tool-call", { modelTurns: 1, toolCalls: 1 }),
      reserved("unreadable", { modelTurns: -1 }),
    ];

    const budget = createWorkflowBudgetSession(run);

    expect(budget.snapshot().used).toMatchObject({
      modelTurns: 2,
      toolCalls: 1,
      retries: 1,
      replans: 0,
    });
    await expect(
      budget.reserve({ toolCalls: 1 }, { phase: "execute" }),
    ).rejects.toMatchObject({ dimension: "toolCalls" });
  });

  it("reserves a bounded model envelope and charges a fallback only when made", async () => {
    const budget = createWorkflowBudgetSession(detail(1));
    const plan = await reserveWorkflowModelCall(budget, {
      phase: "plan",
      nodeIds: ["node-1"],
    });
    expect(plan).toEqual({ maxAttempts: 2, beforeRetry: expect.any(Function) });
    expect(budget.snapshot().used).toMatchObject({
      modelTurns: 1,
      retries: 0,
      tokens: Math.floor(
        WORKFLOW_RUN_BUDGET_LIMITS.tokens /
          WORKFLOW_RUN_BUDGET_LIMITS.modelTurns,
      ),
    });
    const verify = await reserveWorkflowModelCall(budget, { phase: "verify" });
    expect(verify.maxAttempts).toBe(2);

    vi.mocked(appendWorkflowEvent).mockClear();
    await expect(plan.beforeRetry?.()).resolves.toBe(true);
    expect(budget.snapshot().used).toMatchObject({ modelTurns: 2, retries: 1 });
    expect(appendWorkflowEvent).toHaveBeenCalledWith(
      "workflow-budget",
      "workflow.budget_reserved",
      expect.objectContaining({
        phase: "plan.fallback",
        nodeIds: ["node-1"],
        reservation: expect.objectContaining({ modelTurns: 0, retries: 1 }),
      }),
    );

    // The one retry is spent, so the next fallback is declined, uncharged.
    await expect(verify.beforeRetry?.()).resolves.toBe(false);
    expect(budget.snapshot().used.retries).toBe(1);
    expect(appendWorkflowEvent).toHaveBeenCalledTimes(1);
    await expect(reserveWorkflowModelCall(budget, { phase: "synthesize" }))
      .resolves.toEqual({ maxAttempts: 1 });
    await expect(reserveWorkflowModelCall(
      createWorkflowBudgetSession(detail()),
      { phase: "query" },
      { allowRetry: false },
    )).resolves.toEqual({ maxAttempts: 1 });
  });

  it("reports a fallback it could not record instead of declining it", async () => {
    const budget = createWorkflowBudgetSession(detail());
    const attempts = await reserveWorkflowModelCall(budget, { phase: "plan" });
    vi.mocked(appendWorkflowEvent).mockRejectedValueOnce(new Error("store down"));

    await expect(attempts.beforeRetry?.()).rejects.toThrow("store down");
    expect(budget.snapshot().used.retries).toBe(0);
  });

  it("counts active execution intervals but excludes approval waiting", () => {
    const events = [
      { type: "step.started", createdAt: "2026-09-06T00:00:00.000Z" },
      { type: "workflow.waiting_approval", createdAt: "2026-09-06T00:00:02.000Z" },
      { type: "step.started", createdAt: "2026-09-06T01:00:00.000Z" },
      { type: "step.completed", createdAt: "2026-09-06T01:00:03.000Z" },
    ].map((event, index) => ({
      id: String(index),
      workflowRunId: "workflow-budget",
      payload: {},
      ...event,
    }));
    expect(workflowActiveWallTimeMs(events)).toBe(5_000);
  });
});
