"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { workflowControlHint, workflowSignalLabel } from "@/lib/workflows/client-controls";
import type { WorkflowRunStatus } from "@/lib/workflows/types";
import { WorkflowsSchedules } from "./workflows-schedules";
import { WorkflowEvidence, WorkflowFields, WorkflowReadNotice, WorkflowSection } from "./workflows-workspace-parts";
import { child, createWorkflowGate, number, parseWorkflowDetail, parseWorkflowReceipt, parseWorkflowScheduleDetail, parseWorkflowSource, rows, stable, text, titleCase, workflowJson, workflowReview, workflowReviewCurrent, workflowSignals, workflowSources, type WorkflowObject, type WorkflowOwner, type WorkflowRead, type WorkflowReview, type WorkflowSource } from "./workflows-workspace-state";
import styles from "./workflows-workspace.module.css";

type Ledger = Record<WorkflowSource, WorkflowRead>;
const emptyLedger = (): Ledger => ({ runs: { status: "loading" }, plans: { status: "loading" }, triggers: { status: "loading" }, operations: { status: "loading" } });
type View = "runs" | "plans" | "schedules" | "operations";
type DraftReview = Omit<WorkflowReview, "source" | "version">;

export function WorkflowsWorkspace() {
  const { session, status } = useWorkspaceSession();
  const tenantId = session?.context?.tenantId; const actorId = session?.context?.actorId;
  const authenticated = Boolean(session && (!session.authEnabled || session.authenticated));
  if (!tenantId || !actorId || !authenticated) return <div className={styles.workspace}><h1>Automation operations</h1><p role="status">{status === "loading" ? "Checking workspace access…" : "Workspace identity is unavailable. Recheck your session before using workflow operations."}</p></div>;
  return <WorkflowWorkspaceScope key={JSON.stringify([tenantId, actorId, session?.context?.role, session?.membership?.role, authenticated])} owner={{ tenantId, actorId }} readable={status === "ready"} disabledReason={permissionMessage(session, status, "manage.workflow")} />;
}

