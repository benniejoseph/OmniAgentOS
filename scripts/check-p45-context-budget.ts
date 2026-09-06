import {
  P45_CONTEXT_BUDGET_THRESHOLDS,
  p45ContextBudgetGatePasses,
  runP45ContextBudgetBenchmark,
} from "../src/lib/rag/context-budget-benchmark";

const metrics = runP45ContextBudgetBenchmark();
const passed = p45ContextBudgetGatePasses(metrics);

process.stdout.write(`${JSON.stringify({
  gate: "p4.5-context-budget:1",
  passed,
  thresholds: P45_CONTEXT_BUDGET_THRESHOLDS,
  metrics,
}, null, 2)}\n`);

if (!passed) process.exitCode = 1;
