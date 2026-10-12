"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUpRight, Bell, CheckCircle2, CircleAlert, Clock3, Loader2, MessageSquare, RefreshCw } from "lucide-react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { ACTIVITY_PAGE_LIMIT as PAGE_LIMIT, validActivityResponse } from "@/components/activity-response";
import {
  ACTIVITY_GROUPS,
  ACTIVITY_SOURCE_LIMIT,
  type ActivityCoverage,
  type ActivityFilter,
  type ActivityItem,
  type ActivityResponse,
  type ActivitySource,
} from "@/lib/activity/contracts";
import styles from "./activity-workspace.module.css";

const sources: ActivitySource[] = ["runs", "approvals", "notifications"];
const labels: Record<ActivityFilter, string> = {
  all: "All updates", working: "Working", needs_you: "Needs you", updates: "Reminders", history: "Finished",
};
const sourceLabels: Record<ActivitySource, string> = {
  runs: "Assistant tasks", approvals: "Approvals", notifications: "Reminders and updates",
};
type Snapshot = { response: ActivityResponse; cursors: (string | null)[]; index: number };
type ReadRequest = {
  group: ActivityFilter;
  cursors: (string | null)[];
  index: number;
  kind: "initial" | "refresh" | "filter" | "page";
  trigger?: HTMLElement;
};

export function ActivityWorkspace({ embedded = false }: { embedded?: boolean }) {
  const { session, status, refresh } = useWorkspaceSession();
  const disabledReason = permissionMessage(session, status, "read");
  const scope = JSON.stringify([
    session?.context?.tenantId, session?.context?.actorId,
    session?.membership?.role ?? session?.context?.role,
    session?.authEnabled, session?.authenticated,
  ]);

  if (disabledReason) {
    return <section className={`${styles.shell} ${embedded ? styles.embedded : ""}`} aria-labelledby="activity-title">
      <header className={styles.header}><div><h2 id="activity-title">Timeline</h2>
        <p>Work in progress, decisions and updates from your workspace.</p></div></header>
      <div className={styles.empty} role="status"><h2>Activity is unavailable</h2><p>{disabledReason}</p></div>
      <button className={styles.button} type="button" disabled={status === "loading"} onClick={() => void refresh()}>
        Check workspace access
      </button>
    </section>;
  }
  return <ScopedActivityWorkspace key={scope} embedded={embedded} />;
}