function WorkflowWorkspaceScope({ owner, readable, disabledReason }: { owner: WorkflowOwner; readable: boolean; disabledReason?: string }) {
  const [gate] = useState(() => createWorkflowGate());
  const [ledger, setLedger] = useState<Ledger>(emptyLedger);
  const [view, setView] = useState<View>("runs");
  const [runId, setRunId] = useState<string>();
  const [runDetail, setRunDetail] = useState<WorkflowRead>({ status: "loading" });
  const [scheduleId, setScheduleId] = useState<string>();
  const [scheduleDetail, setScheduleDetail] = useState<WorkflowRead>({ status: "loading" });
  const [review, setReview] = useState<WorkflowReview>();
  const [pending, setPending] = useState<string>();
  const [previousReadable, setPreviousReadable] = useState(readable);
  if (previousReadable !== readable) {
    setPreviousReadable(readable);
    if (!readable) setPending(undefined);
  }
  const [receipt, setReceipt] = useState<{ label: string; data: WorkflowObject; at: string }>();
  const [error, setError] = useState<string>();
  const latest = useRef({ ledger, disabledReason, readable, runId, scheduleId });
  latest.current = { ledger, disabledReason, readable, runId, scheduleId };
  const reviewed = useRef(review); reviewed.current = review;
  const reviewRef = useRef<HTMLElement>(null); const receiptRef = useRef<HTMLElement>(null); const opener = useRef<HTMLElement | null>(null);
  const runOpener = useRef<HTMLElement | null>(null); const scheduleOpener = useRef<HTMLElement | null>(null);
  const ownerRef = useRef(owner);

  const refreshSource = useCallback(async (source: WorkflowSource) => {
    const controller = gate.read(source); if (!controller) return;
    setLedger((old) => ({ ...old, [source]: { ...old[source], status: "loading", error: undefined } }));
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const data = parseWorkflowSource(source, await workflowJson(workflowSources[source].path, { signal: controller.signal }), ownerRef.current);
      if (gate.readCurrent(source, controller)) {
        setLedger((old) => ({ ...old, [source]: { status: "ready", data } }));
        if (reviewed.current?.source === source && reviewed.current.version !== stable(data)) {
          reviewed.current = undefined; setReview(undefined);
          setError("The reviewed source changed. Review its current state again before submitting.");
        }
      }
    } catch (caught) {
      // An aborted timeout is still a failed read, but replaced/disposed reads cannot publish.
      if (!gate.readOwned(source, controller)) return;
      setLedger((old) => ({ ...old, [source]: { ...old[source], status: "error", error: controller.signal.aborted ? "This read timed out. Retry to check the current source." : failure(caught) } }));
    } finally { window.clearTimeout(timeout); }
  }, [gate]);

  const refresh = useCallback(() => { for (const source of Object.keys(workflowSources) as WorkflowSource[]) void refreshSource(source); }, [refreshSource]);
  useLayoutEffect(() => { gate.mount(); return () => gate.dispose(); }, [gate]);
  useLayoutEffect(() => {
    gate.available(readable);
    return () => gate.available(false);
  }, [readable, gate]);
  useEffect(() => {
    if (!readable) return;
    const timer = window.setTimeout(refresh, 0);
    return () => window.clearTimeout(timer);
  }, [readable, refresh]);

  async function readDetail(kind: "run" | "schedule", id: string) {
    const name = `${kind}:detail`; const controller = gate.read(name); if (!controller) return;
    const set = kind === "run" ? setRunDetail : setScheduleDetail;
    set((old) => ({ ...old, status: "loading", error: undefined }));
    const timeout = window.setTimeout(() => controller.abort(), 20_000);
    try {
      const value = await workflowJson(`/api/${kind === "run" ? "workflows" : "triggers"}/${encodeURIComponent(id)}`, { signal: controller.signal });
      const data = kind === "run" ? parseWorkflowDetail(value, id, owner) : parseWorkflowScheduleDetail(value, id, owner);
      if (gate.readCurrent(name, controller)) set({ status: "ready", data });
    } catch (caught) { if (gate.readOwned(name, controller)) set((old) => ({ ...old, status: "error", error: controller.signal.aborted ? "This detail read timed out. Retry to check its current state." : failure(caught) })); }
    finally { window.clearTimeout(timeout); }
  }
  function selectRun(id?: string) {
    if (pending) return; gate.stopRead("run:detail");
    if (id === undefined) { setRunId(undefined); setRunDetail({ status: "loading" }); requestAnimationFrame(() => runOpener.current?.focus()); return; }
    if (id !== runId) { runOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setRunDetail({ status: "loading" }); }
    setRunId(id); void readDetail("run", id);
  }
  function selectSchedule(id?: string) {
    if (pending) return; gate.stopRead("schedule:detail");
    if (id === undefined) { setScheduleId(undefined); setScheduleDetail({ status: "loading" }); requestAnimationFrame(() => scheduleOpener.current?.focus()); return; }
    if (id !== scheduleId) { scheduleOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setScheduleDetail({ status: "loading" }); }
    setScheduleId(id); void readDetail("schedule", id);
  }
  function prepare(source: WorkflowSource, request: DraftReview) {
    if (pending || disabledReason) { setError(disabledReason || "Another operation is pending."); return; }
    if (ledger[source].status !== "ready") { setError("Refresh this source before reviewing an operation."); return; }
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setError(undefined); setReview(workflowReview({ ...request, source, version: stable(ledger[source].data) }));
    requestAnimationFrame(() => reviewRef.current?.focus());
  }
  function cancelReview() { if (pending) return; setReview(undefined); requestAnimationFrame(() => opener.current?.focus()); }
  async function submitReview() {
    if (!review || latest.current.disabledReason || !latest.current.readable || !workflowReviewCurrent(review, latest.current.ledger[review.source])) { setError("This reviewed source changed or is unavailable. Refresh and review the operation again."); return; }
    let attempt;
    try { attempt = gate.begin(review); } catch (caught) { setError(failure(caught)); return; }
    if (!attempt) return;
    setPending(review.label); setError(undefined);
    setLedger((old) => Object.fromEntries(Object.entries(old).map(([key, read]) => [key, read.status === "loading" ? { ...read, status: "error", error: "This read was superseded by the reviewed operation. Refresh to recheck it." } : read])) as Ledger);
    try {
      const headers = attempt.idempotencyKey ? { "idempotency-key": attempt.idempotencyKey } : undefined;
      const value = await workflowJson(review.path, { method: "POST", body: JSON.stringify(review.body), headers });
      if (!gate.current(attempt) || latest.current.disabledReason || !latest.current.readable) return;
      const data = parseWorkflowReceipt(value, review, owner);
      gate.finish(attempt, true); setPending(undefined); setReview(undefined);
      setReceipt({ label: review.label, data, at: new Date().toISOString() });
      requestAnimationFrame(() => receiptRef.current?.focus());
      refresh();
      if (runId) void readDetail("run", runId);
      if (scheduleId) void readDetail("schedule", scheduleId);
    } catch (caught) {
      if (!gate.current(attempt)) return;
      gate.finish(attempt); setPending(undefined); setError(`${failure(caught)} The operation may already have reached the server. Refresh and reconcile its status; no successful outcome is assumed.`);
      setReview(undefined); refresh();
    } finally { if (gate.current(attempt)) { gate.finish(attempt); setPending(undefined); } }
  }
  const busy = Boolean(pending); const invalidReview = Boolean(review && !workflowReviewCurrent(review, ledger[review.source]));
  const runRows = rows(ledger.runs.data, "runs"); const selectedRun = runRows.find((run) => run.id === runId);
  const detailRun = child(runDetail.data, "run");
  const runCurrent = Boolean(selectedRun && detailRun && stable(selectedRun) === stable(detailRun) && ledger.runs.status === "ready" && runDetail.status === "ready");
  return <div className={styles.workspace} data-testid="workflows-workspace">
    <header className={styles.header}><div><h1>Automation operations</h1><p>Review plans, follow durable runs, and inspect schedules and queue recovery. Each executing Agent and its authority remain explicit.</p></div><button type="button" disabled={busy || !readable} onClick={refresh}>Refresh workflow sources</button></header>
    <dl className={styles.metrics}>{([
      ["Active workflows", "runs", child(ledger.runs.data, "stats")?.active],
      ["Waiting for approval", "runs", child(ledger.runs.data, "stats")?.waitingApproval],
      ["Runnable queue jobs", "operations", child(ledger.operations.data, "summary")?.runnableJobs],
      ["Configured triggers", "triggers", child(ledger.triggers.data, "stats")?.total],
    ] as const).map(([label, source, count]) => <div key={label}><dt>{label}</dt><dd>{number(count) === undefined ? ledger[source].status === "loading" ? "Loading…" : "Unavailable" : Number(count).toLocaleString()}<span className={styles.metricSupport}>{ledger[source].data && ledger[source].status !== "ready" ? "Last-loaded source count" : "Reported by this source"}</span></dd></div>)}</dl>
    {disabledReason ? <p id="workflow-permission" className={styles.boundary}>{disabledReason} Drafts and permitted reads remain available.</p> : null}
    <div className={styles.views} role="group" aria-label="Automation operations views">{(["runs", "plans", "schedules", "operations"] as View[]).map((name) => <button key={name} type="button" aria-pressed={view === name} onClick={() => setView(name)}>{name === "operations" ? "Queue and recovery" : titleCase(name)}</button>)}</div>
    {pending ? <p role="status" className={styles.boundary}>Submitting {pending}. Leaving this page stops local updates; it does not cancel work accepted by the server.</p> : null}
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
    {review ? <section ref={reviewRef} tabIndex={-1} className={styles.confirmation} aria-label="Review workflow operation"><h2>{review.label}</h2><p>{reviewBoundary(review)}</p><WorkflowFields values={[["Workspace", owner.tenantId], ["Actor", owner.actorId], ["Request path", review.path]]} /><WorkflowEvidence title="Exact reviewed request" value={review.body} open />{review.target ? <WorkflowEvidence title="Reviewed source identity and state" value={review.target} /> : null}{invalidReview ? <p role="status">The source changed or is being refreshed. Cancel this review and review its current state again.</p> : null}<div className={styles.actions}><button type="button" disabled={busy} onClick={cancelReview}>Cancel review</button><button type="button" className={styles.primary} disabled={busy || Boolean(disabledReason) || invalidReview} onClick={() => void submitReview()}>{busy ? "Submitting reviewed operation…" : "Confirm reviewed operation"}</button></div></section> : null}
    {receipt ? <section ref={receiptRef} tabIndex={-1} className={styles.receipt} aria-label="Confirmed workflow receipt"><h2>Response confirmed</h2><p>{receipt.label} returned a matching response at {receipt.at}. Its exact state is shown below; a queued run is not a completed outcome. Read refresh status is independent.</p><WorkflowEvidence title="Confirmed response and exact identities" value={receipt.data} open /></section> : null}
    <div hidden={view !== "runs"}><WorkflowSection title="Workflow runs" description="At most 16 current and recent runs. Legacy execution state controls the available actions; canonical outcomes remain separate evidence."><WorkflowReadNotice label="Workflow runs" read={ledger.runs} onRefresh={() => void refreshSource("runs")} disabled={busy} />
      {ledger.runs.status === "ready" && !runRows.length ? <p className={styles.empty}>No workflow runs were returned in this window.</p> : null}
      <ul className={styles.rows}>{runRows.map((run) => <li key={String(run.id)}><article className={styles.row} aria-label={text(run.goal)}><div className={styles.rowHeader}><div><h3>{text(run.goal)}</h3><code>{text(run.id)}</code></div><span className={styles.status}>{titleCase(run.status)}</span></div><WorkflowFields values={[["Current step", run.currentStep ?? "Not returned"], ["Updated", run.updatedAt], ["Attempt", run.attempt], ["Maximum attempts", run.maxAttempts]]} />{run.error ? <p className={styles.error}>{text(run.error)}</p> : null}<button type="button" disabled={busy} aria-expanded={runId === run.id} onClick={() => selectRun(runId === run.id ? undefined : String(run.id))}>Inspect run · {text(run.goal)}</button>
        {runId === run.id ? <section className={styles.detail} aria-label="Workflow run detail"><button type="button" onClick={() => selectRun(undefined)}>Back to workflow runs</button><WorkflowReadNotice label="Workflow run detail" read={runDetail} onRefresh={() => selectRun(String(run.id))} disabled={busy} />{runDetail.data && detailRun ? <><WorkflowEvidence title="Exact run identity, input, outcome and evidence" value={detailRun} /><p>{workflowControlHint(detailRun.status as WorkflowRunStatus)}</p><p className={styles.support}>Pause applies to this run. Cancel stops this run; it does not pause the originating schedule.</p>{!runCurrent ? <p className={styles.boundary}>The detail and list are not confirmed as the same current snapshot. Refresh both before reviewing a control.</p> : null}<div className={styles.actions}>{workflowSignals(detailRun.status).map((signal) => <button type="button" key={signal} disabled={busy || Boolean(disabledReason) || !runCurrent} onClick={() => prepare("runs", { kind: "signal", label: `${workflowSignalLabel(signal)} run · ${text(run.goal)}`, path: `/api/workflows/${encodeURIComponent(String(run.id))}/signal`, body: { signal }, target: detailRun })}>Review {signal} run</button>)}</div><RunTimeline data={runDetail.data} /></> : null}</section> : null}
      </article></li>)}</ul>
    </WorkflowSection></div>
    <div hidden={view !== "plans"}><Plans read={ledger.plans} busy={busy} disabledReason={disabledReason} refresh={() => void refreshSource("plans")} prepare={(request) => prepare("plans", request)} /></div>
    <div hidden={view !== "schedules"}><WorkflowsSchedules read={ledger.triggers} detail={scheduleDetail} selectedId={scheduleId} busy={busy} disabledReason={disabledReason} refresh={() => void refreshSource("triggers")} select={selectSchedule} prepare={(request) => prepare("triggers", request)} /></div>
    <div hidden={view !== "operations"}><Operations read={ledger.operations} busy={busy} disabledReason={disabledReason} refresh={() => void refreshSource("operations")} prepare={(request) => prepare("operations", request)} /></div>
    <p className={styles.support}>Related work: <Link href="/app/automation?view=automations">Capabilities and saved automations</Link> · <Link href="/app/inbox">Approval inbox</Link> · <Link href="/app/activity">Activity</Link></p>
  </div>;
}

