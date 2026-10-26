"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowUpRight, Check, Pause, Play, RefreshCw, Settings2 } from "lucide-react";
import { AgentsLifecycleBoundary, useAgentRead, useAgentsLifecycle } from "@/components/agents/agents-workspace-lifecycle";
import { agentsActionRequest } from "@/components/agents-workspace-state";
import {
  improvementActionReceipt, improvementCanDiscard, improvementDiffHref, improvementHoldMessage, improvementProjectsView, improvementRepositoriesView, improvementReviewInput,
  improvementStageLabels, improvementRequiresManualRelease, isImprovementActive, parseImprovementSnapshot,
  type ImprovementConfigurationView, type ImprovementCycleView, type ImprovementSnapshot,
} from "@/components/self-improvement-workspace-state";
import styles from "@/components/self-improvement-workspace.module.css";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
function date(value: string, timeZone?: string) {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", ...(timeZone ? { timeZone } : {}) }).format(new Date(value));
}
function stageLabel(cycle: ImprovementCycleView) {
  if (cycle.stage === "ready_for_release" && cycle.approvalExpired) return "Approval expired";
  return improvementRequiresManualRelease(cycle) && cycle.stage === "ready_for_release" ? "Manual release required" : improvementStageLabels[cycle.stage];
}
type Action = "configure" | "pause" | "run" | "review";
type SubmitAction = (action: Action, input: Record<string, unknown>, label: string) => Promise<boolean>;

