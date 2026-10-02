/**
 * Error-budget-gated promotion. Each objective allows a share of the week's
 * finished agent runs or tool calls to fail; that share is its error budget.
 * A release is held while a budget is spent and the last day still fails
 * faster than its objective allows. A release that is the fix ships past the
 * hold under an exception the deploy names, and the evidence records it.
 *
 * Only workspaces people sign in to count: the release smokes run in tenants
 * with no members, so their own runs never spend the budget.
 */

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import type { ReleaseEvidenceGate } from "@/lib/release/evidence";

export const ERROR_BUDGET_WINDOW_DAYS = 7;
export const ERROR_BUDGET_BURN_WINDOW_HOURS = 24;
/** Below this many finished in the week, a budget is not judged. */
export const ERROR_BUDGET_MIN_SAMPLES = 20;
/** The longest exception reason a release may give. */
export const ERROR_BUDGET_EXCEPTION_MAX_CHARS = 200;

export const ERROR_BUDGET_OBJECTIVES = [
  { id: "agent_runs", label: "agent runs", budgetPercent: 5 },
  { id: "tool_calls", label: "tool calls", budgetPercent: 10 },
] as const;

export type ErrorBudgetObjectiveId = (typeof ERROR_BUDGET_OBJECTIVES)[number]["id"];

export type ErrorBudgetCounts = {
  week: { finished: number; failed: number };
  day: { finished: number; failed: number };
};

export type ErrorBudgetVerdict = "insufficient" | "within" | "recovering" | "exhausted";

export type ErrorBudgetObjectiveReport = {
  id: ErrorBudgetObjectiveId;
  /** The share of finished work that must succeed. */
  objective: number;
  verdict: ErrorBudgetVerdict;
  /** The week's success rate; absent when nothing finished. */
  successRate?: number;
  /** How much of the week's budget failures used; 1 is all of it. */
  budgetSpent: number;
  /** The last day's failures over what the objective allows; 1 keeps pace. */
  burnRate: number;
};

export type ErrorBudgetReport = {
  checkedAt: string;
  /** False when the counts could not be read. */
  measured: boolean;
  objectives: ErrorBudgetObjectiveReport[];
};

const HOUR_MS = 3_600_000;
// A reason is one line of text: no control characters.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Judges one objective's week and last day of finished work. */
export function evaluateErrorBudget(
  objective: { id: ErrorBudgetObjectiveId; budgetPercent: number },
  counts: ErrorBudgetCounts,
): ErrorBudgetObjectiveReport {
  const { week, day } = counts;
  // Compared in whole numbers, so a week exactly at its budget is spent.
  const spent = week.failed * 100 >= objective.budgetPercent * week.finished;
  const burning = day.finished > 0 &&
    day.failed * 100 >= objective.budgetPercent * day.finished;
  const verdict: ErrorBudgetVerdict = week.finished < ERROR_BUDGET_MIN_SAMPLES
    ? "insufficient"
    : !spent
      ? "within"
      : burning
        ? "exhausted"
        : "recovering";
  return {
    id: objective.id,
    objective: (100 - objective.budgetPercent) / 100,
    verdict,
    ...(week.finished
      ? { successRate: round((week.finished - week.failed) / week.finished) }
      : {}),
    budgetSpent: week.finished
      ? round((week.failed * 100) / (objective.budgetPercent * week.finished))
      : 0,
    burnRate: day.finished
      ? round((day.failed * 100) / (objective.budgetPercent * day.finished))
      : 0,
  };
}

/**
 * A release exception's reason: trimmed, one line, and bounded. Undefined
 * when none was given; null when the reason cannot be used.
 */
export function normalizeErrorBudgetException(value: string | null | undefined) {
  const reason = value?.trim();
  if (!reason) return undefined;
  if (reason.length > ERROR_BUDGET_EXCEPTION_MAX_CHARS || CONTROL_CHARACTERS.test(reason)) {
    return null;
  }
  return reason;
}

/** The release gate for an error budget report. */
export function errorBudgetGate(
  report: ErrorBudgetReport,
  exceptionReason?: string,
): ReleaseEvidenceGate {
  const named = (verdict: ErrorBudgetVerdict) => joinLabels(
    report.objectives
      .filter((item) => item.verdict === verdict)
      .map((item) => labelOf(item.id)),
  );
  const exhausted = named("exhausted");
  const recovering = named("recovering");
  const hold = !report.measured
    ? "The agent error budget could not be read."
    : exhausted
      ? `${capitalize(exhausted)} have spent the week's error budget, and the last day still fails faster than the objective allows.`
      : undefined;
  const applied = Boolean(hold && exceptionReason);
  return {
    id: "agent_error_budget",
    name: "Agent error budget",
    status: hold && !applied ? "fail" : "pass",
    summary: hold
      ? applied
        ? `${hold} This release ships under a recorded exception.`
        : hold
      : recovering
        ? `${capitalize(recovering)} have spent the week's error budget, but the last day is within the objective.`
        : report.objectives.every((item) => item.verdict === "insufficient")
          ? "Too little work finished this week to judge the error budget."
          : "No error budget is spent this week.",
    details: {
      windowDays: ERROR_BUDGET_WINDOW_DAYS,
      burnWindowHours: ERROR_BUDGET_BURN_WINDOW_HOURS,
      minimumSamples: ERROR_BUDGET_MIN_SAMPLES,
      measured: report.measured,
      objectives: report.objectives,
      ...(exceptionReason ? { exception: { reason: exceptionReason, applied } } : {}),
    },
  };
}