function Plans({ read, busy, disabledReason, refresh, prepare }: { read: WorkflowRead; busy: boolean; disabledReason?: string; refresh: () => void; prepare: (request: DraftReview) => void }) {
  const [goal, setGoal] = useState(""); const [mode, setMode] = useState("orchestrate"); const [approval, setApproval] = useState(true); const [planId, setPlanId] = useState("");
  const [chosenVersion, setChosenVersion] = useState<string>();
  const plans = rows(read.data, "plans"); const selected = plans.find((plan) => plan.id === planId);
  const selectedIdentity = selected ? stable(selected) : undefined;
  const [observedPlanIdentity, setObservedPlanIdentity] = useState(selectedIdentity);
  if (observedPlanIdentity !== selectedIdentity) {
    setObservedPlanIdentity(selectedIdentity);
    if (chosenVersion && selectedIdentity !== chosenVersion) setChosenVersion(undefined);
  }
  const bound = !planId || Boolean(selected && stable(selected) === chosenVersion && selected.goal === goal.trim() && child(selected, "plan")?.mode === mode && selected.status === "planned" && !selected.workflowRunId && child(selected, "validation")?.isDag === true && rows(child(selected, "plan"), "nodes").length);
  const locked = busy || Boolean(disabledReason) || read.status !== "ready";
  function draft(event: FormEvent, start: boolean) {
    event.preventDefault(); if (locked || !goal.trim() || (start && !bound)) return;
    prepare({ kind: start ? "start" : "plan", label: start ? "Start workflow" : "Preview workflow plan", path: start ? "/api/workflows" : "/api/workflows/plan", body: { goal: goal.trim(), mode, requireApproval: approval, ...(start && planId ? { planId } : {}) }, ...(selected && start ? { target: selected } : {}), ...(start ? { idempotent: true } : {}) });
  }
  return <WorkflowSection title="Plans and execution" description="Preview a typed plan and inspect its nodes, risk, policy and acceptance criteria before starting a durable run. Preview can invoke the configured planner."><WorkflowReadNotice label="Workflow plans" read={read} onRefresh={refresh} disabled={busy} />
    <div className={styles.split}><div><form className={styles.form} onSubmit={(event) => draft(event, false)}><fieldset disabled={busy}><label>Workflow goal<textarea required maxLength={4000} value={goal} onChange={(e) => setGoal(e.target.value)} /></label><label>Workflow mode<select value={mode} onChange={(e) => setMode(e.target.value)}>{["orchestrate", "research", "execute", "learn"].map((value) => <option key={value} value={value}>{titleCase(value)}</option>)}</select></label><label className={styles.check}><input type="checkbox" checked={approval} onChange={(e) => setApproval(e.target.checked)} />Require approval</label><label>Reviewed plan<select value={planId} onChange={(e) => { const id = e.target.value; const plan = plans.find((v) => v.id === id); setPlanId(id); setChosenVersion(plan ? stable(plan) : undefined); if (plan) { setGoal(text(plan.goal, "")); setMode(text(child(plan, "plan")?.mode, "orchestrate")); if (plan.approvalRequired) setApproval(true); } }}><option value="">No saved plan — plan during execution</option>{planId && !selected ? <option value={planId}>Unavailable plan · {planId}</option> : null}{plans.map((plan) => <option key={String(plan.id)} value={String(plan.id)}>{text(plan.goal)} · {text(plan.id)}</option>)}</select></label>{planId && !bound ? <p className={styles.error}>This plan changed, was used, is invalid, or no longer matches the goal and mode. Choose a current unused plan or preview a new one.</p> : null}<div className={styles.actions}><button type="submit" disabled={locked || !goal.trim()}>Review plan preview</button><button type="button" disabled={locked || !goal.trim() || !bound} onClick={(event) => draft(event, true)}>Review workflow start</button></div></fieldset></form></div>
      <div>{read.status === "ready" && !plans.length ? <p className={styles.empty}>No plans were returned in this window.</p> : null}<p className={styles.support}>At most 12 plans are shown. Full returned evidence remains available for each plan.</p><ul className={styles.rows}>{plans.map((plan) => <li key={String(plan.id)}><article className={styles.row} aria-label={`Plan · ${text(plan.goal)}`}><h3>{text(plan.goal)}</h3><WorkflowFields values={[["Plan ID", plan.id], ["State", plan.status], ["Planner / model", `${text(plan.planner)} / ${text(plan.model)}`], ["Risk level", plan.highestRiskLevel], ["Confidence reported", plan.confidence], ["Approval required", plan.approvalRequired], ["Bound workflow run", plan.workflowRunId ?? "Not yet bound"]]} /><p>{text(child(plan, "plan")?.summary)}</p><WorkflowEvidence title={`Full typed plan · ${text(plan.id)}`} value={plan} /></article></li>)}</ul></div></div>
  </WorkflowSection>;
}

