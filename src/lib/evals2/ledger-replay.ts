/**
 * Ledger-replay evals. Turns the tenant's own completed runs into golden
 * tasks for the live-model runner (scripts/run-evals.mjs): the goal is the
 * run's only user message, and the assertions hold a candidate deployment
 * or model to the recorded run's tools, citations, answer length, latency,
 * and cost. Pure: the caller loads the runs and their events.
 */

import { createHash } from "node:crypto";
import type { GoldenAssertion, GoldenTask } from "@/lib/evals2/scorer";
import type { AgentRunEventRecord, AgentRunRecord } from "@/lib/runs/types";

/** The most recent runs an export looks through. */
export const LEDGER_REPLAY_RUN_WINDOW = 200;
/** One page of a run's events; a full page may have cut the run short. */
export const LEDGER_REPLAY_EVENT_PAGE = 500;
const MAX_GOAL_CHARS = 2_000;
const MIN_LATENCY_BUDGET_MS = 30_000;
const DAY_MS = 86_400_000;

// A goal with contact details, a link, a long number, an opaque token, a
// credential word, or text the run store already redacted stays out of the
// corpus, which leaves the server as a file.
const PRIVATE_DETAIL = [
  /[^\s@]+@[^\s@]+\.[^\s@]+/,
  /\bhttps?:\/\/|\bwww\./i,
  /\d(?:[\s().-]*\d){8,}/,
  /[a-z0-9_-]{32,}/i,
  /\b(?:password|passcode|passphrase|otp)\b/i,
  /\[redacted/i,
];

export type LedgerReplaySkipReason =
  | "conversation"
  | "needs_work"
  | "goal_length"
  | "private_detail"
  | "approval"
  | "blocked"
  | "effect"
  | "too_long"
  | "no_model";

export type LedgerReplayRunSummary = {
  toolIds: string[];
  providers: string[];
  modelCalls: number;
  /** Undefined when any model call's cost was unknown. */
  estimatedCostUsd?: number;
  approvalNeeded: boolean;
  blocked: boolean;
  /** A tool that can write ran, or ran and failed, outside a dry run. */
  effect: boolean;
  eventsComplete: boolean;
};

export type LedgerReplayTask = GoldenTask & {
  baseline: {
    recordedOn: string;
    toolIds: string[];
    providers: string[];
    latencyMs: number;
    responseChars: number;
    citations: number;
    estimatedCostUsd?: number;
    feedback?: "useful";
  };
};

export type LedgerReplayCorpus = {
  version: 2;
  kind: "ledger_replay";
  schemaVersion: 1;
  description: string;
  generatedAt: string;
  since: string;
  examined: number;
  skipped: Partial<Record<LedgerReplaySkipReason, number>>;
  tasks: LedgerReplayTask[];
};

/** What a run's persisted events say it did. */
export function summarizeLedgerReplayRun(
  events: readonly AgentRunEventRecord[],
): LedgerReplayRunSummary {
  const toolIds = new Set<string>();
  const providers = new Set<string>();
  let modelCalls = 0;
  let cost: number | undefined = 0;
  let approvalNeeded = false;
  let blocked = false;
  let effect = false;
  for (const event of events) {
    const payload = (event.payload && typeof event.payload === "object"
      ? event.payload
      : {}) as Record<string, unknown>;
    if (event.type === "waiting_approval") approvalNeeded = true;
    if (event.type === "tool") {
      if (typeof payload.toolId === "string" && payload.status !== "running") {
        toolIds.add(payload.toolId);
      }
      if (
        payload.status === "approval_required" ||
        (typeof payload.riskLevel === "number" && payload.riskLevel >= 2)
      ) {
        approvalNeeded = true;
      }
      if (payload.status === "blocked") blocked = true;
      // Only a risk-0 tool is read-only; an unknown risk counts as a write.
      if (
        (payload.status === "executed" || payload.status === "failed") &&
        payload.riskLevel !== 0
      ) {
        effect = true;
      }
    }
    if (event.type === "model") {
      modelCalls += 1;
      if (typeof payload.provider === "string") providers.add(payload.provider);
      cost = cost !== undefined &&
          payload.costKnown !== false &&
          typeof payload.estimatedCostUsd === "number" &&
          Number.isFinite(payload.estimatedCostUsd)
        ? cost + payload.estimatedCostUsd
        : undefined;
    }
  }
  return {
    toolIds: [...toolIds].sort(),
    providers: [...providers].sort(),
    modelCalls,
    ...(modelCalls > 0 && cost !== undefined ? { estimatedCostUsd: cost } : {}),
    approvalNeeded,
    blocked,
    effect,
    eventsComplete: events.length < LEDGER_REPLAY_EVENT_PAGE,
  };
}

/** Why a run cannot be replayed, judged from the run row alone. */
export function ledgerReplayRunSkip(
  run: AgentRunRecord,
): LedgerReplaySkipReason | undefined {
  const goal = replayGoal(run);
  if (goal === undefined) return "conversation";
  if (run.feedback?.verdict === "needs_work") return "needs_work";
  if (!goal || goal.length > MAX_GOAL_CHARS) return "goal_length";
  if (PRIVATE_DETAIL.some((pattern) => pattern.test(goal))) return "private_detail";
  return undefined;
}

/**
 * A completed run as a replay task, or why it is left out. A run that needed
 * an approval, was blocked, or wrote anything had an effect or a refusal a
 * replay must not repeat unattended, so a replay starts only read-only runs.
 */
export function ledgerReplayCase(
  run: AgentRunRecord,
  summary: LedgerReplayRunSummary,
): { task: LedgerReplayTask } | { skipped: LedgerReplaySkipReason } {
  const runSkip = ledgerReplayRunSkip(run);
  if (runSkip) return { skipped: runSkip };
  if (summary.approvalNeeded) return { skipped: "approval" };
  if (summary.blocked) return { skipped: "blocked" };
  if (summary.effect) return { skipped: "effect" };
  if (!summary.eventsComplete) return { skipped: "too_long" };
  if (summary.modelCalls === 0) return { skipped: "no_model" };

  const latencyMs = Math.max(
    0,
    Date.parse(run.completedAt || run.startedAt) - Date.parse(run.startedAt),
  ) || 0;
  const responseChars = (run.response || "").trim().length;
  const citations = run.grounding?.citedIds?.length ?? 0;
  const cost = summary.estimatedCostUsd;
  const assert: GoldenAssertion = {
    maxLatencyMs: Math.max(MIN_LATENCY_BUDGET_MS, latencyMs * 3),
    ...(responseChars >= 2
      ? { minLength: Math.min(80, Math.floor(responseChars / 2)) }
      : {}),
    ...(summary.toolIds.length ? { requiredToolIds: summary.toolIds } : {}),
    ...(citations > 0 ? { minCitations: 1 } : {}),
    ...(cost !== undefined && cost > 0
      ? { maxEstimatedCostUsd: Math.ceil(cost * 2 * 1e6) / 1e6 }
      : {}),
  };
  return {
    task: {
      id: `replay-${run.id}`,
      goal: replayGoal(run) as string,
      mode: run.mode,
      assert,
      rationale:
        "Replays a completed run: use the same tools, cite when it cited, and stay within three times its latency and twice its cost.",
      baseline: {
        recordedOn: run.startedAt.slice(0, 10),
        toolIds: summary.toolIds,
        providers: summary.providers,
        latencyMs,
        responseChars,
        citations,
        ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
        ...(run.feedback?.verdict === "useful" ? { feedback: "useful" as const } : {}),
      },
    },
  };
}

/**
 * A replay corpus from the tenant's recent completed runs. Runs are taken in
 * an order fixed by a hash of the tenant and run, so an export samples the
 * window evenly and the same run keeps its place across exports.
 */
export async function buildLedgerReplayCorpus(input: {
  tenantId: string;
  runs: readonly AgentRunRecord[];
  days: number;
  limit: number;
  now: Date;
  loadEvents: (runId: string) => Promise<readonly AgentRunEventRecord[]>;
}): Promise<LedgerReplayCorpus> {
  const since = new Date(input.now.getTime() - input.days * DAY_MS);
  const candidates = input.runs
    .filter((run) =>
      run.status === "completed" &&
      Boolean(run.completedAt) &&
      Date.parse(run.startedAt) >= since.getTime()
    )
    .map((run) => ({
      run,
      order: createHash("sha256")
        .update(`${input.tenantId}\u0000${run.id}`)
        .digest("hex"),
    }))
    .sort((left, right) => left.order.localeCompare(right.order));
  const skipped: Partial<Record<LedgerReplaySkipReason, number>> = {};
  const tasks: LedgerReplayTask[] = [];
  let examined = 0;
  for (const { run } of candidates) {
    if (tasks.length >= input.limit) break;
    examined += 1;
    // Judge the row first, so a run that cannot qualify costs no event read.
    const runSkip = ledgerReplayRunSkip(run);
    const outcome = runSkip
      ? { skipped: runSkip }
      : ledgerReplayCase(run, summarizeLedgerReplayRun(await input.loadEvents(run.id)));
    if ("skipped" in outcome) {
      skipped[outcome.skipped] = (skipped[outcome.skipped] ?? 0) + 1;
    } else {
      tasks.push(outcome.task);
    }
  }
  return {
    version: 2,
    kind: "ledger_replay",
    schemaVersion: 1,
    description:
      "Golden tasks replayed from this workspace's own completed runs. Run them against a candidate deployment, not production: each task calls /api/agent and may consume provider capacity. The goals are the runs' own words, so keep the file private.",
    generatedAt: input.now.toISOString(),
    since: since.toISOString(),
    examined,
    skipped,
    tasks,
  };
}

function replayGoal(run: AgentRunRecord) {
  const [message, ...rest] = run.messages;
  if (!message || rest.length || message.role !== "user") return undefined;
  return message.content.trim();
}
