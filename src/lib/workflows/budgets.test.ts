import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import type { WorkflowRunDetail } from "@/lib/workflows/types";

vi.mock("@/lib/workflows/store", () => ({
  appendWorkflowEvent: vi.fn(async () => undefined),
}));

import {
  createWorkflowBudgetSession,
  reserveWorkflowModelCall,
  workflowActiveWallTimeMs,
} from "@/lib/workflows/budgets";

function detail(): WorkflowRunDetail {
  return {
    run: {
      id: "workflow-budget",
      workflowType: "agent.workflow.v1",
      status: "queued",
      goal: "Stay bounded",
      input: {
        goal: "Stay bounded",
        budgetLimits: { ...WORKFLOW_RUN_BUDGET_LIMITS, toolCalls: 1 },
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

  it("reserves a bounded model envelope and at most one fallback", async () => {
    const budget = createWorkflowBudgetSession(detail());
    await expect(reserveWorkflowModelCall(budget, { phase: "plan" }))
      .resolves.toEqual({ maxAttempts: 2 });
    expect(budget.snapshot().used).toMatchObject({
      modelTurns: 1,
      retries: 1,
      tokens: Math.floor(
        WORKFLOW_RUN_BUDGET_LIMITS.tokens /
          WORKFLOW_RUN_BUDGET_LIMITS.modelTurns,
      ),
    });
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