function ScopedActivityWorkspace({ embedded }: { embedded: boolean }) {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [pending, setPending] = useState<ReadRequest>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [selectedItemId, setSelectedItemId] = useState<string>();
  const activeRead = useRef<AbortController | null>(null);
  const readVersion = useRef(0);
  const mounted = useRef(false);
  const lastSnapshot = useRef<Snapshot | undefined>(undefined);
  const focusAfterRead = useRef<HTMLElement | undefined>(undefined);
  const resultsHeading = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (request: ReadRequest) => {
    const version = ++readVersion.current;
    activeRead.current?.abort();
    const controller = new AbortController();
    activeRead.current = controller;
    const current = () => mounted.current && readVersion.current === version && !controller.signal.aborted;
    setPending(request);
    setError(undefined);
    setNotice(undefined);
    focusAfterRead.current = undefined;
    let cursorRestart = false;
    try {
      let target = request;
      const read = async () => {
        const params = new URLSearchParams({ group: target.group, limit: String(PAGE_LIMIT) });
        const cursor = target.cursors[target.index];
        if (cursor) params.set("cursor", cursor);
        const response = await fetch(`/api/activity?${params}`, {
          headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal,
        });
        const body: unknown = await response.json();
        return { response, body };
      };
      let result = await read();
      if (!current()) return;
      if (result.response.status === 409 && isRecord(result.body) &&
        result.body.code === "activity_cursor_stale" && result.body.reload === true) {
        cursorRestart = true;
        setNotice("Activity changed while you were paging. Checking a new window; the last loaded rows remain below.");
        target = { ...request, cursors: [null], index: 0 };
        result = await read();
        if (!current()) return;
      }
      if (!result.response.ok) throw new Error(readError(result.body, result.response.status));
      if (!validActivityResponse(result.body, target.group)) throw new Error("Activity returned an incomplete response. Refresh to try again.");
      if (result.body.state === "unavailable" && lastSnapshot.current?.response.state !== "unavailable" && lastSnapshot.current) {
        throw new Error("All Activity sources are unavailable. The last loaded rows and counts are retained.");
      }
      const next: Snapshot = { response: result.body, cursors: target.index === 0 ? [null] : target.cursors, index: target.index };
      lastSnapshot.current = next;
      focusAfterRead.current = request.kind === "page" ? request.trigger : undefined;
      setSnapshot(next);
      setNotice(cursorRestart ? "Activity changed while you were paging. A new window is shown from its first page." : undefined);
    } catch (readFailure) {
      if (!current()) return;
      const detail = readFailure instanceof Error ? readFailure.message : "Activity could not be checked.";
      setError(cursorRestart ? `The previous window expired and its replacement could not be loaded. ${detail}` : detail);
      setNotice(undefined);
    } finally {
      if (current()) {
        activeRead.current = null;
        setPending(undefined);
      }
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const timer = window.setTimeout(() => void load({ group: "all", cursors: [null], index: 0, kind: "initial" }), 0);
    return () => {
      mounted.current = false;
      readVersion.current += 1;
      window.clearTimeout(timer);
      activeRead.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const trigger = focusAfterRead.current;
    focusAfterRead.current = undefined;
    if (trigger && (document.activeElement === trigger || document.activeElement === document.body)) {
      resultsHeading.current?.focus();
    }
  }, [snapshot]);

  const data = snapshot?.response;
  const known = Boolean(data && data.state !== "unavailable");
  const stale = Boolean(data && (pending || error));
  const selectedGroup = pending?.group ?? data?.group ?? "all";
  const shownGroup = data?.group ?? "all";
  const populatedGroups = ACTIVITY_GROUPS.filter((group) => (data?.counts[group] ?? 0) > 0);
  const total = data ? (shownGroup === "all" ? sumCounts(data) : data.counts[shownGroup]) : 0;
  const start = data?.items.length && snapshot ? snapshot.index * PAGE_LIMIT + 1 : 0;
  const end = start && data ? start + data.items.length - 1 : 0;
  const statusText = pending
    ? `Checking ${labels[pending.group].toLowerCase()}.${data ? ` Last loaded ${labels[shownGroup].toLowerCase()} remains below.` : ""}`
    : error ? `Activity could not be ${known ? "refreshed" : "loaded"}.${known ? " Last loaded rows and counts are shown." : " Counts are unavailable."}`
    : data?.state === "unavailable" ? "Activity sources are unavailable. Counts could not be checked."
    : data ? `${data.items.length} recent updates shown.${data.state === "partial" ? " Some activity could not be loaded." : ""}`
    : "Checking activity.";

  const refresh = () => void load({ group: shownGroup, cursors: [null], index: 0, kind: "refresh" });
  return <section className={`${styles.shell} ${embedded ? styles.embedded : ""}`} aria-labelledby="activity-title" data-testid="activity-workspace">
    <header className={styles.header}>
      <div className={styles.introduction}>
        <h2 id="activity-title">Timeline</h2>
        <p>Tasks, decisions, and reminders, in the order they happened.</p>
        <p className={styles.timestamp}>{data
          ? <>{stale ? "Last checked" : "Updated"} <time dateTime={data.generatedAt}>{formatTime(data.generatedAt)}</time></>
          : "Checking your activity…"}</p>
      </div>
      <button className={styles.button} type="button" onClick={refresh} disabled={Boolean(pending)}>
        <RefreshCw size={15} aria-hidden="true" />{pending?.kind === "refresh" ? "Refreshing…" : "Refresh"}
      </button>
    </header>

    {!known || shownGroup !== "all" || populatedGroups.length > 1 ? <div className={styles.filters} role="group" aria-label="Filter timeline">
      {(["all", "needs_you", "working", "updates", "history"] as ActivityFilter[]).filter((group) =>
        group === "all" || group === selectedGroup || !known || (data?.counts[group] ?? 0) > 0,
      ).map((group) => <button type="button" key={group}
        className={styles.filter} aria-pressed={selectedGroup === group}
        onClick={() => void load({ group, cursors: [null], index: 0, kind: "filter" })}>
        <span>{labels[group]}</span><span className={styles.count}>{known && data
          ? (group === "all" ? sumCounts(data) : data.counts[group]).toLocaleString()
          : "—"}</span>
      </button>)}
    </div> : null}

    <p className={pending || error || data?.state === "partial" ? styles.readStatus : "sr-only"} role="status" aria-live="polite" aria-atomic="true">{statusText}</p>
    {error ? <div className={styles.error}>
      <p>{error}</p>
      {known ? <p>The retained records describe the previous window and may have changed.</p> : null}
      <button className={styles.button} type="button" onClick={refresh} disabled={Boolean(pending)}>Retry activity</button>
    </div> : null}
    {notice ? <p className={styles.notice}>{notice}</p> : null}
    <section className={styles.results} aria-labelledby="activity-results-title" aria-busy={Boolean(pending)}>
      <div className={styles.resultsHeader}>
        <h2 id="activity-results-title" tabIndex={-1} ref={resultsHeading}>{labels[shownGroup]}</h2>
        {known && total > 0 ? <p>{stale ? "Last loaded · " : ""}{start}–{end} of {total.toLocaleString()} recent updates</p> : null}
      </div>
      {!data && !error ? <div className={styles.empty}><h3>Checking activity</h3><p>Loading the records you can access.</p></div>
        : !known ? <div className={styles.empty}><h3>Activity is unavailable</h3><p>Refresh to check your recent work again.</p></div>
        : !data?.items.length ? <div className={styles.empty}><h3>No recent {shownGroup === "all" ? "activity" : labels[shownGroup].toLowerCase()}</h3>
          <p>{data?.state === "partial" ? "Some activity could not be checked. Refresh to try again." : "New tasks, decisions, and updates will appear here."}</p></div>
        : (["needs_you", "working", "updates", "history"] as const).filter((group) => data.items.some((item) => item.group === group)).map((group, _index, visibleGroups) => <section
          key={group} className={styles.group} aria-labelledby={`activity-group-${group}`}>
          <h3 id={`activity-group-${group}`} className={shownGroup === group || visibleGroups.length === 1 ? "sr-only" : undefined}>{labels[group]}</h3>
          <ol className={styles.list}>
            {data.items.filter((item) => item.group === group).map((item) => <li key={item.id}><ActivityRow item={item}
              selected={selectedItemId === item.id} onSelect={() => setSelectedItemId((current) => current === item.id ? undefined : item.id)} /></li>)}
          </ol>
        </section>)}
    </section>
    {known && snapshot && data && (data.page.hasMore || snapshot.index > 0) ? <nav className={styles.pager} aria-label="Activity pages">
      <p>Page {snapshot.index + 1}</p>
      <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={Boolean(pending) || snapshot.index === 0}
          onClick={(event) => void load({ group: shownGroup, cursors: snapshot.cursors, index: snapshot.index - 1, kind: "page", trigger: event.currentTarget })}>Previous</button>
        <button type="button" className={styles.button} disabled={Boolean(pending) || !data.page.hasMore}
          onClick={(event) => void load({ group: shownGroup, cursors: [...snapshot.cursors.slice(0, snapshot.index + 1), data.page.nextCursor], index: snapshot.index + 1, kind: "page", trigger: event.currentTarget })}>Next</button>
      </div>
    </nav> : null}
    {data ? <SourceCoverage response={data} stale={stale} /> : null}
  </section>;
}

function SourceCoverage({ response, stale }: { response: ActivityResponse; stale: boolean }) {
  return <details className={styles.coverage}>
    <summary>{response.state === "partial" ? "Some activity is unavailable" : response.state === "unavailable" ? "Activity could not be checked" : "About this activity list"}{stale ? " · last checked" : ""}</summary>
    <dl>{sources.filter((source) => response.coverage[source].visibleCount !== 0 || response.coverage[source].state !== "ready").map((source) => {
      const coverage = response.coverage[source];
      return <div key={source}><dt>{sourceLabels[source]}</dt><dd>
        <strong>{coverageLabel(coverage)}</strong>
        <span>{coverage.visibleCount === null ? "Count unavailable." : `${coverage.visibleCount.toLocaleString()} readable records within the ${coverage.limit}-record source limit.`}</span>
      </dd></div>;
    })}</dl>
    <p>Includes up to {ACTIVITY_SOURCE_LIMIT} recent records per source that you can access. Older activity may not appear. Refresh to check for changes.</p>
  </details>;
}

function ActivityRow({ item, selected, onSelect }: { item: ActivityItem; selected: boolean; onSelect: () => void }) {
  const destination = item.source === "approvals" ? "Review action" : item.source === "runs" ? "Open conversation" : item.href.startsWith("/app/responsibilities/") ? "View update" : "Open reminder";
  const state = activityState(item);
  const summary = activitySummary(item);
  const showReferences = item.source === "runs" ? selected
    : Boolean(item.sourceRef.approvalKind || item.origin || item.references.length > 1);
  const Icon = state.tone === "danger" || state.tone === "warning" ? CircleAlert : state.tone === "success" ? CheckCircle2
    : item.source === "notifications" ? Bell : item.group === "working" ? Clock3 : MessageSquare;
  return <article className={styles.row} aria-label={`${activityTitle(item)}: ${state.label}`}>
    <Icon size={18} className={styles.rowIcon} data-tone={state.tone} aria-hidden="true" />
    <div className={styles.rowContent}>
      <div className={styles.rowHeading}><h4>{activityTitle(item)}</h4><span className={styles.status} data-tone={state.tone}>{state.label}</span></div>
      {summary.trim() ? <p>{summary}</p> : null}
      <div className={styles.rowMeta}>
        <time dateTime={item.timestamp.at} title={formatTime(item.timestamp.at)}>{item.timestamp.basis === "completed" ? "Finished" : startCase(item.timestamp.basis)} {shortTime(item.timestamp.at)}</time>
        {item.source === "runs" ? <button type="button" onClick={onSelect} aria-expanded={selected} className={styles.detailButton}>{selected ? "Hide details" : state.tone === "danger" ? "View failure" : "View task"}</button> : null}
        <Link className={styles.originLink} href={item.href} prefetch={false}>{destination}<ArrowUpRight size={13} aria-hidden="true" /></Link>
        {item.origin && item.origin.href !== item.href ? <Link className={styles.originLink} href={item.origin.href} prefetch={false}>Open conversation</Link> : null}
      </div>
      {selected && item.source === "runs" ? <ActivityRunPreview key={`${item.sourceRef.id}:${item.timestamp.at}`} runId={item.sourceRef.id} /> : null}
      {showReferences ? <details className={styles.references}><summary>Technical details</summary><dl>
        <div><dt>Activity ID</dt><dd><code>{item.id}</code></dd></div>
        <div><dt>Work identity</dt><dd><code>{item.workKey}</code></dd></div>
        <div><dt>Source state</dt><dd><code>{item.status}</code></dd></div>
        {item.sourceRef.approvalKind ? <div><dt>Approval type</dt><dd>{startCase(item.sourceRef.approvalKind)}</dd></div> : null}
        {item.origin?.threadId ? <div><dt>Conversation ID</dt><dd><code>{item.origin.threadId}</code></dd></div> : null}
        {item.references.map((reference) => <div key={`${reference.kind}:${reference.approvalKind ?? ""}:${reference.id}`}>
          <dt>{startCase(reference.kind)} reference</dt><dd><code>{reference.id}</code></dd>
        </div>)}
      </dl></details> : null}
    </div>
  </article>;
}

type RunPreview = { prompt: string; response: string; error: string; duration?: string };

/** Only the explicitly selected task is read; closing it discards its content. */
function ActivityRunPreview({ runId }: { runId: string }) {
  const [preview, setPreview] = useState<RunPreview>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setPreview(undefined);
    setError(undefined);
    void (async () => {
      try {
        const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`, {
          headers: { accept: "application/json" }, cache: "no-store", signal: controller.signal,
        });
        const body: unknown = await response.json();
        if (!response.ok) throw new Error(response.status === 403 || response.status === 401
          ? "You no longer have access to this task."
          : response.status === 404 ? "This task is no longer available." : "Task details could not be loaded. Try again.");
        if (!isRecord(body) || !isRecord(body.run) || body.run.id !== runId) throw new Error("The task details could not be confirmed. Try again.");
        const run = body.run;
        const started = typeof run.startedAt === "string" ? Date.parse(run.startedAt) : Number.NaN;
        const completed = typeof run.completedAt === "string" ? Date.parse(run.completedAt) : Number.NaN;
        if (!controller.signal.aborted) setPreview({
          prompt: previewText(run.prompt, 1_200), response: previewText(run.response, 3_000), error: previewText(run.error, 1_500),
          ...(Number.isFinite(started) && Number.isFinite(completed) && completed >= started
            ? { duration: elapsedTime(completed - started) } : {}),
        });
      } catch (failure) {
        if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Task details could not be loaded.");
      }
    })();
    return () => controller.abort();
  }, [runId, attempt]);
  return <section className={styles.preview} aria-label="Task details" aria-busy={!preview && !error}>
    {!preview && !error ? <p className={styles.previewLoading}><Loader2 size={14} aria-hidden="true" />Loading task details…</p> : null}
    {error ? <div role="status"><p>{error}</p><button type="button" className={styles.detailButton} onClick={() => setAttempt((value) => value + 1)}>Try again</button></div> : null}
    {preview?.prompt ? <div><h5>Your task</h5><p>{preview.prompt}</p></div> : null}
    {preview?.error ? <div className={styles.failure}><h5>What went wrong</h5><p>{preview.error}</p></div> : null}
    {preview?.response ? <div><h5>{preview.error ? "Partial response" : "Response"}</h5><p>{preview.response}</p></div> : null}
    {preview?.duration ? <p className={styles.duration}>Time taken: {preview.duration}</p> : null}
    {preview && !preview.prompt && !preview.response && !preview.error ? <p>No task text is available here. Open the conversation for its current status.</p> : null}
  </section>;
}

function activityTitle(item: ActivityItem) {
  if (item.title === "Tool approval") return "Review a proposed action";
  if (item.title === "Workflow approval") return "Review a proposed plan";
  if (item.title !== "Agent run") return item.title;
  if (item.status === "completed") return "Assistant response completed";
  if (item.status === "failed") return "Assistant task failed";
  if (item.status === "canceled") return "Assistant task stopped";
  if (item.status === "waiting_approval") return "Assistant needs your approval";
  if (item.status === "waiting_clarification") return "Assistant has a question";
  return item.status === "queued" ? "Assistant task queued" : "Assistant is working";
}

function activityState(item: ActivityItem): { label: string; tone: "neutral" | "success" | "warning" | "danger" } {
  const canonical = item.canonicalStatus?.status;
  if (canonical === "failed" || item.status === "failed") return { label: "Failed", tone: "danger" };
  if (item.status === "reconciliation_required") return { label: "Action outcome needs review", tone: "warning" };
  if (canonical === "unverified") return { label: "Needs verification", tone: "warning" };
  if (canonical === "partial") return { label: "Partly complete", tone: "warning" };
  if (canonical === "succeeded") return { label: "Verified complete", tone: "success" };
  if (canonical === "blocked") return { label: "Blocked", tone: "warning" };
  if (canonical === "preview") return { label: "Preview only", tone: "neutral" };
  const friendly: Record<string, string> = {
    queued: "Queued", running: "In progress", resuming: "Continuing", completed: "Completed",
    canceled: "Stopped", waiting_approval: "Approval needed", approval_required: "Approval needed",
    pending: "Decision needed", waiting_clarification: "Reply needed", unread: "New", read: "Read",
    snoozed: "Snoozed", dismissed: "Dismissed", acted: "Action recorded",
  };
  return { label: friendly[item.status] || "Status available", tone: item.group === "needs_you" ? "warning" : "neutral" };
}

function activitySummary(item: ActivityItem) {
  const copy: Record<string, string> = {
    // These fixed summaries repeat the visible action and outcome labels.
    // Specific failure text and unfamiliar summaries remain visible.
    "Queued to start.": "",
    "The run is in progress.": "",
    "The run is resuming.": "",
    "Waiting for an approval decision.": "",
    "Waiting for clarification in the conversation.": "",
    "The run failed. Open its source to inspect the result.": "",
    "The terminal receipt reports a failed outcome.": "",
    "The run completed; its outcome has not been verified.": "",
    "The run ended; its outcome has not been verified.": "",
    "The run completed with a verified outcome.": "",
    "The run ended with a partial outcome. Open its source to inspect what remains.": "",
    "The run was canceled.": "",
    "The terminal receipt reports a canceled outcome.": "",
    "A decision is waiting in the approvals inbox.": "",
    "An approved action needs reconciliation. Open the approval to inspect its receipt.": "The result of an approved action is uncertain. Review it before trying again.",
  };
  return copy[item.summary] ?? item.summary;
}

function previewText(value: unknown, limit: number) {
  if (typeof value !== "string") return "";
  const text = value.trim().replace(/\[(?:(?:knowledge|memory|web|graph):[^\]\s]+|(?:csm|evidence_unit)_[a-zA-Z0-9_-]+)\]/g, "[source reference]");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function elapsedTime(milliseconds: number) {
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${seconds % 60}s` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
function shortTime(value: string) {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  const day = date.toDateString() === today.toDateString() ? "today" : date.toDateString() === yesterday.toDateString() ? "yesterday" : date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) });
  return `${day} at ${date.toLocaleTimeString(undefined, { timeStyle: "short" })}`;
}

function coverageLabel(coverage: ActivityCoverage) {
  if (coverage.state === "restricted") return "Access is restricted.";
  if (coverage.state === "unavailable") return "Source could not be checked.";
  if (coverage.state === "partial") return "Some records could not be included.";
  return "Source checked.";
}
function sumCounts(response: ActivityResponse) { return ACTIVITY_GROUPS.reduce((sum, group) => sum + response.counts[group], 0); }
function startCase(value: string) { return value.replace(/_/g, " ").replace(/^./, (character) => character.toUpperCase()); }
function formatTime(value: string) {
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function readError(value: unknown, status: number) {
  if (status === 401 || status === 403) return "Your access to Activity could not be verified. Check workspace access and try again.";
  return isRecord(value) && text(value.error) ? value.error : `Activity could not be checked (response ${status}).`;
}
