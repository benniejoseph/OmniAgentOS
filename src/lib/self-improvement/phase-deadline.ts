import type { SelfImprovementRuntime } from "./runtime";

export const IMPROVEMENT_PHASE_TIMEOUT_MS = 240_000;
export const IMPROVEMENT_TYPECHECK_PHASE_TIMEOUT_MS = 270_000;

/** Only the next persisted web typecheck receives the measured compiler window. */
export function selfImprovementPhaseTimeoutMs(runtime: SelfImprovementRuntime | undefined): number {
  if (!runtime?.plan || runtime.plan.releaseTarget === "macos_app" || runtime.phaseAttempt) return IMPROVEMENT_PHASE_TIMEOUT_MS;
  const preparation = runtime.preparations?.at(-1);
  const typecheckNext = runtime.phase === "baseline_check"
    ? preparation && !preparation.accepted && preparation.checks.length === 1 && preparation.checks[0].evidence.command === "lint_focused"
    : runtime.phase === "verify" && runtime.checks.length === 1 && runtime.checks[0].command === "lint_focused";
  return typecheckNext ? IMPROVEMENT_TYPECHECK_PHASE_TIMEOUT_MS : IMPROVEMENT_PHASE_TIMEOUT_MS;
}
