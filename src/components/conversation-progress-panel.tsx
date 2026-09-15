"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import {
  AlertTriangle,
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Square,
} from "lucide-react";
import { clsx } from "clsx";
import { startVisibleRefresh } from "@/lib/client/visible-refresh";

type JsonRecord = Record<string, unknown>;

type ProgressCategory =
  | "request"
  | "plan"
  | "context"
  | "agent"
  | "model"
  | "tool"
  | "browser"
  | "voice"
  | "approval"
  | "evidence"
  | "result"
  | "recovery";

type ProgressState =
  | "recorded"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

type ProgressItem = {
  id: string;
  source: "event" | "checkpoint";
  eventRef: string;
  category: ProgressCategory;
  state: ProgressState;
  title: string;
  summary: string;
  at: string;
  technical: {
    eventType: string;
    streamKind: string;
    sequence: number;
  };
  checkpoint?: {
    checkpointId: string;
    checkpointSha256: string;
    sequence: number;
    boundaryKind: string;
    boundaryPhase: string;
    lifecycleState: string;
    resumeDisposition: string;
  };
  action?: { kind: "approval" | "browser" | "checkpoint" | "result"; label: string };
};

export type ConversationProgress = {
  version: "p11.2-conversation-progress:1";
  runId: string;
  status: string;
  terminal: boolean;
  headline: string;
  summary: string;
  agent: {
    state: "unbound" | "definition_unavailable" | "ready";
    name?: string;
    role?: string;
    definitionVersion?: number;
  };
  context: {
    state: "not_recorded" | "recorded";
    usedCount: number;
    excludedCount: number;
    droppedCount: number;
  };
  result: {
    state: "pending" | "completed" | "failed" | "canceled";
    responseLength: number;
    groundingStatus?: string;
    citationCount: number;
  };
  recovery: {
    kind: "cancel" | "approval" | "clarification" | "retry" | "checkpoint" | "none";
    label: string;
    instruction: string;
  };
  items: ProgressItem[];
};

const categories: readonly ProgressCategory[] = [
  "request", "plan", "context", "agent", "model", "tool", "browser",
  "voice", "approval", "evidence", "result", "recovery",
];
const states: readonly ProgressState[] = [
  "recorded", "running", "waiting", "completed", "failed", "canceled",
];