/** The error budget now, across the workspaces people sign in to. */
export async function getReleaseErrorBudget(
  now = new Date(),
): Promise<ErrorBudgetReport> {
  let counts: Record<ErrorBudgetObjectiveId, ErrorBudgetCounts>;
  try {
    counts = await readErrorBudgetCounts(now);
  } catch {
    return { checkedAt: now.toISOString(), measured: false, objectives: [] };
  }
  return {
    checkedAt: now.toISOString(),
    measured: true,
    objectives: ERROR_BUDGET_OBJECTIVES.map((objective) =>
      evaluateErrorBudget(objective, counts[objective.id])
    ),
  };
}

/**
 * Finished runs and tool calls in the week and the last day, in tenants with
 * an active member. Without a database there is no work to count.
 */
export async function readErrorBudgetCounts(
  now: Date,
): Promise<Record<ErrorBudgetObjectiveId, ErrorBudgetCounts>> {
  if (!hasDatabaseUrl()) {
    const none = { week: { finished: 0, failed: 0 }, day: { finished: 0, failed: 0 } };
    return { agent_runs: none, tool_calls: none };
  }
  await ensureDatabaseSchema();
  const weekStart = new Date(now.getTime() - ERROR_BUDGET_WINDOW_DAYS * 24 * HOUR_MS);
  const dayStart = new Date(now.getTime() - ERROR_BUDGET_BURN_WINDOW_HOURS * HOUR_MS);
  const rows = await runWithDatabaseSystemScope(
    "Count finished agent runs and tool calls for the release error budget.",
    () => getSql().query(
      `
        WITH member_tenants AS (
          SELECT DISTINCT tenant_id
          FROM omni_auth_memberships
          WHERE status = 'active'
        ),
        finished_runs AS (
          SELECT status, completed_at
          FROM omni_agent_runs
          WHERE tenant_id IN (SELECT tenant_id FROM member_tenants)
            AND status IN ('completed', 'failed')
            AND completed_at >= $1
        ),
        finished_tools AS (
          SELECT status, completed_at
          FROM omni_tool_executions
          WHERE tenant_id IN (SELECT tenant_id FROM member_tenants)
            AND status IN ('executed', 'failed')
            AND completed_at >= $1
        )
        SELECT
          (SELECT COUNT(*)::int FROM finished_runs) AS runs_week,
          (SELECT COUNT(*)::int FROM finished_runs WHERE status = 'failed') AS runs_week_failed,
          (SELECT COUNT(*)::int FROM finished_runs WHERE completed_at >= $2) AS runs_day,
          (SELECT COUNT(*)::int FROM finished_runs
            WHERE status = 'failed' AND completed_at >= $2) AS runs_day_failed,
          (SELECT COUNT(*)::int FROM finished_tools) AS tools_week,
          (SELECT COUNT(*)::int FROM finished_tools WHERE status = 'failed') AS tools_week_failed,
          (SELECT COUNT(*)::int FROM finished_tools WHERE completed_at >= $2) AS tools_day,
          (SELECT COUNT(*)::int FROM finished_tools
            WHERE status = 'failed' AND completed_at >= $2) AS tools_day_failed
      `,
      [weekStart, dayStart],
    ),
  );
  const row = (rows[0] || {}) as Record<string, unknown>;
  const count = (key: string) => Number(row[key] || 0);
  return {
    agent_runs: {
      week: { finished: count("runs_week"), failed: count("runs_week_failed") },
      day: { finished: count("runs_day"), failed: count("runs_day_failed") },
    },
    tool_calls: {
      week: { finished: count("tools_week"), failed: count("tools_week_failed") },
      day: { finished: count("tools_day"), failed: count("tools_day_failed") },
    },
  };
}

function labelOf(id: ErrorBudgetObjectiveId) {
  return ERROR_BUDGET_OBJECTIVES.find((objective) => objective.id === id)?.label ?? id;
}

function joinLabels(labels: string[]) {
  return labels.length > 1
    ? `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`
    : labels[0] || "";
}

function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function round(value: number) {
  return Math.round(value * 10_000) / 10_000;
}
