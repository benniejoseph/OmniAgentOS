"use client";

import { useState } from "react";
import { child, rows, stable, text, titleCase, type WorkflowObject, type WorkflowRead, type WorkflowReview } from "./workflows-workspace-state";
import { WorkflowEvidence, WorkflowFields, WorkflowReadNotice, WorkflowSection } from "./workflows-workspace-parts";
import styles from "./workflows-workspace.module.css";

type Props = {
  read: WorkflowRead; detail: WorkflowRead; selectedId?: string; busy: boolean; disabledReason?: string;
  refresh: () => void; select: (id: string | undefined) => void; prepare: (review: Omit<WorkflowReview, "source" | "version">) => void;
};
const configOf = (trigger: unknown) => child(child(trigger, "schedule"), "config");
const stateOf = (trigger: unknown) => child(child(trigger, "schedule"), "state");

export function WorkflowsSchedules({ read, detail, selectedId, busy, disabledReason, refresh, select, prepare }: Props) {
  const triggers = rows(read.data, "triggers");
  const schedules = triggers.filter((v) => v.triggerKind === "schedule");
  const [formOpen, setFormOpen] = useState(false);
  const [replacement, setReplacement] = useState<WorkflowObject>();
  const [builderKey, setBuilderKey] = useState(0);
  const [reason, setReason] = useState("");
  const selected = schedules.find((v) => v.id === selectedId);
  const loadedTrigger = child(detail.data, "trigger");
  const currentDetail = Boolean(selected && loadedTrigger && stable(selected) === stable(loadedTrigger) && detail.status === "ready" && read.status === "ready");
  const locked = Boolean(busy || disabledReason || read.status !== "ready");
  function control(trigger: WorkflowObject, action: "pause" | "resume" | "run_once") {
    if (locked || !currentDetail || trigger.replacedByTriggerId || (action === "run_once" && (trigger.status !== "active" || stateOf(trigger)?.circuitState !== "closed"))) return;
    prepare({ kind: "schedule-control", label: `${action === "run_once" ? "Run once" : titleCase(action)} · ${text(trigger.name)}`, path: `/api/triggers/${encodeURIComponent(String(trigger.id))}`, body: { action, ...(action === "pause" && reason.trim() ? { reason: reason.trim() } : {}), ...(action === "run_once" ? { scheduledFor: new Date().toISOString() } : {}) }, target: trigger, idempotent: true });
  }
  return <WorkflowSection title="Schedules and triggers" description="Schedules bind a saved procedure, an exact Agent release, policy, and a per-occurrence budget. This is the existing scheduler; it does not create a new responsibility contract.">
    <WorkflowReadNotice label="Schedules and triggers" read={read} onRefresh={refresh} disabled={busy} />
    <div className={styles.actions}><button type="button" disabled={busy} aria-expanded={formOpen} onClick={() => setFormOpen(!formOpen)}>{formOpen ? "Hide schedule editor" : "Open schedule editor"}</button>{replacement ? <button type="button" disabled={busy} onClick={() => { setReplacement(undefined); setBuilderKey((n) => n + 1); setFormOpen(true); }}>Start a new schedule draft</button> : null}</div>
    <div hidden={!formOpen}><ScheduleEditor key={builderKey} read={read} replacement={replacement} busy={busy} disabledReason={disabledReason} prepare={prepare} /></div>
    {!read.data ? null : <p className={styles.support}>{read.status !== "ready" ? "Last loaded: " : ""}{schedules.length} schedules and {triggers.length - schedules.length} webhook triggers in this window of at most 12 triggers. History and preview are read separately.</p>}
    {read.status === "ready" && !triggers.length ? <p className={styles.empty}>No schedules or webhook triggers were returned in this window.</p> : null}
    <ul className={styles.rows}>{triggers.map((trigger) => {
      const config = configOf(trigger); const state = stateOf(trigger); const schedule = trigger.triggerKind === "schedule";
      return <li key={String(trigger.id)}><article className={styles.row} aria-label={text(trigger.name)}>
        <div className={styles.rowHeader}><div><h3>{text(trigger.name)}</h3><code>{text(trigger.id)}</code></div><span className={styles.status}>{titleCase(trigger.status)}{state ? ` · circuit ${text(state.circuitState)}` : " · webhook"}</span></div>
        {schedule ? <><WorkflowFields values={[["Timezone", config?.timezone], ["Recurrence", config?.rrule], ["Next scheduled instant", state?.nextDueAt ?? "No next instant in the loaded schedule"], ["Missed runs", config?.missedPolicy === "run_once" ? "Run the latest missed occurrence once" : "Skip missed occurrences"], ["Consecutive failures", state?.consecutiveFailureCount], ["Automatic pause threshold", config?.failureLimit], ["Pause reason", state?.pausedReason ?? "No reason recorded"]]} />
          <div className={styles.actions}><button type="button" disabled={busy} aria-expanded={selectedId === trigger.id} onClick={() => select(selectedId === trigger.id ? undefined : String(trigger.id))}>Inspect {text(trigger.name)}</button><button type="button" disabled={locked} onClick={() => { setReplacement(trigger); setBuilderKey((n) => n + 1); setFormOpen(true); requestAnimationFrame(() => document.getElementById("workflow-schedule-editor")?.focus()); }}>Edit by replacement · {text(trigger.name)}</button></div>
          {selectedId === trigger.id ? <section className={styles.detail} aria-label={`Schedule detail · ${text(trigger.name)}`}>
            <button type="button" onClick={() => select(undefined)}>Back to schedules</button>
            <WorkflowReadNotice label="Schedule preview and history" read={detail} onRefresh={() => select(String(trigger.id))} disabled={busy} />
            {detail.data && loadedTrigger ? <>
              {!currentDetail ? <p className={styles.boundary}>The loaded detail is not confirmed against the current list. Refresh both reads before using schedule controls.</p> : null}
              <WorkflowFields values={[["Schedule ID", loadedTrigger.id], ["Owner", loadedTrigger.ownerActorId], ["Configuration SHA-256", configOf(loadedTrigger)?.configSha256], ["Procedure ID", child(configOf(loadedTrigger), "procedurePin")?.procedureId], ["Agent ID", child(configOf(loadedTrigger), "agentIdentityPin")?.logicalAgentId], ["Authority", configOf(loadedTrigger)?.authorityMode ?? "read_only"]]} />
              <WorkflowEvidence title="Immutable procedure, Agent, policy and budget pins" value={configOf(loadedTrigger)} />
              <div><h4>Next possible occurrences</h4><p className={styles.support}>Up to six instants from the loaded configuration. A paused schedule or open circuit does not execute these automatically.</p>
                <ol className={styles.timeline}>{(child(detail.data, "preview")?.occurrences as string[] | undefined)?.map((date) => <li key={date}><time dateTime={date}>{zoned(date, String(config?.timezone))}</time><div><code>{date}</code></div></li>)}</ol>
                {Array.isArray(child(detail.data, "preview")?.occurrences) && (child(detail.data, "preview")?.occurrences as unknown[]).length === 0 ? <p>No next occurrences were returned.</p> : null}
              </div>
              <p className={styles.boundary}>Pause stops future scheduling. It does not cancel an occurrence or workflow already sent to the queue. Resume retains the missed-run policy and existing authority checks.</p>
              <label className={styles.form}>Pause reason (optional)<textarea value={reason} maxLength={500} disabled={busy} onChange={(event) => setReason(event.target.value)} /></label>
              <div className={styles.actions}>
                <button type="button" disabled={locked || !currentDetail || Boolean(trigger.replacedByTriggerId)} onClick={() => control(trigger, trigger.status === "active" ? "pause" : "resume")}>Review {trigger.status === "active" ? "pause" : "resume"} schedule</button>
                <button type="button" disabled={locked || !currentDetail || Boolean(trigger.replacedByTriggerId) || trigger.status !== "active" || state?.circuitState !== "closed"} onClick={() => control(trigger, "run_once")}>Review run once</button>
              </div>
              {trigger.status !== "active" || state?.circuitState !== "closed" ? <p>A manual run requires an active schedule with a closed circuit.</p> : null}
              {trigger.replacedByTriggerId ? <p>This schedule has been replaced by {text(trigger.replacedByTriggerId)}. Its immutable history remains available.</p> : null}
              <ScheduleHistory detail={detail.data} />
            </> : null}
          </section> : null}
        </> : <><WorkflowFields values={[["Source", trigger.source], ["Authentication", trigger.authMode], ["Approval required", trigger.requireApproval]]} /><WorkflowEvidence title={`Webhook metadata · ${text(trigger.name)}`} value={trigger} /><p className={styles.support}>Webhook configuration remains managed through the existing capability contracts.</p></>}
      </article></li>;
    })}</ul>
    <details className={styles.evidence}><summary>Returned procedure eligibility and trigger events</summary><WorkflowEvidence title="Procedure eligibility" value={read.data?.procedures} /><WorkflowEvidence title="Trigger events" value={read.data?.events} /></details>
  </WorkflowSection>;
}

