"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { permissionMessage, useWorkspaceSession, type WorkspacePermission } from "@/components/app-shell/session-context";
import { at, makeSubmission, parseSource, record, retentionKeys, retrySupported, rows, text, type ActionKind, type DraftValues, type OperationalScope, type Receipt, type RecordValue, type SourceKey, type Submission } from "./operational-contracts";
import { createOperationalGate, requestOperationalAction, type ActionOutcome } from "./operational-request";
import styles from "./operational-view.module.css";

export type Endpoint = { key: SourceKey; label: string; path: string; permission: WorkspacePermission; coverage: string };
export type Resource = { data?: RecordValue; loading?: boolean; error?: string; restricted?: boolean; receivedAt?: string };
export type WorkspaceApi = ReturnType<typeof useOperationalWorkspace>;
export function ScopedOperationalWorkspace({ children }: { children: ReactNode }) {
  const { session, role } = useWorkspaceSession();
  return <div key={JSON.stringify([session?.context?.tenantId, session?.context?.actorId, role, session?.authenticated])}>{children}</div>;
}
export function useOperationalWorkspace(endpoints: readonly Endpoint[]) {
  const { session, status, role } = useWorkspaceSession();
  const tenantId = session?.context?.tenantId ?? ""; const actorId = session?.context?.actorId ?? "";
  const scope: OperationalScope = { tenantId, actorId };
  const [resources, setResources] = useState<Partial<Record<SourceKey, Resource>>>({});
  const [pending, setPending] = useState<ActionKind>();
  const [attempt, setAttempt] = useState<{ submission: Submission; outcome: ActionOutcome }>();
  const [confirmed, setConfirmed] = useState<{ submission: Submission; receipt: Receipt }>();
  const [copyStatus, setCopyStatus] = useState<string>();
  const [gate] = useState(createOperationalGate);
  const controller = useRef<AbortController | null>(null);
  const sessionRef = useRef({ session, status });
  useLayoutEffect(() => { sessionRef.current = { session, status }; }, [session, status]);
  useLayoutEffect(() => { gate.activate(); return () => { gate.dispose(); controller.current?.abort(); }; }, [gate]);
  const blocked = (permission: WorkspacePermission) => permissionMessage(session, status, permission) || (!tenantId || !actorId ? "Workspace identity is unavailable." : undefined);
  const refresh = useCallback(async () => {
    controller.current?.abort(); const abort = new AbortController(); controller.current = abort;
    const token = gate.beginRead();
    const scope = { tenantId, actorId };
    const sources = endpoints.map((endpoint) => ({ endpoint, reason: permissionMessage(session, status, endpoint.permission) || (!tenantId || !actorId ? "Workspace identity is unavailable." : undefined) }));
    setResources((current) => Object.fromEntries(sources.map(({ endpoint, reason }) => [endpoint.key, reason ? { error: reason, restricted: true } : { ...current[endpoint.key], loading: true }])));
    await Promise.all(sources.map(async ({ endpoint, reason }) => {
      if (reason) return;
      try {
        const response = await fetch(endpoint.path, { cache: "no-store", credentials: "same-origin", headers: { accept: "application/json" }, signal: AbortSignal.any([abort.signal, AbortSignal.timeout(15_000)]) });
        const body: unknown = await response.json();
        if (!response.ok) {
          const message = text(record(body).error, `Source returned ${response.status}.`);
          if (response.status === 401 || response.status === 403) {
            if (gate.currentRead(token)) setResources((current) => ({ ...current, [endpoint.key]: { error: message, restricted: true } }));
            return;
          }
          throw new Error(message);
        }
        const data = parseSource(endpoint.key, body, scope);
        if (gate.currentRead(token)) setResources((current) => ({ ...current, [endpoint.key]: { data, receivedAt: new Date().toISOString(), loading: false } }));
      } catch (error) {
        if (gate.currentRead(token) && !abort.signal.aborted) setResources((current) => ({ ...current, [endpoint.key]: { ...current[endpoint.key], loading: false, error: error instanceof Error ? error.message : "Source unavailable." } }));
      }
    }));
  }, [actorId, endpoints, gate, session, status, tenantId]);
  useEffect(() => { const timer = window.setTimeout(() => void refresh(), 0); return () => { window.clearTimeout(timer); controller.current?.abort(); }; }, [refresh]);
  async function execute(submission: Submission) {
    const permission: WorkspacePermission = submission.kind === "retention" ? "manage.identity" : submission.kind === "marker" || submission.kind === "monitor" ? "manage.workflow" : "run.evaluation";
    const currentSession = sessionRef.current;
    if (permissionMessage(currentSession.session, currentSession.status, permission) || submission.scope.tenantId !== currentSession.session?.context?.tenantId || submission.scope.actorId !== currentSession.session?.context?.actorId) return;
    const token = gate.beginWrite(); if (!token) return;
    setPending(submission.kind); setAttempt(undefined); setCopyStatus(undefined);
    const outcome = await requestOperationalAction(submission);
    if (!gate.currentWrite(token)) return;
    if (outcome.state === "confirmed") setConfirmed({ submission, receipt: outcome.receipt });
    setAttempt({ submission, outcome });
    gate.finishWrite(token); setPending(undefined);
    // The mutation receipt is settled before the independent snapshot refresh.
    if (outcome.state === "confirmed") void refresh();
  }
  async function copyReceipt() {
    if (!confirmed) return;
    try { await navigator.clipboard.writeText(JSON.stringify(confirmed, null, 2)); setCopyStatus("Receipt copied."); }
    catch { setCopyStatus("Could not copy. The complete receipt remains readable below."); }
  }
  return { resources, refresh, pending, attempt, confirmed, execute, copyReceipt, copyStatus, scope, role, blocked, dismissAttempt: () => setAttempt(undefined), endpoints };
}
export function OperationalFrame({ title, description, api, children, embedded = false }: { title: string; description: string; api: WorkspaceApi; children: ReactNode; embedded?: boolean }) {
  const loading = Object.values(api.resources).some((source) => source?.loading);
  return <section className={`${styles.workspace} ${embedded ? styles.embedded : ""}`} aria-labelledby="operational-title" data-testid={`operational-${title === "Quality Checks" ? "quality" : title.toLowerCase()}`}>
    <header className={styles.heading}><div>{!embedded ? <p className={styles.eyebrow}>{title === "Security" ? "Your workspace" : "Workspace controls"}</p> : null}{embedded ? <h2 id="operational-title">{title}</h2> : <h1 id="operational-title">{title}</h1>}<p className={styles.reading}>{description}</p></div><button type="button" className={styles.button} onClick={() => void api.refresh()} disabled={loading}>{loading ? `Refreshing ${title.toLowerCase()}…` : `Refresh ${title.toLowerCase()}`}</button></header>
    {api.pending ? <p role="status" className={styles.notice}>Sending {actionTitles[api.pending].toLowerCase()}. Leaving this view does not cancel work already sent to the server.</p> : null}
    {api.attempt && api.attempt.outcome.state !== "confirmed" ? <section className={styles.notice} role="status" aria-label="Action outcome"><h2>{api.attempt.outcome.state === "uncertain" ? "Outcome unconfirmed" : "Request not accepted"}</h2><p>{api.attempt.outcome.message}</p><SubmissionDetails submission={api.attempt.submission} />{api.attempt.outcome.state === "uncertain" ? <p>{retrySupported(api.attempt.submission.kind) ? "Retry sends this exact submitted request. Evaluation jobs use the same request key; proposal reviews reconcile the same decision and reason." : "This endpoint has no request replay guarantee. Refresh the records before deliberately starting another request; repeating it may have additional effects."}</p> : null}<div className={styles.actions}>{retrySupported(api.attempt.submission.kind) && api.attempt.outcome.state === "uncertain" ? <button type="button" className={styles.button} disabled={Boolean(api.pending) || Boolean(api.blocked("run.evaluation"))} onClick={() => void api.execute(api.attempt!.submission)}>Retry exact request</button> : null}<button type="button" className={styles.button} onClick={api.dismissAttempt} disabled={Boolean(api.pending)}>Dismiss outcome notice</button></div></section> : null}
    {api.confirmed ? <section className={styles.receipt} aria-label="Last confirmed action"><h2>{api.confirmed.receipt.title}</h2><p className={styles.status}>{api.confirmed.receipt.status}</p><p>{api.confirmed.receipt.caveat}</p><details><summary>Submitted request and returned receipt</summary><SubmissionDetails submission={api.confirmed.submission} /><dl className={styles.facts}>{api.confirmed.receipt.details.map(([label, value], index) => <div key={`${label}-${index}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><button type="button" className={styles.button} onClick={() => void api.copyReceipt()}>Copy receipt</button><p role="status">{api.copyStatus}</p></details></section> : null}
    {children}
    <details className={styles.sources}><summary>Source coverage and access</summary><p className={styles.support}>Current tenant: <span className={styles.identity}>{api.scope.tenantId || "Unavailable"}</span>. Current actor: <span className={styles.identity}>{api.scope.actorId || "Unavailable"}</span>. Role: {api.role}.</p><ul>{api.endpoints.map((endpoint) => <li key={endpoint.key}><strong>{endpoint.label}</strong><p>{endpoint.coverage}</p><SourceStatus source={api.resources[endpoint.key]} /></li>)}</ul></details>
  </section>;
}
export function SourceStatus({ source }: { source?: Resource }) {
  const label = source?.restricted ? "Restricted" : source?.data ? source.loading ? "Refreshing · last loaded data" : source.error ? "Refresh unavailable · last loaded data" : "Loaded snapshot" : source?.loading || !source ? "Loading" : "Unavailable";
  const received = source?.receivedAt ? new Date(source.receivedAt) : undefined;
  const updated = received && !Number.isNaN(received.getTime()) ? received.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : undefined;
  return <div className={styles.sourceStatus} data-source-state={label}><p>{label === "Loaded snapshot" ? "Loaded" : label}{updated ? ` · Updated ${updated}` : ""}</p>{source?.error ? <p>{source.error}</p> : null}</div>;
}
export function DataSection({ title, description, source, children, empty }: { title: string; description?: string; source?: Resource; children?: ReactNode; empty?: string }) {
  const id = useId();
  return <section className={styles.section} aria-labelledby={id}><header className={styles.sectionHeading}><h2 id={id}>{title}</h2>{description ? <p className={styles.support}>{description}</p> : null}<SourceStatus source={source} /></header>{source?.data && !source.restricted ? children || <p className={styles.empty}>{empty || "No records in this loaded view."}</p> : null}</section>;
}
export function DataRows({ items, render, empty = "No records in this loaded view." }: { items: RecordValue[]; render: (item: RecordValue) => ReactNode; empty?: string }) {
  return items.length ? <ul className={styles.rows}>{items.map((item, index) => <li key={text(item.id ?? item.tableName, `row-${index}`)}>{render(item)}</li>)}</ul> : <p className={styles.empty}>{empty}</p>;
}
export function Facts({ values }: { values: Array<[string, unknown]> }) {
  return <dl className={styles.facts}>{values.filter(([, value]) => value !== undefined).map(([label, value]) =>
    <div key={label}><dt>{label}</dt><dd>{Array.isArray(value) ? value.map((v) => text(v)).join(", ") || "None reported" : typeof value === "boolean" ? value ? "Yes" : "No" : text(value)}</dd></div>
  )}</dl>;
}
export function RecordHeading({ title, status }: { title: unknown; status?: unknown }) { return <div className={styles.recordHeading}><h3>{text(title)}</h3>{status !== undefined ? <span className={styles.status}>{text(status)}</span> : null}</div>; }
export function ReleaseEvidence({ source }: { source?: Resource }) {
  const report = record(source?.data?.report); const gate = record(report.releaseGate);
  return <DataSection title="Release evidence" description="A recorded gate assessment, separate from running or passing an evaluation." source={source}>
    <Facts values={[["Gate status", gate.status], ["Approved", gate.approved], ["Checked", report.checkedAt], ["Commit", at(report, "deployment.commitSha")], ["Environment", at(report, "deployment.environment")]]} />
    <DataRows items={rows(report.gates)} render={(item) => <><RecordHeading title={item.name} status={item.status} /><p>{text(item.summary)}</p><Facts values={[["Gate ID", item.id]]} /></>} />
    {Array.isArray(gate.reasons) && gate.reasons.length ? <ul>{gate.reasons.map((reason, index) => <li key={index}>{text(reason)}</li>)}</ul> : null}
    {Array.isArray(gate.warnings) && gate.warnings.length ? <ul>{gate.warnings.map((warning, index) => <li key={index}>{text(warning)}</li>)}</ul> : null}
  </DataSection>;
}
export const actionTitles: Record<ActionKind, string> = { run: "Run evaluations", review: "Review proposal", replay: "Replay failure case", monitor: "Run SLO monitor", marker: "Record marker", retention: "Sweep tenant retention" };
export type Field = { name: string; label: string; type?: "textarea" | "select" | "checkbox"; options?: Array<[string, string]>; minLength?: number; maxLength?: number; help?: string };
export function ActionForm({ kind, api, description, fields = [], initial = {}, target, disabledReason, preview }: { kind: ActionKind; api: WorkspaceApi; description: string; fields?: Field[]; initial?: DraftValues; target?: (draft: DraftValues) => RecordValue | undefined; disabledReason?: string; preview?: ReactNode }) {
  const [draft, setDraft] = useState(initial); const [review, setReview] = useState<Submission>(); const [error, setError] = useState<string>();
  const trigger = useRef<HTMLButtonElement>(null); const cancel = useRef<HTMLButtonElement>(null); const title = useRef<HTMLHeadingElement>(null); const restoreFocus = useRef(false); const id = useId();
  const permission = kind === "retention" ? "manage.identity" : kind === "monitor" || kind === "marker" ? "manage.workflow" : "run.evaluation";
  const reason = api.blocked(permission) || disabledReason;
  const locked = Boolean(reason || api.pending || api.attempt?.outcome.state === "uncertain");
  const dirty = Object.keys(draft).some((key) => draft[key] !== initial[key]);
  useLayoutEffect(() => { if (review) cancel.current?.focus(); else if (restoreFocus.current) { restoreFocus.current = false; trigger.current?.focus(); } }, [review]);
  function prepare() {
    if (locked) return;
    try { setReview(makeSubmission(kind, draft, api.scope, crypto.randomUUID(), target?.(draft))); setError(undefined); }
    catch (error) { setError(error instanceof Error ? error.message : "Review the required fields."); }
  }
  function close() { restoreFocus.current = true; setReview(undefined); }
  return <section className={styles.actionPanel} aria-labelledby={`${id}-title`}><h2 ref={title} tabIndex={-1} id={`${id}-title`}>{actionTitles[kind]}</h2><p>{description}</p><form onSubmit={(event) => { event.preventDefault(); prepare(); }}>
    <div className={styles.fields}>{fields.map((field) => <label key={field.name} className={field.type === "checkbox" ? styles.checkbox : styles.field}><span>{field.label}</span>{field.type === "checkbox" ? <input type="checkbox" checked={draft[field.name] === true} onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.checked }))} /> : field.type === "select" ? <select value={String(draft[field.name] ?? "")} onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))}>{field.options?.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select> : field.type === "textarea" ? <textarea required minLength={field.minLength} maxLength={field.maxLength} rows={3} value={String(draft[field.name] ?? "")} onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))} /> : <input required minLength={field.minLength} maxLength={field.maxLength} value={String(draft[field.name] ?? "")} onChange={(event) => setDraft((current) => ({ ...current, [field.name]: event.target.value }))} />}{field.help ? <span className={styles.support}>{field.help}</span> : null}</label>)}</div>
    {dirty ? <p className={styles.support}>Local draft. Refreshing sources keeps these fields. A submitted receipt below the page heading describes only its frozen request.</p> : null}
    {reason ? <p className={styles.support}>{reason}</p> : null}{api.attempt?.outcome.state === "uncertain" ? <p className={styles.support}>Resolve or dismiss the unconfirmed outcome above before starting a new request.</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {review ? <div className={styles.confirmation} aria-label={`${actionTitles[kind]} confirmation`}><h3>Review this exact request</h3><SubmissionDetails submission={review} />{preview}<p>The submitted request is frozen. Edits to the fields above remain a separate draft.</p><div className={styles.actions}><button ref={cancel} type="button" className={styles.button} onClick={close}>Keep editing</button><button type="button" className={styles.primaryButton} disabled={locked} onClick={() => { const submitted = review; title.current?.focus(); setReview(undefined); void api.execute(submitted); }}>Confirm {actionTitles[kind].toLowerCase()}</button></div></div> : <button ref={trigger} type="submit" className={styles.button} disabled={locked}>Review {actionTitles[kind].toLowerCase()}</button>}
  </form></section>;
}
function SubmissionDetails({ submission }: { submission: Submission }) { return <><dl className={styles.facts}><div><dt>Endpoint</dt><dd>POST {submission.path}</dd></div><div><dt>Tenant</dt><dd>{submission.scope.tenantId}</dd></div><div><dt>Actor</dt><dd>{submission.scope.actorId}</dd></div><div><dt>Request key</dt><dd>{submission.key}</dd></div>{Object.entries(submission.body).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{typeof value === "boolean" ? value ? "Yes" : "No" : text(value)}</dd></div>)}</dl>{submission.target && submission.kind === "retention" ? <details open><summary>Policy snapshot reviewed with this request</summary><Facts values={[["Backend", submission.target.backend], ["Received", submission.target.receivedAt], ...retentionKeys.map((key): [string, unknown] => [key, `${text(at(submission.target, `policy.${key}`))} days`])]} /></details> : null}{submission.target && submission.kind === "review" ? <Facts values={[["Loaded proposal version", submission.target.version], ["Loaded proposal SHA-256", submission.target.proposalSha256]]} /> : null}{submission.target && submission.kind === "replay" ? <Facts values={[["Loaded case ID", at(submission.target, "replayCase.caseId")], ["Loaded case definition SHA-256", at(submission.target, "replayCase.caseDefinitionSha256")]]} /> : null}</>; }
export { styles };
