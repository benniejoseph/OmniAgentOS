"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { canonicalWorkItemCostLabel, canonicalWorkItemStatusLabel } from "@/lib/workspaces/surface";
import {
  HISTORY_LIMITS, HistoryReadGate, historyEvidenceHref, historyHref, historyId, historyLiteral, historyReturnTo,
  parseHistoryDetail, parseHistoryEvents, parseHistoryList, parseHistorySummary,
  type HistoryDetail, type HistoryMission,
} from "./mission-history-state";
import styles from "./mission-history.module.css";

const historyIsVisible = () => document.visibilityState !== "hidden";

class HistoryReadError extends Error {
  constructor(readonly status: number) { super("The history read could not be confirmed."); }
}
async function getHistory(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(path, { signal, cache: "no-store", headers: { accept: "application/json" } });
  if (!response.ok) throw new HistoryReadError(response.status);
  return response.json();
}
const listHistory = async (signal: AbortSignal) => parseHistoryList(await getHistory("/api/missions?ownerScope=readable&limit=50", signal));
type ReadState<T> = { data?: T; loading: boolean; error?: string; denied?: boolean };
function useHistoryRead<T>(reader: (signal: AbortSignal) => Promise<T>, enabled = true) {
  const gate = useMemo(() => new HistoryReadGate(), []);
  const input = useMemo(() => ({ reader, enabled }), [reader, enabled]);
  const [state, setState] = useState<ReadState<T> & { input: typeof input }>({ loading: enabled, input });
  useLayoutEffect(() => { gate.activate(); return () => gate.dispose(); }, [gate, reader, enabled]);
  const refresh = useCallback(async () => {
    if (!enabled || !historyIsVisible()) return;
    const request = gate.begin();
    if (!request) return;
    setState((previous) => ({ ...(previous.input.reader === reader ? previous : {}), input, loading: true }));
    try {
      const data = await reader(request.signal);
      if (request.current() && historyIsVisible()) setState({ data, loading: false, input });
    } catch (failure) {
      if (!request.current()) return;
      const denied = failure instanceof HistoryReadError && [401, 403, 404].includes(failure.status);
      setState((previous) => ({ input, data: denied || previous.input.reader !== reader ? undefined : previous.data, loading: false, denied,
        error: denied ? "This history is no longer available to the current account." : "This read could not be confirmed. Retry to check the current history." }));
    }
  }, [enabled, gate, input, reader]);
  useEffect(() => {
    const timer = window.setTimeout(() => { if (enabled) void refresh(); else setState((previous) => ({ ...(previous.input.reader === reader ? previous : {}), input, loading: false })); }, 0);
    const visibility = () => {
      if (!historyIsVisible()) { gate.cancel(); setState((previous) => ({ ...previous, loading: false })); }
      else void refresh();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => { window.clearTimeout(timer); gate.cancel(); document.removeEventListener("visibilitychange", visibility); };
  }, [enabled, gate, input, reader, refresh]);
  const visible = state.input === input ? state : { loading: enabled,
    data: state.input.reader === reader ? state.data : undefined,
    error: state.input.reader === reader ? state.error : undefined,
    denied: state.input.reader === reader ? state.denied : undefined };
  return { ...visible, refresh };
}

export function MissionHistory() {
  const { session, status, role, refresh } = useWorkspaceSession();
  const reason = permissionMessage(session, status, "read");
  const owner = session?.context;
  if (reason || !owner?.tenantId || !owner.actorId) return <section className={styles.shell} aria-labelledby="mission-history-title">
    <h1 id="mission-history-title">Mission history</h1><p role="status">{reason || "Workspace history is unavailable until the account is confirmed."}</p>
    {status !== "loading" ? <button type="button" onClick={() => void refresh()}>Retry workspace access</button> : null}
    <Link className={styles.button} href="/app/projects?view=execution">Back to Work</Link>
  </section>;
  return <HistoryWorkspace key={JSON.stringify([owner.tenantId, owner.actorId, session?.user?.id, role])} onRefreshAccess={() => void refresh()} />;
}

function HistoryWorkspace({ onRefreshAccess }: { onRefreshAccess: () => void }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const query = searchParams.toString();
  const router = useRouter();
  const list = useHistoryRead(listHistory);
  const recordHeading = useRef<HTMLHeadingElement>(null);
  const listHeading = useRef<HTMLHeadingElement>(null);
  const focusRecord = useRef(false);
  let selectedId: string | undefined;
  try { selectedId = historyId(decodeURIComponent(pathname.slice("/app/missions/".length))); } catch { selectedId = undefined; }
  const search = searchParams.get("q") || "";
  const filter = searchParams.get("status") || "all";
  const rows = list.data?.filter((mission) => (filter === "all" || mission.workItem.status.status === filter) &&
    `${mission.title} ${mission.objective} ${mission.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const returnTo = historyReturnTo(searchParams.get("returnTo"));
  const setFilter = (name: string, value: string) => {
    const next = new URLSearchParams(query);
    if (value && value !== "all") next.set(name, value); else next.delete(name);
    window.history.replaceState(null, "", historyHref(selectedId, next.toString()));
  };
  useLayoutEffect(() => {
    if (!focusRecord.current) return;
    focusRecord.current = false;
    const heading = selectedId ? recordHeading.current : listHeading.current;
    heading?.focus({ preventScroll: true });
    heading?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);
  const navigate = (id: string | undefined) => {
    focusRecord.current = true;
    window.history.pushState(null, "", historyHref(id, query));
    if (id === selectedId) { recordHeading.current?.focus({ preventScroll: true }); focusRecord.current = false; }
  };
  return <section className={styles.shell} aria-labelledby="mission-history-title" data-testid="mission-history">
    <header className={styles.header}><div><p className={styles.eyebrow}>Work archive · read only</p><h1 id="mission-history-title">Mission history</h1>
      <p>Historical missions, decisions and recorded evidence. Continue current execution in Work.</p></div>
      <button type="button" onClick={onRefreshAccess}>Refresh account access</button>
      <Link className={styles.button} href={returnTo}>{returnTo.startsWith("/app/results") ? "Back to Results" : returnTo.startsWith("/app/activity") ? "Back to Activity" : "Back to Work"}</Link></header>
    <p className={styles.boundary}>Legacy completion is not verified success. Canonical Work status and its exact source identities are shown as returned.</p>
    <div className={styles.layout}>
      <section className={styles.ledger} aria-labelledby="history-list-title">
        <div className={styles.sectionHeader}><h2 id="history-list-title" ref={listHeading} tabIndex={-1}>Historical missions</h2>
          <button type="button" onClick={() => void list.refresh()} disabled={list.loading}>Refresh history</button></div>
        <div className={styles.filters}><label>Search loaded history<input type="search" value={search} onChange={(event) => setFilter("q", event.target.value)} maxLength={240} /></label>
          <label>Recorded Work status<select value={filter} onChange={(event) => setFilter("status", event.target.value)}>
            <option value="all">All statuses</option>{["preview", "running", "waiting", "blocked", "partial", "unverified", "failed", "canceled", "succeeded"].map((value) => <option value={value} key={value}>{canonicalWorkItemStatusLabel(value)}</option>)}
          </select></label></div>
        <ReadNotice read={list} name="history list" retry={() => void list.refresh()} />
        <p className={styles.support} role="status">{list.data ? `${list.error || list.loading ? "Last loaded: " : ""}${rows?.length} matching of ${list.data.length} returned missions. At most 50 are read; no total or server pagination is provided.` : "History counts are unavailable until the first confirmed read."}</p>
        {list.data && !list.data.length ? <p className={styles.empty}>No historical missions were returned for this account.</p> : list.data && !rows?.length ? <p className={styles.empty}>No loaded missions match these filters.</p> : null}
        <ul className={styles.rows}>{rows?.map((mission) => <li key={mission.id}>
          <a className={styles.missionRow} href={historyHref(mission.id, query)} aria-current={selectedId === mission.id ? "page" : undefined}
            onClick={(event) => { if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(mission.id); } }}>
            <strong>{mission.title}</strong><span>{canonicalWorkItemStatusLabel(mission.workItem.status.status)}</span>
            <small>{date(mission.updatedAt)} · {mission.detailAvailable ? "Detailed history available" : "Summary only"}</small>
          </a></li>)}</ul>
      </section>
      <section className={styles.record} aria-labelledby="history-record-title">
        <div className={styles.sectionHeader}><h2 id="history-record-title" ref={recordHeading} tabIndex={-1}>Mission record</h2>
          {selectedId ? <button type="button" onClick={() => navigate(undefined)}>Close mission record</button> : null}</div>
        {list.denied ? <p className={styles.notice}>Current history access is unavailable. Retry the history list to recheck this account.</p> : selectedId ? <SelectedHistory key={selectedId} id={selectedId} onUnavailable={() => router.replace("/app/projects?view=execution")} /> : <p className={styles.empty}>Choose a historical mission to inspect its tasks, decisions and evidence.</p>}
      </section>
    </div>
  </section>;
}

function SelectedHistory({ id, onUnavailable }: { id: string; onUnavailable: () => void }) {
  const reader = useCallback(async (signal: AbortSignal) => parseHistorySummary(await getHistory(`/api/missions/${encodeURIComponent(id)}?ownerScope=readable&view=summary`, signal), id), [id]);
  const summary = useHistoryRead(reader);
  const exact = Boolean(summary.data?.detailAvailable && !summary.error && !summary.loading);
  const summaryUpdatedAt = summary.data?.updatedAt;
  const detailReader = useCallback(async (signal: AbortSignal) => {
    const value = parseHistoryDetail(await getHistory(`/api/missions/${encodeURIComponent(id)}`, signal), id);
    if (summaryUpdatedAt && Date.parse(value.mission.updatedAt) < Date.parse(summaryUpdatedAt)) throw new Error("An older detail cannot replace the confirmed summary.");
    return value;
  }, [id, summaryUpdatedAt]);
  const detail = useHistoryRead(detailReader, exact);
  const unavailable = summary.denied || detail.denied;
  useEffect(() => { if (unavailable) onUnavailable(); }, [onUnavailable, unavailable]);
  const mission = exact && detail.data && !detail.error && !detail.loading ? detail.data.mission : summary.data;
  return <div className={styles.detail}>
    <div className={styles.sectionHeader}><code>{id}</code><button type="button" onClick={() => void summary.refresh()} disabled={summary.loading}>Refresh mission record</button></div>
    <ReadNotice read={summary} name="mission summary" retry={() => void summary.refresh()} />
    {mission ? <>
      <h3 className={styles.recordTitle}>{mission.title}</h3><p className={styles.reading}>{mission.objective}</p>
      <MissionFacts mission={mission} stale={Boolean(summary.error || summary.loading)} />
      {!mission.detailAvailable ? <p className={styles.notice}>Only the readable summary is available. Tasks, attempts, decisions and events have not been disclosed for this account.</p> : <>
        {!exact ? <p className={styles.notice}>Detailed history is last loaded while current summary access is being checked.</p> : null}
        <ReadNotice read={detail} name="detailed history" retry={() => void detail.refresh()} disabled={!exact} />
        {detail.data ? <DetailHistory detail={detail.data} stale={!exact || Boolean(detail.error || detail.loading)} /> : <p className={styles.support}>Task, attempt and evidence counts are unavailable until detailed history is confirmed.</p>}
        <EventHistory id={id} enabled={exact && !detail.denied} onUnavailable={onUnavailable} />
      </>}
    </> : null}
  </div>;
}

function ReadNotice({ read, name, retry, disabled = false }: { read: ReadState<unknown>; name: string; retry: () => void; disabled?: boolean }) {
  const retryFocus = useRef(false);
  useLayoutEffect(() => {
    if (read.loading || read.error || !retryFocus.current) return;
    retryFocus.current = false;
    if (document.activeElement !== document.body) return;
    document.getElementById(name === "history list" ? "history-list-title" : name === "event history" ? "history-events-title" : "history-record-title")?.focus({ preventScroll: true });
  }, [name, read.error, read.loading]);
  return <>
    <div className={styles.live} role="status" aria-live="polite">{read.loading ? `Reading ${name}…${read.data ? " Last loaded history remains visible." : ""}` : ""}</div>
    {read.error ? <div className={styles.notice} role="alert"><p>{read.error}{read.data ? " Last loaded history is retained." : " Counts remain unavailable."}</p>
      <button type="button" disabled={disabled || read.loading} onClick={(event) => { retryFocus.current = document.activeElement === event.currentTarget; retry(); }}>Retry {name}</button></div> : null}
  </>;
}
function date(value: string) { return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); }
function Fields({ values }: { values: [string, string | number][] }) {
  return <dl className={styles.fields}>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function Literal({ title, value }: { title: string; value: unknown }) {
  return <details className={styles.evidence}><summary>{title}</summary><pre>{historyLiteral(value)}</pre></details>;
}
function MissionFacts({ mission, stale }: { mission: HistoryMission; stale: boolean }) {
  return <><p className={styles.state}>{stale ? "Last loaded · " : ""}{canonicalWorkItemStatusLabel(mission.workItem.status.status)}</p>
    <Fields values={[["Legacy source state", mission.status], ["Priority", mission.priority], ["Updated", date(mission.updatedAt)],
      ["Work project ID", mission.workItem.status.projectId], ["Work item ID", mission.workItem.status.workItemId],
      ["Workspace", mission.workItem.status.workspaceId || "Not recorded"], ["Cost", canonicalWorkItemCostLabel(mission.workItem.cost)]]} />
    <Literal title="Exact canonical Work evidence" value={mission.workItem} /></>;
}
function DetailHistory({ detail, stale }: { detail: HistoryDetail; stale: boolean }) {
  return <>
    <p className={styles.support}>{stale ? "Last loaded detail: " : "Returned detail: "}{detail.tasks.length} tasks, {detail.attempts.length} attempts and {detail.artifacts.length} evidence records. These are bounded windows, not total counts.</p>
    <section className={styles.subsection} aria-labelledby="history-tasks-title"><h3 id="history-tasks-title">Tasks and decisions</h3>
      <p className={styles.support}>The current detail API returns at most 30 tasks. A dependency outside this window is not proof of missing work.</p>
      {!detail.tasks.length ? <p>No tasks were returned in this window.</p> : detail.tasks.map((task) => <details className={styles.task} key={task.id}><summary><strong>{task.title}</strong><span>{canonicalWorkItemStatusLabel(task.workItem.status.status)}</span></summary>
        <div className={styles.taskBody}><Fields values={[["Task ID", task.id], ["Updated", date(task.updatedAt)], ["Legacy source state", task.status], ["Recorded execution", task.workItem.execution.availability], ["Cost", canonicalWorkItemCostLabel(task.workItem.cost)]]} />
          <h4>Instructions</h4><p className={styles.reading}>{task.instructions || "No instructions were returned."}</p>
          <h4>Definition of done</h4><p className={styles.reading}>{task.definitionOfDone || "No definition was returned."}</p>
          <Literal title="Recorded decisions and dependencies" value={{ metadata: task.metadata, dependencyIds: task.dependencyIds }} />
          <Literal title="Exact task Work evidence" value={task.workItem} />
        </div></details>)}
    </section>
    <section className={styles.subsection} aria-labelledby="history-attempts-title"><h3 id="history-attempts-title">Execution attempts</h3>
      <p className={styles.support}>At most 100 attempts are returned. Source completion remains separate from verified success.</p>
      {!detail.attempts.length ? <p>No attempts were returned in this window.</p> : <ul className={styles.rows}>{detail.attempts.map((attempt) => <li className={styles.attempt} key={attempt.id}><strong>{canonicalWorkItemStatusLabel(attempt.canonicalStatus.status)} · {attempt.executorType}</strong>
        <Fields values={[["Attempt ID", attempt.id], ["Task ID", attempt.taskId], ["Source state", attempt.status], ["Updated", date(attempt.updatedAt)],
          ["Workflow run", attempt.workflowRunId || "Not returned"]]} />
        {attempt.agentRunId ? <Link className={styles.button} href={`/app/results?run=${encodeURIComponent(attempt.agentRunId)}`}>Open recorded agent result</Link> : null}
        {attempt.error ? <p className={styles.reading}>{attempt.error}</p> : null}</li>)}</ul>}
    </section>
    <section className={styles.subsection} aria-labelledby="history-evidence-title"><h3 id="history-evidence-title">Evidence and handoffs</h3>
      <p className={styles.support}>At most 50 public evidence records are returned. Source text is displayed literally.</p>
      {!detail.artifacts.length ? <p>No public evidence was returned in this window.</p> : detail.artifacts.map((artifact) => {
        const href = historyEvidenceHref(artifact.uri);
        return <article className={styles.artifact} key={artifact.id}><h4>{artifact.title || artifact.kind}</h4><Fields values={[["Artifact ID", artifact.id], ["Kind", artifact.kind], ["Task ID", artifact.taskId || "Mission-level evidence"], ["Attempt ID", artifact.attemptId || "Not returned"], ["Updated", date(artifact.updatedAt)]]} />
          {artifact.uri ? <p className={styles.support}>Exact source reference: <code>{artifact.uri}</code></p> : null}
          {href ? <a className={styles.button} href={href} target={href.startsWith("http") ? "_blank" : undefined} rel="noopener noreferrer">Open evidence source{href.startsWith("http") ? " (new tab)" : ""}</a> : null}
          <Literal title={`Public evidence · ${artifact.id}`} value={artifact.data} /></article>;
      })}
    </section>
  </>;
}

function EventHistory({ id, enabled, onUnavailable }: { id: string; enabled: boolean; onUnavailable: () => void }) {
  const [cursors, setCursors] = useState([0]);
  const afterSeq = cursors.at(-1)!;
  const reader = useCallback(async (signal: AbortSignal) => parseHistoryEvents(await getHistory(`/api/missions/${encodeURIComponent(id)}/events?afterSeq=${afterSeq}&limit=25`, signal), afterSeq), [id, afterSeq]);
  const read = useHistoryRead(reader, enabled);
  useEffect(() => { if (read.denied) onUnavailable(); }, [onUnavailable, read.denied]);
  const pageHeading = useRef<HTMLHeadingElement>(null);
  const requestedFocus = useRef(false);
  const pageChange = useRef(false);
  useLayoutEffect(() => {
    pageChange.current = false;
    if (requestedFocus.current && !read.loading) { requestedFocus.current = false; if (document.activeElement === document.body) pageHeading.current?.focus({ preventScroll: true }); }
  }, [read.loading, read.data]);
  const more = Boolean(read.data?.events.length === HISTORY_LIMITS.events && read.data.cursor > afterSeq);
  return <section className={styles.subsection} aria-labelledby="history-events-title">
    <div className={styles.sectionHeader}><h3 id="history-events-title" ref={pageHeading} tabIndex={-1}>Recorded events</h3><button type="button" disabled={!enabled || read.loading} onClick={() => void read.refresh()}>Refresh events</button></div>
    <ReadNotice read={read} name="event history" retry={() => void read.refresh()} disabled={!enabled} />
    <p className={styles.support}>{read.data ? `${read.loading || read.error || !enabled ? "Last loaded: " : ""}${read.data.events.length} events in this page, oldest first. ` : "Event counts are unavailable. "}Only event type, sequence and time are disclosed; no private event payload is requested.</p>
    {read.data ? <><ol className={styles.rows}>{read.data.events.map((event) => <li className={styles.event} key={event.seq}><strong>{event.type}</strong><span>Sequence {event.seq}</span><time dateTime={event.at}>{date(event.at)}</time></li>)}</ol>
      {!read.data.events.length ? <p>No events were returned after this cursor.</p> : null}
      {read.data.events.length > 0 && read.data.cursor <= afterSeq ? <p className={styles.support}>Recent events are still settling. Refresh before advancing the cursor.</p> : null}
      <div className={styles.pagination}><button type="button" disabled={!enabled || read.loading || cursors.length < 2} onClick={() => { if (pageChange.current) return; pageChange.current = true; requestedFocus.current = true; setCursors((value) => value.slice(0, -1)); }}>Previous event page</button>
        <span>Page {cursors.length} · at most 25 events</span><button type="button" disabled={!enabled || read.loading || Boolean(read.error) || !more || cursors.length >= 4} onClick={() => { if (pageChange.current) return; pageChange.current = true; requestedFocus.current = true; setCursors((value) => [...value, read.data!.cursor]); }}>Next event page</button></div>
      <p className={styles.support}>Up to four pages can be inspected here. The server cursor may overlap recent events while they settle; a full page does not prove a complete history.</p>
    </> : null}
  </section>;
}