export function SelfImprovementWorkspace() {
  return <AgentsLifecycleBoundary scope="self-improvement"><ImprovementWorkspace /></AgentsLifecycleBoundary>;
}
function ImprovementWorkspace() {
  const { gate, busy, reason, session, role } = useAgentsLifecycle();
  const state = useAgentRead("/api/self-improvement", (value) => parseImprovementSnapshot(value, session?.context?.tenantId));
  const [selectedConfigurationId, setSelectedConfigurationId] = useState("");
  const [selectedCycleId, setSelectedCycleId] = useState("");
  const [editing, setEditing] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const configuration = state.data?.configurations.find((item) => item.id === selectedConfigurationId) || state.data?.configurations[0];
  const cycles = state.data?.cycles.filter((cycle) => cycle.configurationId === configuration?.id) || [];
  const active = cycles.find(isImprovementActive);
  const hasActiveCycle = Boolean(active);
  const selected = cycles.find((cycle) => cycle.id === selectedCycleId) || active || cycles[0];
  const current = state.current && !reason && !busy;
  const refresh = state.refresh;
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden && !gate.busy()) void refresh(); }, hasActiveCycle ? 15_000 : 60_000);
    return () => window.clearInterval(timer);
  }, [gate, refresh, hasActiveCycle]); // Refresh only while this page is mounted and visible.

  async function submit(action: Action, input: Record<string, unknown>, label: string): Promise<boolean> {
    if (!current || gate.busy()) return false;
    const token = gate.begin("/api/self-improvement", "POST", { action, input }, label, input);
    if (!token) return false;
    setError(""); setMessage("");
    try {
      const payload = await agentsActionRequest(token);
      if (!gate.current(token)) return false;
      setMessage(improvementActionReceipt(action, input, payload));
      setSelectedCycleId(""); gate.finish(token, true); return true;
    } catch (caught) {
      if (gate.current(token)) setError(caught instanceof Error ? caught.message : "The change was not confirmed. Refresh to check its result.");
      return false;
    } finally { gate.finish(token, false); }
  }

  return <div className={styles.shell} data-testid="self-improvement-workspace">
    <Link href="/app/agents" className={styles.back}><ArrowLeft size={16} aria-hidden="true" />Agents</Link>
    <header className={styles.header}>
      <div><h1>Self-improvement</h1><p>Asael investigates problems, tests a repair, and records what changed.</p></div>
      <button className="action-button" disabled={Boolean(busy) || state.loading} onClick={() => void state.refresh()}><RefreshCw size={16} aria-hidden="true" />Refresh status</button>
    </header>
    <p className={styles.feedback} role="status" aria-live="polite">{busy || message}</p>
    {error || state.error ? <div className={styles.error} role="alert"><strong>{error ? "Change not confirmed" : "Status unavailable"}</strong><p>{error || state.error}</p>{state.data ? <p>Showing the last loaded records. Controls are available after a successful refresh.</p> : null}</div> : null}
    {reason ? <p className={styles.notice}>{reason}</p> : null}
    {!state.data && state.loading ? <section className={styles.loading} aria-busy="true" aria-label="Loading improvement status"><p>Loading daily settings and recent work…</p><div /><div /></section> : null}
    {state.data ? <>
      <div className={styles.connections} aria-label="Required connections">
        <span><span className={styles.dot} data-tone={state.data.github.configured ? "neutral" : "warning"} />GitHub {state.data.github.configured ? "configured" : "setup needed"}</span>
        <ControllerStatus controller={state.data.controller} />
      </div>
      {!state.data.github.configured ? <p className={styles.notice}>Repository access needs setup before a cycle can start. Missing: {state.data.github.missing.join(", ")}.</p> : null}
      {state.data.configurations.length > 1 ? <label className={styles.configurationSelect}>Repository<select value={configuration?.id || ""} disabled={Boolean(busy)} onChange={(event) => { setSelectedConfigurationId(event.target.value); setSelectedCycleId(""); setEditing(false); }}>{state.data.configurations.map((item) => <option key={item.id} value={item.id}>{item.repository.owner}/{item.repository.name}</option>)}</select></label> : null}
      {configuration ? <section className={styles.schedule} aria-labelledby="daily-heading">
        <div><h2 id="daily-heading">Daily improvement <span className={styles.label}>{configuration.paused ? "Paused" : "Scheduled"}</span></h2>
          <p>{String(configuration.dailyHour).padStart(2, "0")}:00 · {configuration.timeZone} · Up to {money.format(configuration.policy.dailyBudgetUsd)} per UTC day</p>
          <p className={styles.secondary}>{configuration.paused ? "New cycles are paused." : `Next check: ${date(configuration.nextDueAt, configuration.timeZone)}.`} {configuration.policy.autoReleaseRoutineChanges ? "Routine repairs can release after verification. Larger changes need your review; protected code needs a manual release." : "Every repair needs your review before release. Protected code needs a manual release."}</p>
          {!configuration.policy.notifyOutcomes ? <p className={styles.secondary}>Outcome notifications are off for new cycles.</p> : null}
        </div>
        <div className={styles.actions}>
          <button className="primary-button" disabled={!current || configuration.paused || Boolean(active) || !state.data.github.configured} onClick={() => void submit("run", { configurationId: configuration.id, expectedGeneration: configuration.generation }, "Starting an improvement cycle")}><Play size={16} aria-hidden="true" />Run now</button>
          <button className="action-button" disabled={!current} onClick={() => void submit("pause", { configurationId: configuration.id, expectedGeneration: configuration.generation, paused: !configuration.paused }, configuration.paused ? "Resuming daily improvement" : "Pausing daily improvement")}>{configuration.paused ? <Play size={16} aria-hidden="true" /> : <Pause size={16} aria-hidden="true" />}{configuration.paused ? "Resume schedule" : "Pause schedule"}</button>
          {role === "admin" ? <button className={styles.textButton} disabled={Boolean(busy)} aria-expanded={editing} onClick={() => setEditing(!editing)}><Settings2 size={16} aria-hidden="true" />Settings</button> : null}
        </div>
      </section> : <section className={styles.empty} aria-labelledby="setup-heading"><h2 id="setup-heading">Give Asael time to improve</h2><p>Choose a project for its work, a daily spending limit, and when to investigate. Atlas directs the repair, Forge changes the code, and Sentinel reviews the evidence.</p>{!editing && role === "admin" ? <button className="primary-button" disabled={!current || !state.data.github.configured} onClick={() => setEditing(true)}>Set up daily improvement</button> : null}{role !== "admin" ? <p>The workspace owner can set up daily improvement.</p> : null}</section>}
      {editing && role === "admin" ? <SettingsForm key={`${configuration?.id || "new"}:${configuration?.generation || 0}`} configuration={configuration} disabled={!current} submit={submit} onClose={() => setEditing(false)} /> : null}
      {selected ? <CycleDetail key={`${selected.id}:${selected.revision}`} cycle={selected} current={current} submit={submit} /> : configuration ? <section className={styles.empty}><h2>No cycles yet</h2><p>The first investigation will appear here after a scheduled check or Run now.</p></section> : null}
      {cycles.length ? <section className={styles.history} aria-labelledby="history-heading"><header className={styles.sectionHeader}><h2 id="history-heading">Recent work</h2><span className={styles.secondary}>{cycles.length} {cycles.length === 1 ? "cycle" : "cycles"}</span></header>
        <ol>{cycles.map((cycle) => <li key={cycle.id}><button className={styles.historyRow} aria-pressed={selected?.id === cycle.id} disabled={Boolean(busy)} onClick={() => setSelectedCycleId(cycle.id)}><span className={styles.historyText}><strong>{cycle.summary || stageLabel(cycle)}</strong><span>{date(cycle.createdAt, configuration?.timeZone)}</span></span><span className={styles.cycleStatus} data-tone={tone(cycle.stage)}>{stageLabel(cycle)}</span><span className={styles.cost}>{cycle.usageState === "known" ? money.format(cycle.spendUsd) : "Cost pending"}</span></button></li>)}</ol>
      </section> : null}
    </> : null}
  </div>;
}