function Operations({ read, busy, disabledReason, refresh, prepare }: { read: WorkflowRead; busy: boolean; disabledReason?: string; refresh: () => void; prepare: (request: DraftReview) => void }) {
  const [limit, setLimit] = useState("5"); const [slo, setSlo] = useState(true); const [alerts, setAlerts] = useState(false); const [inspectLimit, setInspectLimit] = useState("10"); const [reason, setReason] = useState("");
  const locked = busy || Boolean(disabledReason) || read.status !== "ready";
  const jobs = rows(child(read.data, "latest"), "quarantinedJobs");
  return <WorkflowSection title="Queue and recovery" description="Operator mechanics use the existing queue and lease contracts. Inspecting recovery does not repair or drain it."><WorkflowReadNotice label="Operations" read={read} onRefresh={refresh} disabled={busy} />
    <WorkflowFields values={[["Runnable jobs", child(read.data, "summary")?.runnableJobs], ["Expired leases", child(read.data, "summary")?.expiredLeases], ["Stale workflows", child(read.data, "summary")?.staleWorkflows], ["Quarantined jobs", child(read.data, "summary")?.quarantinedJobs]]} />
    <div className={styles.split}><form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (!locked) prepare({ kind: "inspect", label: "Inspect recovery candidates", path: "/api/operations", body: { action: "inspect_recovery", limit: Number(inspectLimit) } }); }}><h3>Inspect recovery</h3><p>Read stale runs, expired leases and retry candidates without repairing them.</p><fieldset disabled={busy}><label>Recovery inspection limit<select value={inspectLimit} onChange={(e) => setInspectLimit(e.target.value)}>{[5, 10, 20, 50].map((v) => <option key={v} value={v}>{v}</option>)}</select></label><button type="submit" disabled={locked}>Review recovery inspection</button></fieldset></form>
      <form className={styles.form} onSubmit={(e) => { e.preventDefault(); if (!locked) prepare({ kind: "tick", label: "Tick tenant queue", path: "/api/workflows/tick", body: { limit: Number(limit), slo, alerts } }); }}><h3>Tick queue</h3><p className={styles.boundary}>This existing tenant operation can advance workflows, due schedules, resumes, notifications, project execution and connected-source work. It is not restricted to the rows shown here.</p><fieldset disabled={busy}><label>Workflow queue limit<select value={limit} onChange={(e) => setLimit(e.target.value)}>{[1, 3, 5, 10].map((v) => <option key={v} value={v}>{v}</option>)}</select></label><label className={styles.check}><input type="checkbox" checked={slo} onChange={(e) => setSlo(e.target.checked)} />Run SLO monitor</label><label className={styles.check}><input type="checkbox" checked={alerts} onChange={(e) => setAlerts(e.target.checked)} />Dispatch alerts</label><button type="submit" disabled={locked}>Review queue tick</button></fieldset></form></div>
    <section aria-label="Quarantined jobs"><h3>Quarantined jobs</h3><p>Up to 10 returned quarantine rows. Jobs stay stopped until an operator releases or discards them. Run-owned jobs must be discarded by canceling their owning run.</p>{read.status === "ready" && !jobs.length ? <p className={styles.empty}>No quarantined jobs were returned in this window.</p> : null}<label className={styles.form}>Discard reason (optional)<textarea value={reason} disabled={busy} maxLength={500} onChange={(e) => setReason(e.target.value)} /></label><ul className={styles.rows}>{jobs.map((job) => <li key={String(job.id)}><article className={styles.row} aria-label={`Quarantined job · ${text(job.id)}`}><WorkflowFields values={[["Job ID", job.id], ["Type", job.type], ["Attempt", job.attempt], ["Lease lapses", job.leaseLapses], ["Last error", job.lastError ?? "No error returned"], ["Updated", job.updatedAt]]} /><div className={styles.actions}>{(["release", "discard"] as const).map((action) => <button key={action} type="button" disabled={locked} onClick={() => prepare({ kind: "quarantine", label: `${titleCase(action)} quarantined job`, path: `/api/operations/jobs/${encodeURIComponent(String(job.id))}`, body: { action, ...(action === "discard" && reason.trim() ? { reason: reason.trim() } : {}) }, target: job })}>Review {action} · {text(job.id)}</button>)}</div></article></li>)}</ul></section>
    <WorkflowEvidence title="Recovery inspection snapshot" value={read.data?.recovery} /><WorkflowEvidence title="Latest queue jobs and recovery events" value={{ jobs: child(read.data, "latest")?.operationJobs, events: child(read.data, "latest")?.recoveryEvents }} />
  </WorkflowSection>;
}