function ScheduleHistory({ detail }: { detail: WorkflowObject }) {
  const occurrences = rows(detail, "occurrences"); const receipts = rows(detail, "receipts"); const leases = child(detail, "policyLeases");
  return <section aria-label="Schedule outcome history"><h4>Occurrence and lease history</h4><p className={styles.support}>{occurrences.length} loaded occurrences (maximum 30), {receipts.length} immutable receipts (maximum 60). {leases?.available ? `${rows(leases, "outcomes").length} loaded lease outcomes (maximum 100).` : "PolicyLease history unavailable; its count is unknown."}</p>
    {!occurrences.length ? <p className={styles.empty}>No occurrences were returned in this history window.</p> : <ol className={styles.timeline}>{occurrences.map((occurrence) => <li key={String(occurrence.id)}><h4>{titleCase(occurrence.status)} · {text(occurrence.scheduledFor)}</h4><WorkflowFields values={[["Occurrence ID", occurrence.id], ["Kind", occurrence.kind], ["Outcome", occurrence.outcome], ["Failure code", occurrence.failureCode ?? "No failure recorded"], ["Workflow run ID", occurrence.workflowRunId ?? "No run binding returned"], ["Queue job ID", occurrence.queueJobId ?? "No queue binding returned"]]} />
      <WorkflowEvidence title={`Exact occurrence · ${text(occurrence.id)}`} value={occurrence} /><WorkflowEvidence title={`Immutable receipts · ${text(occurrence.id)}`} value={receipts.filter((receipt) => receipt.occurrenceId === occurrence.id)} />
    </li>)}</ol>}
    <WorkflowEvidence title="All returned occurrence receipts" value={receipts} />
    <WorkflowEvidence title="PolicyLease outcomes and exact bindings" value={leases} />
    <p className={styles.support}>An issued lease is authority for one exact effect; consumption is not proof that the business outcome succeeded. Occurrence and run outcomes remain separate.</p>
  </section>;
}

