"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
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
  all: "All activity", working: "Working", needs_you: "Needs you", updates: "Updates", history: "History",
};
const sourceLabels: Record<ActivitySource, string> = {
  runs: "Your runs", approvals: "Authorized approvals", notifications: "Your reminders",
};
type Snapshot = { response: ActivityResponse; cursors: (string | null)[]; index: number };
type ReadRequest = {
  group: ActivityFilter;
  cursors: (string | null)[];
  index: number;
  kind: "initial" | "refresh" | "filter" | "page";
  trigger?: HTMLElement;
};

export function ActivityWorkspace() {
  const { session, status, refresh } = useWorkspaceSession();
  const disabledReason = permissionMessage(session, status, "read");
  const scope = JSON.stringify([
    session?.context?.tenantId, session?.context?.actorId,
    session?.membership?.role ?? session?.context?.role,
    session?.authEnabled, session?.authenticated,
  ]);

  if (disabledReason) {
    return <section className={styles.shell} aria-labelledby="activity-title">
      <header className={styles.header}><div><h1 id="activity-title">Activity</h1>
        <p>Work in progress, decisions and updates from your workspace.</p></div></header>
      <div className={styles.empty} role="status"><h2>Activity is unavailable</h2><p>{disabledReason}</p></div>
      <button className={styles.button} type="button" disabled={status === "loading"} onClick={() => void refresh()}>
        Check workspace access
      </button>
    </section>;
  }
  return <ScopedActivityWorkspace key={scope} />;
}

function ScopedActivityWorkspace() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [pending, setPending] = useState<ReadRequest>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
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
  const total = data ? (shownGroup === "all" ? sumCounts(data) : data.counts[shownGroup]) : 0;
  const start = data?.items.length && snapshot ? snapshot.index * PAGE_LIMIT + 1 : 0;
  const end = start && data ? start + data.items.length - 1 : 0;
  const statusText = pending
    ? `Checking ${labels[pending.group].toLowerCase()}.${data ? ` Last loaded ${labels[shownGroup].toLowerCase()} remains below.` : ""}`
    : error ? `Activity could not be ${known ? "refreshed" : "loaded"}.${known ? " Last loaded rows and counts are shown." : " Counts are unavailable."}`
    : data?.state === "unavailable" ? "Activity sources are unavailable. Counts could not be checked."
    : data ? `${data.items.length} ${data.items.length === 1 ? "record" : "records"} shown. ${data.state === "partial" ? "Some source coverage is incomplete." : "Current window loaded."}`
    : "Checking activity.";

  const refresh = () => void load({ group: shownGroup, cursors: [null], index: 0, kind: "refresh" });
  return <section className={styles.shell} aria-labelledby="activity-title" data-testid="activity-workspace">
    <header className={styles.header}>
      <div className={styles.introduction}>
        <h1 id="activity-title">Activity</h1>
        <p>Work in progress, decisions and updates from your workspace.</p>
        <p className={styles.timestamp}>{data
          ? <>{stale ? "Last loaded" : "Window checked"} <time dateTime={data.generatedAt}>{formatTime(data.generatedAt)}</time></>
          : "No activity window has been loaded."}</p>
      </div>
      <button className={styles.button} type="button" onClick={refresh} disabled={Boolean(pending)}>
        {pending?.kind === "refresh" ? "Refreshing activity…" : "Refresh activity"}
      </button>
    </header>

    <p id="activity-boundary" className={styles.boundary}>
      This view checks up to {ACTIVITY_SOURCE_LIMIT} recent records per source. Counts describe this readable window; older or inaccessible records may be absent. Open a source to inspect its details or take action.
    </p>
    <div className={styles.filters} role="group" aria-label="Activity views" aria-describedby="activity-boundary">
      {(["all", ...ACTIVITY_GROUPS] as ActivityFilter[]).map((group) => <button type="button" key={group}
        className={styles.filter} aria-pressed={selectedGroup === group}
        onClick={() => void load({ group, cursors: [null], index: 0, kind: "filter" })}>
        <span>{labels[group]}</span><span className={styles.count}>{known && data
          ? `${(group === "all" ? sumCounts(data) : data.counts[group]).toLocaleString()} in window`
          : "Count unavailable"}</span>
      </button>)}
    </div>

    <p className={styles.readStatus} role="status" aria-live="polite" aria-atomic="true">{statusText}</p>
    {error ? <div className={styles.error}>
      <p>{error}</p>
      {known ? <p>The retained records describe the previous window and may have changed.</p> : null}
      <button className={styles.button} type="button" onClick={refresh} disabled={Boolean(pending)}>Retry activity</button>
    </div> : null}
    {notice ? <p className={styles.notice}>{notice}</p> : null}
    {data ? <SourceCoverage response={data} stale={stale} /> : null}

    <section className={styles.results} aria-labelledby="activity-results-title" aria-busy={Boolean(pending)}>
      <div className={styles.resultsHeader}>
        <h2 id="activity-results-title" tabIndex={-1} ref={resultsHeading}>{labels[shownGroup]}</h2>
        <p>{known ? `${stale ? "Last loaded: " : ""}${start}–${end} of ${total.toLocaleString()} in this window` : "Count unavailable"}</p>
      </div>
      {!data && !error ? <div className={styles.empty}><h3>Checking activity</h3><p>Loading the records you can access.</p></div>
        : !known ? <div className={styles.empty}><h3>Activity is unavailable</h3><p>The source reads have not established whether any activity is available.</p></div>
        : !data?.items.length ? <div className={styles.empty}><h3>No {shownGroup === "all" ? "activity" : labels[shownGroup].toLowerCase()} in this window</h3>
          <p>{data?.state === "partial" ? "No matching records were returned by the readable sources. Incomplete sources may contain other activity." : "The checked sources returned no matching records within this bounded window."}</p></div>
        : ACTIVITY_GROUPS.filter((group) => data.items.some((item) => item.group === group)).map((group) => <section
          key={group} className={styles.group} aria-labelledby={`activity-group-${group}`}>
          <h3 id={`activity-group-${group}`}>{labels[group]}</h3>
          <ol className={styles.list}>
            {data.items.filter((item) => item.group === group).map((item) => <li key={item.id}><ActivityRow item={item} /></li>)}
          </ol>
        </section>)}
    </section>
    {known && snapshot && data ? <nav className={styles.pager} aria-label="Activity pages">
      <p>Page {snapshot.index + 1} of the {stale ? "last loaded " : ""}window</p>
      <div className={styles.actions}>
        <button type="button" className={styles.button} disabled={Boolean(pending) || snapshot.index === 0}
          onClick={(event) => void load({ group: shownGroup, cursors: snapshot.cursors, index: snapshot.index - 1, kind: "page", trigger: event.currentTarget })}>Previous</button>
        <button type="button" className={styles.button} disabled={Boolean(pending) || !data.page.hasMore}
          onClick={(event) => void load({ group: shownGroup, cursors: [...snapshot.cursors.slice(0, snapshot.index + 1), data.page.nextCursor], index: snapshot.index + 1, kind: "page", trigger: event.currentTarget })}>Next</button>
      </div>
    </nav> : null}
  </section>;
}