export function ConversationProgressPanel({
  runId,
  live,
  canCancel,
  onCancel,
  onOpenBrowser,
}: {
  runId: string;
  live: boolean;
  canCancel: boolean;
  onCancel: () => void;
  onOpenBrowser: () => void;
}) {
  const [progress, setProgress] = useState<ConversationProgress>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [refreshVersion, setRefreshVersion] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let firstLoad = true;
    const load = async (showLoading: boolean) => {
      if (showLoading) setState("loading");
      try {
        const response = await fetch(
          `/api/runs/${encodeURIComponent(runId)}/trajectory`,
          { cache: "no-store", signal: controller.signal },
        );
        const payload = asRecord(await response.json().catch(() => ({})));
        if (!response.ok) {
          throw new Error(stringValue(payload.error, "Conversation activity could not be loaded."));
        }
        const parsed = parseConversationProgress(payload.conversationProgress);
        if (!parsed) throw new Error("Conversation activity returned an unsupported contract.");
        if (controller.signal.aborted) return;
        setProgress(parsed);
        setError(undefined);
        setState("ready");
      } catch (loadError) {
        if (controller.signal.aborted) return;
        setError(loadError instanceof Error ? loadError.message : "Conversation activity could not be loaded.");
        setState("error");
      }
    };
    const stopRefresh = live
      ? startVisibleRefresh({
          onRefresh: () => {
            const showLoading = firstLoad;
            firstLoad = false;
            return load(showLoading);
          },
          pollIntervalMs: 4_000,
          refreshOnStart: true,
        })
      : undefined;
    if (!live) void load(true);
    return () => {
      stopRefresh?.();
      controller.abort();
    };
  }, [live, refreshVersion, runId]);

  if (state === "loading" && !progress) {
    return (
      <section className="mb-4 rounded-md border border-line bg-background p-4" aria-label="Conversation progress">
        <p className="flex items-center gap-2 text-sm text-muted" role="status">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" /> Loading durable progress…
        </p>
      </section>
    );
  }

  if (state === "error" && !progress) {
    return (
      <section className="mb-4 rounded-md border border-warning/40 bg-warning/10 p-4" aria-label="Conversation progress">
        <p className="text-sm font-semibold">Activity is temporarily unavailable</p>
        <p className="mt-1 text-xs leading-5 text-muted">{error} The answer remains in the conversation; retry this owner-scoped read.</p>
        <button type="button" onClick={() => setRefreshVersion((value) => value + 1)} className="action-button mt-3">
          <RefreshCw size={13} aria-hidden="true" /> Retry
        </button>
      </section>
    );
  }

  if (!progress) return null;
  const ResultIcon = progress.result.state === "completed"
    ? Check
    : progress.result.state === "pending"
      ? CircleDot
      : AlertTriangle;

  return (
    <section className="mb-4 overflow-hidden rounded-md border border-line bg-background" aria-label="Conversation progress" data-testid="conversation-progress">
      <header className="border-b border-line px-3 py-3 sm:px-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-semibold">{progress.headline}</p>
              <ProgressStatePill state={progress.terminal ? progress.result.state : progress.status} />
            </div>
            <p className="mt-1 max-w-3xl text-xs leading-5 text-muted">{progress.summary}</p>
          </div>
          <button
            type="button"
            onClick={() => setRefreshVersion((value) => value + 1)}
            disabled={state === "loading"}
            className="inline-flex min-h-9 shrink-0 items-center gap-2 rounded-full px-3 text-xs font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground disabled:opacity-50"
          >
            <RefreshCw size={13} className={state === "loading" ? "animate-spin" : ""} aria-hidden="true" />
            Refresh
          </button>
        </div>
        {error ? <p className="mt-2 text-xs text-warning" role="status">Refresh failed; showing the last durable projection.</p> : null}
      </header>

      <div className="grid gap-px border-b border-line bg-line sm:grid-cols-3">
        <ProgressFact
          icon={Bot}
          label="Agent"
          value={progress.agent.state === "ready"
            ? `${progress.agent.name} · ${progress.agent.role}`
            : progress.agent.state === "unbound"
              ? "Legacy run · identity unbound"
              : "Pinned identity unavailable"}
          detail={progress.agent.definitionVersion ? `Definition v${progress.agent.definitionVersion}` : "Authority is not inferred from presentation."}
        />
        <ProgressFact
          icon={ShieldCheck}
          label="Context"
          value={progress.context.state === "recorded" ? `${progress.context.usedCount} used` : "No receipt recorded"}
          detail={`${progress.context.excludedCount} excluded · ${progress.context.droppedCount} dropped`}
        />
        <ProgressFact
          icon={ResultIcon}
          label="Result"
          value={progress.result.state}
          detail={progress.result.state === "completed"
            ? `${progress.result.citationCount} citation${progress.result.citationCount === 1 ? "" : "s"} · ${progress.result.groundingStatus || "grounding not recorded"}`
            : "No completed outcome is implied."}
        />
      </div>

      <div className={clsx(
        "flex flex-col gap-3 border-b border-line px-3 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-4",
        progress.recovery.kind === "none" ? "bg-success/5" : "bg-warning/5",
      )}>
        <div className="flex min-w-0 items-start gap-3">
          <RotateCcw size={15} className={clsx("mt-0.5 shrink-0", progress.recovery.kind === "none" ? "text-success" : "text-warning")} aria-hidden="true" />
          <div>
            <p className="text-xs font-semibold">{progress.recovery.label}</p>
            <p className="mt-0.5 text-xs leading-5 text-muted">{progress.recovery.instruction}</p>
          </div>
        </div>
        {progress.recovery.kind === "approval" ? (
          <Link href="/app/approvals" className="primary-button shrink-0">Review approval</Link>
        ) : progress.recovery.kind === "cancel" && canCancel ? (
          <button type="button" onClick={onCancel} className="action-button shrink-0 border-danger/40 text-danger">
            <Square size={12} aria-hidden="true" /> Stop run
          </button>
        ) : null}
      </div>

      {progress.items.length ? (
        <ol className="divide-y divide-line">
          {progress.items.map((item) => (
            <li key={item.id} className="px-3 py-3 sm:px-4">
              <div className="flex items-start gap-3">
                <span className={clsx("mt-1.5 size-2.5 shrink-0 rounded-full", progressDot(item.state))} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold">{item.title}</p>
                      <p className="mt-1 text-xs leading-5 text-muted">{item.summary}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-surface-raised px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
                      {item.category}
                    </span>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <time className="text-[11px] text-muted" dateTime={item.at}>{relativeTime(item.at)}</time>
                    {item.action?.kind === "approval" ? (
                      <Link href="/app/approvals" className="inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-primary">
                        Review <ChevronRight size={12} aria-hidden="true" />
                      </Link>
                    ) : item.action?.kind === "browser" ? (
                      <button type="button" onClick={onOpenBrowser} className="inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-primary">
                        Browser evidence <ChevronRight size={12} aria-hidden="true" />
                      </button>
                    ) : item.action?.kind === "result" ? (
                      <Link href={`/app/results?run=${encodeURIComponent(`agent:${runId}`)}`} className="inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-primary">
                        Result evidence <ChevronRight size={12} aria-hidden="true" />
                      </Link>
                    ) : null}
                  </div>
                  <details className="mt-1 text-[11px] text-muted">
                    <summary className="min-h-8 cursor-pointer py-1 font-medium">Technical receipt</summary>
                    <dl className="grid gap-x-4 gap-y-1 rounded-md bg-surface px-3 py-2 font-mono sm:grid-cols-[8rem_1fr]">
                      <dt>event</dt><dd className="break-all">{item.eventRef}</dd>
                      <dt>type</dt><dd>{item.technical.eventType}</dd>
                      <dt>stream</dt><dd>{item.technical.streamKind} · sequence {item.technical.sequence}</dd>
                      {item.checkpoint ? (
                        <>
                          <dt>checkpoint</dt><dd className="break-all">{item.checkpoint.checkpointId}</dd>
                          <dt>boundary</dt><dd>{item.checkpoint.boundaryKind} · {item.checkpoint.boundaryPhase} · {item.checkpoint.resumeDisposition}</dd>
                        </>
                      ) : null}
                    </dl>
                  </details>
                </div>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="p-4 text-sm leading-6 text-muted">No progress item is shown until a real event or checkpoint has been durably recorded.</p>
      )}
      <p className="border-t border-line px-3 py-2 text-[11px] leading-5 text-muted sm:px-4">
        {progress.items.length} durable progress item{progress.items.length === 1 ? "" : "s"}. Event references are hashed; prompts, tool payloads, credentials, outputs, and private reasoning are excluded.
      </p>
    </section>
  );
}

function ProgressFact({
  icon: Icon,
  label,
  value,
  detail,
}: {
  icon: typeof Bot;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="min-w-0 bg-background px-3 py-3 sm:px-4">
      <p className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted"><Icon size={13} aria-hidden="true" /> {label}</p>
      <p className="mt-2 truncate text-xs font-semibold capitalize">{value}</p>
      <p className="mt-1 truncate text-[11px] text-muted">{detail}</p>
    </div>
  );
}

function ProgressStatePill({ state }: { state: string }) {
  const normalized = state.replaceAll("_", " ");
  const tone = state === "completed"
    ? "bg-success/10 text-success"
    : state === "failed" || state === "canceled"
      ? "bg-danger/10 text-danger"
      : state.includes("waiting")
        ? "bg-warning/10 text-warning"
        : "bg-primary/10 text-primary";
  return <span className={clsx("rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.1em]", tone)}>{normalized}</span>;
}

export function parseConversationProgress(value: unknown): ConversationProgress | undefined {
  const record = asRecord(value);
  if (
    record.version !== "p11.2-conversation-progress:1" ||
    !stringValue(record.runId) ||
    !stringValue(record.status) ||
    !stringValue(record.headline)
  ) return undefined;
  const agent = asRecord(record.agent);
  const context = asRecord(record.context);
  const result = asRecord(record.result);
  const recovery = asRecord(record.recovery);
  const agentState = stringValue(agent.state);
  const contextState = stringValue(context.state);
  const resultState = stringValue(result.state);
  const recoveryKind = stringValue(recovery.kind);
  if (
    !["unbound", "definition_unavailable", "ready"].includes(agentState) ||
    !["not_recorded", "recorded"].includes(contextState) ||
    !["pending", "completed", "failed", "canceled"].includes(resultState) ||
    !["cancel", "approval", "clarification", "retry", "checkpoint", "none"].includes(recoveryKind)
  ) return undefined;
  return {
    version: "p11.2-conversation-progress:1",
    runId: stringValue(record.runId),
    status: stringValue(record.status),
    terminal: record.terminal === true,
    headline: stringValue(record.headline),
    summary: stringValue(record.summary),
    agent: {
      state: agentState as ConversationProgress["agent"]["state"],
      name: safeDisplayText(agent.name),
      role: safeDisplayText(agent.role),
      definitionVersion: safeCount(agent.definitionVersion),
    },
    context: {
      state: contextState as ConversationProgress["context"]["state"],
      usedCount: safeCount(context.usedCount) || 0,
      excludedCount: safeCount(context.excludedCount) || 0,
      droppedCount: safeCount(context.droppedCount) || 0,
    },
    result: {
      state: resultState as ConversationProgress["result"]["state"],
      responseLength: safeCount(result.responseLength) || 0,
      groundingStatus: safeDisplayText(result.groundingStatus),
      citationCount: safeCount(result.citationCount) || 0,
    },
    recovery: {
      kind: recoveryKind as ConversationProgress["recovery"]["kind"],
      label: safeDisplayText(recovery.label) || "Recovery status",
      instruction: safeDisplayText(recovery.instruction) || "Review the durable activity before continuing.",
    },
    items: Array.isArray(record.items)
      ? record.items.slice(0, 120).map(asRecord).flatMap(parseProgressItem)
      : [],
  };
}

function parseProgressItem(record: JsonRecord): ProgressItem[] {
  const category = stringValue(record.category);
  const state = stringValue(record.state);
  const source = stringValue(record.source);
  const eventRef = stringValue(record.eventRef);
  const technical = asRecord(record.technical);
  if (
    !categories.includes(category as ProgressCategory) ||
    !states.includes(state as ProgressState) ||
    (source !== "event" && source !== "checkpoint") ||
    !/^[a-f0-9]{64}$/.test(eventRef) ||
    !stringValue(record.id) ||
    !stringValue(record.at) ||
    !stringValue(technical.eventType)
  ) return [];
  const checkpointRecord = asRecord(record.checkpoint);
  const checkpoint = source === "checkpoint" && stringValue(checkpointRecord.checkpointId)
    ? {
        checkpointId: stringValue(checkpointRecord.checkpointId),
        checkpointSha256: stringValue(checkpointRecord.checkpointSha256),
        sequence: safeCount(checkpointRecord.sequence) || 0,
        boundaryKind: stringValue(checkpointRecord.boundaryKind),
        boundaryPhase: stringValue(checkpointRecord.boundaryPhase),
        lifecycleState: stringValue(checkpointRecord.lifecycleState),
        resumeDisposition: stringValue(checkpointRecord.resumeDisposition),
      }
    : undefined;
  if (source === "checkpoint" && !checkpoint) return [];
  const actionRecord = asRecord(record.action);
  const actionKind = stringValue(actionRecord.kind);
  const action = ["approval", "browser", "checkpoint", "result"].includes(actionKind)
    ? { kind: actionKind as NonNullable<ProgressItem["action"]>["kind"], label: safeDisplayText(actionRecord.label) || "Open" }
    : undefined;
  return [{
    id: stringValue(record.id),
    source,
    eventRef,
    category: category as ProgressCategory,
    state: state as ProgressState,
    title: safeDisplayText(record.title) || "Progress recorded",
    summary: safeDisplayText(record.summary) || "A durable event was recorded.",
    at: stringValue(record.at),
    technical: {
      eventType: stringValue(technical.eventType),
      streamKind: stringValue(technical.streamKind, "event"),
      sequence: safeCount(technical.sequence) || 0,
    },
    checkpoint,
    action,
  }];
}

function progressDot(state: ProgressState) {
  if (state === "completed") return "bg-success";
  if (state === "failed" || state === "canceled") return "bg-danger";
  if (state === "waiting") return "bg-warning";
  return "bg-primary";
}

function relativeTime(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "Time unavailable";
  const delta = Date.now() - timestamp;
  if (Math.abs(delta) < 60_000) return "Just now";
  const minutes = Math.round(Math.abs(delta) / 60_000);
  if (minutes < 60) return `${minutes}m ${delta >= 0 ? "ago" : "from now"}`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ${delta >= 0 ? "ago" : "from now"}`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

function safeDisplayText(value: unknown) {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 500) : undefined;
}

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}