function RunTimeline({ data }: { data: WorkflowObject }) {
  return <><h3>Run timeline</h3><ol className={styles.timeline}>{rows(data, "steps").map((step) => <li key={String(step.id)}><h4>{text(step.label)} · {titleCase(step.status)}</h4><WorkflowFields values={[["Step ID", step.id], ["Started", step.startedAt ?? "Not started"], ["Completed", step.completedAt ?? "No completion recorded"], ["Error", step.error ?? "No error recorded"]]} /><WorkflowEvidence title={`Step evidence · ${text(step.label)}`} value={step} /></li>)}</ol>{!rows(data, "steps").length ? <p>No steps were returned for this run.</p> : null}<WorkflowEvidence title="Exact typed run events" value={data.events} /></>;
}
function failure(value: unknown) { return value instanceof Error ? value.message : "The workflow service could not be read."; }
function reviewBoundary(review: WorkflowReview) {
  if (review.kind === "plan") return "This requests a plan from the configured planner and stores its result. It does not start the workflow.";
  if (review.kind === "start") return "This creates or replays one durable workflow and can enqueue governed execution. Approval requirements and policy checks remain enforced by the service.";
  if (review.kind === "inspect") return "This POST inspects recovery candidates only. It does not repair leases, requeue or drain jobs.";
  if (review.kind === "tick") return "This advances the existing tenant scheduler and queue, including background work beyond the displayed workflow rows. It may produce external effects through their existing governed paths.";
  if (review.kind === "schedule-create") return "This creates a schedule with immutable authority pins. Replacing a schedule preserves its historical records. Each effect still needs the existing governed execution authority.";
  if (review.kind === "schedule-control") return "This changes only the selected schedule or requests one bounded occurrence. Pausing future scheduling does not cancel work already sent to the server.";
  if (review.kind === "quarantine") return review.body.action === "release" ? "Release returns this job to the queue from its first attempt. The next worker can execute it." : "Discard stops this quarantined job. For a run-owned job, cancel its owning run instead.";
  return "This sends the selected signal to this exact run. The server rechecks its current state; this client does not provide cross-client compare-and-swap or durable replay for signals.";
}