export function ControllerStatus({ controller }: { controller: ImprovementSnapshot["controller"] }) {
  const label = !controller ? "Release controller status unavailable" : controller.status === "not_connected" ? "Release controller not connected" : controller.status === "offline" ? "Release controller offline" : controller.activity === "held" ? "Release controller needs attention" : "Release controller online";
  const warning = !controller || controller.status !== "online" || controller.activity === "held";
  return <span title={controller && "lastSeenAt" in controller ? `Last contact: ${date(controller.lastSeenAt)}. ${controller.category ? `Status: ${controller.category.replaceAll("_", " ")}.` : ""}` : "Releasing a verified repair requires a connected release controller."}><span className={styles.dot} data-tone={warning ? "warning" : "success"} />{label}</span>;
}

function SettingsForm({ configuration, disabled, submit, onClose }: { configuration?: ImprovementConfigurationView; disabled: boolean; submit: SubmitAction; onClose: () => void }) {
  const [projectId, setProjectId] = useState(configuration?.projectId || "");
  const [repositoryId, setRepositoryId] = useState(configuration?.repositoryId || "");
  const [budget, setBudget] = useState(configuration ? String(configuration.policy.dailyBudgetUsd) : "");
  const [hour, setHour] = useState(configuration?.dailyHour ?? 3);
  const [timeZone, setTimeZone] = useState(configuration?.timeZone || "Asia/Kolkata");
  const [automatic, setAutomatic] = useState(configuration?.policy.autoReleaseRoutineChanges ?? true);
  const [notifyOutcomes, setNotifyOutcomes] = useState(configuration?.policy.notifyOutcomes ?? true);
  const [error, setError] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault(); setError("");
    try { new Intl.DateTimeFormat(undefined, { timeZone }).format(); }
    catch { setError("Enter a valid time zone, such as Asia/Kolkata."); return; }
    if (!projectId || !repositoryId) { setError("Choose the project and Asael repository first."); return; }
    if (await submit("configure", { projectId, repositoryId, dailyBudgetUsd: Number(budget), dailyHour: hour, timeZone, autoReleaseRoutineChanges: automatic, notifyOutcomes, ...(configuration ? { expectedGeneration: configuration.generation } : {}) }, "Saving daily improvement settings")) onClose();
  }
  return <form className={styles.settings} onSubmit={(event) => void save(event)} aria-labelledby="settings-heading"><h2 id="settings-heading">Daily settings</h2>
    <fieldset disabled={disabled}>
      {!configuration ? <TargetFields projectId={projectId} repositoryId={repositoryId} onProject={setProjectId} onRepository={setRepositoryId} /> : null}
      <div className={styles.fields}><label>Daily AI limit (UTC)<input type="number" min="0.01" max="100" step="0.01" inputMode="decimal" required value={budget} onChange={(event) => setBudget(event.target.value)} aria-describedby="budget-help" /><small id="budget-help">In US dollars. Includes work carried over from earlier days; schedule uses your selected time zone.</small></label>
        <label>Daily start time<select value={hour} onChange={(event) => setHour(Number(event.target.value))}>{Array.from({ length: 24 }, (_, value) => <option key={value} value={value}>{String(value).padStart(2, "0")}:00</option>)}</select></label>
        <label>Time zone<input value={timeZone} required maxLength={80} onChange={(event) => setTimeZone(event.target.value.trim())} list="improvement-time-zones" /><datalist id="improvement-time-zones"><option value="Asia/Kolkata" /><option value="Europe/London" /><option value="America/New_York" /><option value="America/Los_Angeles" /><option value="UTC" /></datalist></label></div>
      <label className={styles.checkField}><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} /><span><strong>Release verified routine repairs automatically</strong><small>Larger changes need your review. Protected code, including security, deployment, dependencies and native apps, also needs a trusted manual release.</small></span></label>
      <label className={styles.checkField}><input type="checkbox" checked={notifyOutcomes} onChange={(event) => setNotifyOutcomes(event.target.checked)} /><span><strong>Outcome notifications</strong><small>Notify me when a repair finishes or needs attention. Applies to new cycles; their results remain here when notifications are off.</small></span></label>
      {error ? <p role="alert" className={styles.errorText}>{error}</p> : null}
      <div className={styles.actions}><button type="submit" className="primary-button">Save daily settings</button><button type="button" className="action-button" onClick={onClose}>Cancel</button></div>
    </fieldset>
  </form>;
}
function TargetFields({ projectId, repositoryId, onProject, onRepository }: { projectId: string; repositoryId: string; onProject: (value: string) => void; onRepository: (value: string) => void }) {
  const projects = useAgentRead("/api/projects?view=summary&limit=100", (value) => improvementProjectsView.parse(value).projects);
  const repositories = useAgentRead("/api/self-improvement?view=repositories", (value) => improvementRepositoriesView.parse(value).repositories.filter((item) => item.fullName.toLowerCase() === "benniejoseph/omniagentos"));
  return <><div className={styles.fields}><label>Project for this work<select required disabled={!projects.current} value={projectId} onChange={(event) => onProject(event.target.value)}><option value="">{projects.loading ? "Loading projects…" : "Choose a project"}</option>{projects.data?.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label><label>Asael repository<select required disabled={!repositories.current} value={repositoryId} onChange={(event) => onRepository(event.target.value)}><option value="">{repositories.loading ? "Loading repository…" : "Choose Asael’s repository"}</option>{repositories.data?.map((item) => <option key={item.repositoryId} value={item.repositoryId}>{item.fullName}</option>)}</select></label></div>
    {projects.error || repositories.error ? <p className={styles.errorText} role="alert">{projects.error || repositories.error} <button type="button" className={styles.textButton} onClick={() => { void projects.refresh(); void repositories.refresh(); }}>Reload choices</button></p> : null}
    {projects.current && !projects.data?.length ? <p>Create a <Link href="/app/projects">project</Link> to hold Asael’s improvement work, then return here.</p> : null}
    {repositories.current && !repositories.data?.length ? <p>Asael’s source repository is not available to the configured GitHub App.</p> : null}
  </>;
}

function tone(stage: ImprovementCycleView["stage"]) {
  return stage === "succeeded" ? "success" : ["failed", "rolled_back"].includes(stage) ? "danger" : stage === "review_required" ? "warning" : isImprovementActive({ stage }) ? "info" : "neutral";
}
const checkNames: Record<string, string> = { focused_regression: "Reported problem", adjacent_regression: "Related behavior", typecheck: "Type checks", independent_review: "Independent review", behavior_comparison: "Behavior comparison", build: "Build", lint: "Code quality" };
function CycleDetail({ cycle, current, submit }: { cycle: ImprovementCycleView; current: boolean; submit: SubmitAction }) {
  const [error, setError] = useState("");
  const diffHref = improvementDiffHref(cycle);
  const renewApproval = cycle.stage === "ready_for_release" && cycle.approvalExpired && cycle.approvalRenewalAvailable;
  const needsReview = cycle.stage === "review_required" || renewApproval;
  const manualRelease = improvementRequiresManualRelease(cycle);
  const canDiscard = improvementCanDiscard(cycle);
  async function review(decision: "approve" | "reject") {
    try { setError(""); await submit("review", improvementReviewInput(cycle, decision), decision === "approve" ? renewApproval ? "Renewing approval" : "Approving this repair" : canDiscard ? "Discarding candidate" : "Declining this repair"); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "This review is no longer current."); }
  }
  return <section className={`${styles.cycle} ${needsReview ? styles.review : ""}`} aria-labelledby="cycle-heading">
    <header className={styles.sectionHeader}><div><span className={styles.cycleStatus} data-tone={tone(cycle.stage)}>{stageLabel(cycle)}</span><h2 id="cycle-heading">{needsReview ? "Review this repair" : "Cycle details"}</h2></div><time dateTime={cycle.updatedAt} className={styles.secondary}>Updated {date(cycle.updatedAt)}</time></header>
    <p className={styles.summary}>{cycle.summary || "Asael has not recorded an investigation summary yet."}</p>
    {needsReview ? <p>Review the exact code changes and recorded checks below. Approval applies to this repair only.</p> : null}
    {cycle.approvalExpired ? <p className={styles.notice}>The previous approval expired. {renewApproval ? "Renew approval for the same code and saved checks; this does not start another repair." : "The code and checks are retained. Renewal is not available in the current release state."}</p> : null}
    {needsReview && manualRelease ? <p className={styles.notice}>This repair changes protected code. After your review, a trusted operator must release it manually.</p> : null}
    {cycle.classification?.reasons.length && needsReview ? <p className={styles.secondary}>Review needed: {cycle.classification.reasons.map((reason) => reason.replaceAll("_", " ")).join(", ")}.</p> : null}
    {cycle.controllerHold ? <div className={styles.notice} role="status"><strong>{manualRelease ? "Manual release required" : "Release needs attention"}</strong><p>{improvementHoldMessage(cycle.controllerHold.category)} {manualRelease ? "The automatic controller will not deploy these files." : "Automatic retry is stopped."}</p><p className={styles.secondary}>Recorded {date(cycle.controllerHold.occurredAt)}. {manualRelease ? "The code changes and validation remain available for the release operator." : "Ask Asael to investigate this hold before continuing."}</p></div> : cycle.stage === "ready_for_release" && !cycle.approvalExpired ? <p className={styles.notice}>{manualRelease ? "Validation is complete. This repair needs a trusted manual release." : "Validation is complete. Release waits for the connected controller and its production checks."}</p> : null}
    {cycle.agentRuns.length ? <ul className={styles.agents} aria-label="Agent work">{cycle.agentRuns.map((run) => <li key={run.runId}><Link href={`/app/agents?view=live&run=${encodeURIComponent(run.runId)}`}><strong>{run.agentId === "atlas" ? "Atlas" : run.agentId === "forge" ? "Forge" : "Sentinel"}</strong><span>{run.phase.replaceAll("_", " ")} · {run.completed ? "completed" : "recorded"}</span><ArrowUpRight size={14} aria-hidden="true" /></Link></li>)}</ul> : null}
    {cycle.validation ? <div className={styles.validation}><h3>Validation evidence</h3>{cycle.validation.baselineReproduction ? <p className={styles.secondary}>Original problem reproduced: {cycle.validation.baselineReproduction.failedCases} failing {cycle.validation.baselineReproduction.failedCases === 1 ? "case" : "cases"} out of {cycle.validation.baselineReproduction.executedCases} executed.</p> : null}
      <ul>{cycle.validation.checks.map((item) => <li key={item.id}><span>{checkNames[item.kind]}</span><span data-tone={item.outcome === "passed" ? "success" : "warning"}>{item.outcome === "passed" ? <Check size={14} aria-hidden="true" /> : null}{item.outcome.replaceAll("_", " ")}</span><span className={styles.secondary}>{item.executedCases}/{item.declaredCases} {item.kind === "independent_review" ? "review" : "checks"}{item.failedCases ? ` · ${item.failedCases} failed` : ""}</span></li>)}</ul></div> : null}
    {cycle.candidate ? <div className={styles.changeSummary}><p>{cycle.candidate.changedFiles.length} {cycle.candidate.changedFiles.length === 1 ? "file" : "files"} changed · {cycle.candidate.changedLines} changed lines</p>{diffHref ? <a href={diffHref} target="_blank" rel="noopener noreferrer">Inspect exact code changes<ArrowUpRight size={16} aria-hidden="true" /></a> : null}</div> : null}
    {needsReview ? <div className={styles.reviewActions}><button className="primary-button" disabled={!current || !cycle.candidate || !cycle.validation} onClick={() => void review("approve")}>{renewApproval ? "Renew approval" : manualRelease ? "Approve for manual release" : "Approve this repair"}</button><button className="action-button" disabled={!current || !cycle.candidate || !cycle.validation} onClick={() => void review("reject")}>Decline repair</button>{error ? <p className={styles.errorText} role="alert">{error}</p> : null}</div> : null}
    {canDiscard ? <div><p className={styles.secondary}>Discard this held candidate to let future work resume. Its code changes and evidence remain available.</p><div className={styles.reviewActions}><button className="action-button" disabled={!current || !cycle.candidate || !cycle.validation} onClick={() => void review("reject")}>Discard candidate</button>{error ? <p className={styles.errorText} role="alert">{error}</p> : null}</div></div> : null}
    <details className={styles.technical}><summary>Technical details</summary><dl><div><dt>Cycle</dt><dd>{cycle.id}</dd></div><div><dt>Phase</dt><dd>{cycle.phase.replaceAll("_", " ")}</dd></div><div><dt>Base revision</dt><dd>{cycle.scope.baseRevision}</dd></div>{cycle.candidate ? <><div><dt>Candidate revision</dt><dd>{cycle.candidate.revision}</dd></div><div><dt>Candidate fingerprint</dt><dd>{cycle.candidate.candidateSha256}</dd></div></> : null}{cycle.validation ? <div><dt>Validation fingerprint</dt><dd>{cycle.validation.validationSha256}</dd></div> : null}<div><dt>Recorded model cost</dt><dd>{cycle.usageState === "known" ? money.format(cycle.spendUsd) : "Not fully reconciled"}</dd></div>{cycle.releaseReceipt ? <div><dt>Release receipt</dt><dd>{cycle.releaseReceipt.outcome} · web {cycle.releaseReceipt.webRevision} · worker {cycle.releaseReceipt.workerRevision}</dd></div> : null}</dl>{cycle.candidate ? <ul>{cycle.candidate.changedFiles.map((file) => <li key={file.path}>{file.path}</li>)}</ul> : null}</details>
  </section>;
}
