import { describe, expect, it } from "vitest";
import { AGENT_RUN_BUDGET_LIMITS, WORKFLOW_RUN_BUDGET_LIMITS } from "@/lib/config";
import { narrowRunBudgetLimits } from "@/lib/runs/budgets";
import { RESEARCH_REPORT_BUDGET } from "../../../scripts/smoke-web-research.mjs";

describe("live Research report acceptance request", () => {
  it("fits both authority ceilings checked by the Agent API before routing", () => {
    for (const authority of [AGENT_RUN_BUDGET_LIMITS, WORKFLOW_RUN_BUDGET_LIMITS]) {
      expect(narrowRunBudgetLimits(authority, RESEARCH_REPORT_BUDGET))
        .toEqual(RESEARCH_REPORT_BUDGET);
    }
  });
});