function SourceCoverage({ response, stale }: { response: ActivityResponse; stale: boolean }) {
  return <details className={styles.coverage}>
    <summary>Source coverage · {stale ? "last loaded" : response.state === "ready" ? "checked" : response.state === "partial" ? "incomplete" : "unavailable"}</summary>
    <dl>{sources.map((source) => {
      const coverage = response.coverage[source];
      return <div key={source}><dt>{sourceLabels[source]}</dt><dd>
        <strong>{coverageLabel(coverage)}</strong>
        <span>{coverage.visibleCount === null ? "Count unavailable." : `${coverage.visibleCount.toLocaleString()} readable records within the ${coverage.limit}-record source limit.`}</span>
      </dd></div>;
    })}</dl>
    <p>Only authorized metadata is shown. Coverage and counts are checked when you refresh; this page does not continuously monitor the sources.</p>
  </details>;
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const destination = item.source === "approvals" ? "Open approval" : item.source === "runs" ? "Open in Assistant" : "Open in Today";
  return <article className={styles.row} aria-label={`${item.title}: ${item.sourceRef.id}`}>
    <div className={styles.rowContent}>
      <div className={styles.rowHeading}><h4>{item.title}</h4><span className={styles.status}>
        {startCase(item.status)}{item.canonicalStatus?.status === "unverified" ? " · Unverified outcome" : item.canonicalStatus?.status === "partial" ? " · Partial outcome" : item.canonicalStatus?.status === "succeeded" ? " · Verified outcome" : ""}
      </span></div>
      <p>{item.summary}</p>
      <dl className={styles.identity}>
        <div><dt>{startCase(item.sourceRef.kind)} ID</dt><dd><code>{item.sourceRef.id}</code></dd></div>
        <div><dt>{startCase(item.timestamp.basis)}</dt><dd><time dateTime={item.timestamp.at}>{formatTime(item.timestamp.at)}</time></dd></div>
      </dl>
      <details className={styles.references}><summary>Record references</summary><dl>
        <div><dt>Activity ID</dt><dd><code>{item.id}</code></dd></div>
        <div><dt>Work identity</dt><dd><code>{item.workKey}</code></dd></div>
        <div><dt>Source state</dt><dd><code>{item.status}</code></dd></div>
        {item.sourceRef.approvalKind ? <div><dt>Approval type</dt><dd>{startCase(item.sourceRef.approvalKind)}</dd></div> : null}
        {item.origin?.threadId ? <div><dt>Conversation ID</dt><dd><code>{item.origin.threadId}</code></dd></div> : null}
        {item.references.map((reference) => <div key={`${reference.kind}:${reference.approvalKind ?? ""}:${reference.id}`}>
          <dt>{startCase(reference.kind)} reference</dt><dd><code>{reference.id}</code></dd>
        </div>)}
      </dl></details>
    </div>
    <div className={styles.rowActions}>
      <Link className={styles.button} href={item.href} prefetch={false} aria-label={`${destination}: ${item.sourceRef.id}`}>{destination}</Link>
      {item.origin && item.origin.href !== item.href ? <Link className={styles.originLink} href={item.origin.href} prefetch={false}
        aria-label={`Return to originating run: ${item.origin.runId}`}>Return to originating run</Link> : null}
    </div>
  </article>;
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