function ScheduleEditor({ read, replacement, busy, disabledReason, prepare }: Pick<Props, "read" | "busy" | "disabledReason" | "prepare"> & { replacement?: WorkflowObject }) {
  const config = configOf(replacement);
  const [name, setName] = useState(text(replacement?.name, ""));
  const [procedureId, setProcedureId] = useState(text(child(config, "procedurePin")?.procedureId, ""));
  const [agentId, setAgentId] = useState(text(child(config, "agentIdentityPin")?.logicalAgentId, ""));
  const [timezone, setTimezone] = useState(text(config?.timezone, "UTC"));
  const [rrule, setRrule] = useState(text(config?.rrule, "FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0"));
  const [startsAt, setStartsAt] = useState(text(config?.startsAt, ""));
  const [endsAt, setEndsAt] = useState(text(config?.endsAt, ""));
  const [maximum, setMaximum] = useState(String(config?.maxOccurrences ?? 365));
  const [failureLimit, setFailureLimit] = useState(String(config?.failureLimit ?? 3));
  const [missedPolicy, setMissedPolicy] = useState(text(config?.missedPolicy, "skip"));
  const [acknowledged, setAcknowledged] = useState<string>();
  const [error, setError] = useState<string>();
  const procedures = rows(read.data, "procedures"); const agents = rows(read.data, "agents");
  const procedure = procedures.find((v) => v.id === procedureId); const agent = agents.find((v) => v.id === agentId);
  const budget = config?.occurrenceBudget ?? child(read.data, "scheduleDefaults")?.occurrenceBudget;
  const authorityMode = text(procedure?.authorityMode, "read_only");
  const authorityIdentity = stable([procedure, agent, budget]);
  const [previousAuthority, setPreviousAuthority] = useState(authorityIdentity);
  if (previousAuthority !== authorityIdentity) { setPreviousAuthority(authorityIdentity); setAcknowledged(undefined); }
  const reviewIdentity = stable([procedure, agent, budget, name, timezone, rrule, startsAt, endsAt, maximum, failureLimit, missedPolicy, replacement]);
  const currentReplacement = !replacement || rows(read.data, "triggers").some((v) => v.id === replacement.id && stable(v) === stable(replacement));
  const ready = read.status === "ready" && procedure?.schedulable === true && agent && budget && currentReplacement;
  return <form id="workflow-schedule-editor" tabIndex={-1} className={styles.detail} onSubmit={(event) => {
    event.preventDefault(); setError(undefined);
    try {
      if (!ready || disabledReason || busy) throw new Error(disabledReason || "Refresh the current procedure, Agent and replacement schedule before reviewing.");
      if (acknowledged !== reviewIdentity) throw new Error("Review and acknowledge the exact configuration first.");
      const start = explicitInstant(startsAt); const end = endsAt.trim() ? explicitInstant(endsAt) : undefined;
      if (end && Date.parse(end) <= Date.parse(start)) throw new Error("The end instant must be after the start instant.");
      new Intl.DateTimeFormat("en", { timeZone: timezone.trim() });
      const max = Number(maximum); const failures = Number(failureLimit);
      if (!Number.isInteger(max) || max < 1 || max > 10000 || !Number.isInteger(failures) || failures < 1 || failures > 20) throw new Error("Maximum occurrences must be 1–10,000 and the failure limit 1–20.");
      const body = { triggerKind: "schedule", name: name.trim(), procedureId, agentId, timezone: timezone.trim(), rrule: rrule.trim(), startsAt: start, ...(end ? { endsAt: end } : {}), maxOccurrences: max, missedPolicy, failureLimit: failures, occurrenceBudget: budget, authorityMode, ...(replacement ? { replacesTriggerId: replacement.id } : {}), ...(authorityMode === "reviewed_mutation" ? { reviewedMutationBindingsSha256: procedure?.reviewDigest, mutationAcknowledged: true } : {}) };
      prepare({ kind: "schedule-create", label: replacement ? "Create immutable schedule replacement" : "Create reviewed schedule", path: "/api/triggers", body, target: replacement, idempotent: true });
    } catch (caught) { setError(caught instanceof Error ? caught.message : "The schedule draft is invalid."); }
  }}>
    <h3>{replacement ? "Replace schedule" : "Schedule a saved procedure"}</h3>
    <p>Review the procedure and its eligible effects. The server pins its current immutable snapshot, Agent release, policy and budget when accepting the schedule. A replacement retains the previous schedule’s history.</p>
    {replacement ? <WorkflowFields values={[["Replacing schedule ID", replacement.id], ["Reviewed configuration SHA-256", config?.configSha256]]} /> : null}
    {!currentReplacement ? <p className={styles.error}>The replacement source changed. Reopen its editor from the current schedule before submitting.</p> : null}
    <fieldset className={styles.form} disabled={busy}>
      <div className={styles.formGrid}>
        <label>Schedule name<input required maxLength={120} value={name} onChange={(e) => setName(e.target.value)} /></label>
        <label>Saved procedure<select required value={procedureId} onChange={(e) => setProcedureId(e.target.value)}><option value="">Choose a procedure</option>{procedureId && !procedure ? <option value={procedureId}>Unavailable selection · {procedureId}</option> : null}{procedures.map((v) => <option value={String(v.id)} key={String(v.id)} disabled={v.schedulable !== true}>{text(v.id)}{v.schedulable !== true ? " · unavailable" : ""}</option>)}</select></label>
        <label>Executing Agent<select required value={agentId} onChange={(e) => setAgentId(e.target.value)}><option value="">Choose an Agent</option>{agentId && !agent ? <option value={agentId}>Unavailable selection · {agentId}</option> : null}{agents.map((v) => <option value={String(v.id)} key={String(v.id)}>{text(v.name)} · {text(v.id)}</option>)}</select></label>
        <label>Schedule timezone<input required value={timezone} maxLength={120} onChange={(e) => setTimezone(e.target.value)} /><span className={styles.support}>IANA timezone, such as Asia/Kolkata. Recurrence hours use this timezone.</span></label>
        <label>Start instant<input required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} placeholder="2026-10-10T09:00:00+05:30" /><span className={styles.support}>Include Z or an explicit UTC offset. The browser’s local timezone is never substituted.</span></label>
        <label>End instant (optional)<input value={endsAt} onChange={(e) => setEndsAt(e.target.value)} placeholder="2027-10-10T09:00:00+05:30" /></label>
        <label>Recurrence rule<input required maxLength={512} value={rrule} onChange={(e) => setRrule(e.target.value)} /><span className={styles.support}>For example, FREQ=DAILY;INTERVAL=1;BYHOUR=9;BYMINUTE=0. The scheduler validates supported bounded rules.</span></label>
        <label>Missed-run policy<select value={missedPolicy} onChange={(e) => setMissedPolicy(e.target.value)}><option value="skip">Skip missed occurrences</option><option value="run_once">Run the latest missed occurrence once</option></select></label>
        <label>Maximum occurrences<input type="number" min={1} max={10000} required value={maximum} onChange={(e) => setMaximum(e.target.value)} /></label>
        <label>Consecutive failure limit<input type="number" min={1} max={20} required value={failureLimit} onChange={(e) => setFailureLimit(e.target.value)} /></label>
      </div>
      <WorkflowEvidence title="Selected procedure eligibility and exact change targets" value={procedure} open />
      <WorkflowEvidence title="Per-occurrence budget" value={budget} />
      <p className={styles.boundary}>{authorityMode === "reviewed_mutation" ? "This procedure can change external state. Only the exact reviewed reversible actions are eligible for single-use PolicyLeases. Changed targets, dynamic inputs and ineligible actions return to ordinary approval." : "Only eligible read-only operations run automatically. Identity, procedure, policy and budget drift remain subject to server checks."}</p>
      <label className={styles.check}><input type="checkbox" checked={acknowledged === reviewIdentity} onChange={(e) => setAcknowledged(e.target.checked ? reviewIdentity : undefined)} />I reviewed this procedure, Agent, timing, missed-run policy and exact occurrence budget.</label>
      <button type="submit" disabled={!ready || Boolean(disabledReason) || acknowledged !== reviewIdentity}>Review schedule request</button>
    </fieldset>
    {disabledReason ? <p>{disabledReason}</p> : null}{error ? <p role="alert" className={styles.error}>{error}</p> : null}
    <p className={styles.support}>Schedule creation requires the existing durable idempotency key. No new expected-version field or broader lease authority is added.</p>
  </form>;
}

function explicitInstant(value: string) {
  const input = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input) || !Number.isFinite(Date.parse(input))) throw new Error("Use a complete ISO date and time with Z or an explicit UTC offset.");
  return new Date(input).toISOString();
}
function zoned(value: string, timezone: string) {
  try { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "long", timeZone: timezone }).format(new Date(value)); }
  catch { return value; }
}
