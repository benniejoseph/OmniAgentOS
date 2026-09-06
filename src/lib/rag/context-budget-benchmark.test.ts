import { describe, expect, it } from "vitest";

import {
  P45_CONTEXT_BUDGET_THRESHOLDS,
  p45ContextBudgetGatePasses,
  runP45ContextBudgetBenchmark,
} from "@/lib/rag/context-budget-benchmark";

describe("P4.5 frozen context-budget gate", () => {
  it("meets every lineage, priority, duplication, and hard-budget threshold", () => {
    const metrics = runP45ContextBudgetBenchmark();

    expect(metrics).toMatchObject({
      caseCount: P45_CONTEXT_BUDGET_THRESHOLDS.caseCount,
      budgetComplianceRate: 1,
      duplicateShareComplianceRate: 1,
      lineageAccuracyRate: 1,
      priorityTierCoverageRate: 1,
    });
    expect(metrics.averageDuplicateTokenShare).toBeLessThanOrEqual(
      P45_CONTEXT_BUDGET_THRESHOLDS.maximumAverageDuplicateTokenShare,
    );
    expect(p45ContextBudgetGatePasses(metrics)).toBe(true);
  });
});
