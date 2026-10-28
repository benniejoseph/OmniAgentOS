import { improvementPreparationPassed, type ImprovementPlan, type ImprovementPreparation } from "./runtime";

type Check = Readonly<{ command: string; exitCode: number; reportComplete?: boolean }>;
const staticCommands = new Set(["lint_focused", "typecheck_direct", "macos_analyze", "macos_build"]);

/** Signal-style exits do not establish a compiler/analyzer verdict. The exit
 * alone cannot distinguish a deadline, resource limit, or another termination. */
export function incompleteStaticCheck<T extends Check>(checks: readonly T[]): T | undefined {
  return checks.find(check => staticCommands.has(check.command) &&
    (check.reportComplete === false || check.exitCode < 0 || check.exitCode >= 128));
}

export function assessImprovementPreparation(preparation: ImprovementPreparation, plan: ImprovementPlan):
  | { outcome: "accepted" | "invalid" }
  | { outcome: "static_check_incomplete"; check: ImprovementPreparation["checks"][number]["evidence"] } {
  const check = preparation.checks.find(item => incompleteStaticCheck([{ ...item.evidence, reportComplete: item.reportComplete }]))?.evidence;
  if (check) return { outcome: "static_check_incomplete", check };
  return { outcome: improvementPreparationPassed(preparation, plan) ? "accepted" : "invalid" };
}
