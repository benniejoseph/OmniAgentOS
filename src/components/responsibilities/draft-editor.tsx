"use client";
import { useId, useState } from "react";
import { validDraft } from "./client";
import { budgetDimensions, budgetLabels, emptyDraft, finitePilotLimits, readableCode, sameJson, type Detail, type References, type ResponsibilityDraft, type ResponsibilityMutation } from "./model";
import type { Resource } from "./controller";
import { ReferencePicker } from "./reference-picker";
import styles from "./responsibilities.module.css";

type EditorState = { observed: number; basis: number; original: ResponsibilityDraft; draft: ResponsibilityDraft };
export function reconcileDraft(state: EditorState, detail?: Detail): EditorState {
  const revision = detail?.record.revision ?? 0; if (state.observed === revision) return state;
  const saved = detail?.record.draft ?? emptyDraft();
  return sameJson(state.original, state.draft) || sameJson(saved, state.draft)
    ? { observed: revision, basis: revision, original: saved, draft: saved } : { ...state, observed: revision };
}
export function normalizedDraft(draft: ResponsibilityDraft): ResponsibilityDraft {
  return { ...draft, purpose: draft.purpose.trim(), desiredOutcome: draft.desiredOutcome.trim(), successCondition: draft.successCondition.trim(), stopConditions: draft.stopConditions.map((item) => item.trim()).filter(Boolean) };
}
export function DraftEditor({ detail, references, canManage, frozen, save, preview, refreshReferences }: {
  detail?: Detail; references: Resource<References>; canManage: boolean; frozen: boolean;
  save: (input: ResponsibilityMutation) => void; preview: () => void; refreshReferences: () => void;
}) {
  const fieldId = useId();
  const [state, setState] = useState<EditorState>(() => ({ observed: detail?.record.revision ?? 0, basis: detail?.record.revision ?? 0, original: detail?.record.draft ?? emptyDraft(), draft: detail?.record.draft ?? emptyDraft() }));
  const [validation, setValidation] = useState<string>();
  const reconciled = reconcileDraft(state, detail);
  if (reconciled !== state) setState(reconciled);
  const { draft } = reconciled; const revision = detail?.record.revision ?? 0;
  const dirty = !sameJson(draft, reconciled.original); const stale = revision !== reconciled.basis;
  const edit = (draft: ResponsibilityDraft) => { setState((current) => ({ ...current, draft })); setValidation(undefined); };
  const submit = () => {
    const exact = normalizedDraft(draft);
    if (!validDraft(exact)) { setValidation("Check the finite dates, numeric limits and selected references. Expiry must be after the start and within 366 days."); return; }
    edit(exact); save(detail ? { action: "update", expectedRevision: reconciled.basis, draft: exact } : { action: "create", expectedRevision: 0, draft: exact });
  };
  return <section className={styles.card} aria-labelledby="draft-heading">
    <h2 id="draft-heading">{detail ? "Saved draft and review" : "New responsibility"}</h2>
    <p>Saving or reviewing keeps the draft inactive. Activation is a separate exact review of the supported meeting pilot.</p>
    {!canManage && <p>Your role can inspect this draft. Managing workflows is required to change it.</p>}
    {stale && <p role="status">The saved revision changed while you were editing. Your local draft is retained. Load the current saved draft before saving again.</p>}
    {dirty && <p className={styles.support}>Unsaved changes · based on revision {reconciled.basis}</p>}
    <fieldset disabled={!canManage || frozen} className={styles.stack}>
      <legend className={styles.srOnly}>Responsibility draft fields</legend>
      <label><span id={`${fieldId}-purpose`}>{"Purpose"}</span><textarea aria-labelledby={`${fieldId}-purpose`} maxLength={2000} value={draft.purpose} onChange={(event) => edit({ ...draft, purpose: event.target.value })} /></label>
      <label><span id={`${fieldId}-outcome`}>{"Desired outcome"}</span><textarea aria-labelledby={`${fieldId}-outcome`} maxLength={2000} value={draft.desiredOutcome} onChange={(event) => edit({ ...draft, desiredOutcome: event.target.value })} /></label>
      <ReferencePicker draft={draft} onChange={edit} resource={references} refresh={refreshReferences} />
      <section className={styles.stack}><h3>Cadence and expiry</h3>
        <p>Missed checks are skipped. The pilot supports daily or weekly checks with a 15-minute grace period.</p>
        {!draft.cadence ? <button type="button" onClick={() => { const start = new Date(); start.setUTCSeconds(0, 0); edit({ ...draft, cadence: { frequency: "daily", interval: 1, timezone: "UTC", startsAt: start.toISOString(), expiresAt: new Date(start.getTime() + 7 * 86400000).toISOString(), missedPolicy: "skip" } }); }}>Set a finite schedule</button> : <>
          <div className={styles.grid}><label>Frequency<select value={draft.cadence.frequency} onChange={(event) => edit({ ...draft, cadence: { ...draft.cadence!, frequency: event.target.value as "hourly" | "daily" | "weekly" } })}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="hourly">Hourly (draft only; pilot unavailable)</option></select></label>
            <label>Interval<input type="number" min={1} max={24} step={1} value={draft.cadence.interval} onChange={(event) => edit({ ...draft, cadence: { ...draft.cadence!, interval: Number(event.target.value) } })} /></label></div>
          <label>Timezone<input value={draft.cadence.timezone} maxLength={100} onChange={(event) => edit({ ...draft, cadence: { ...draft.cadence!, timezone: event.target.value } })} /><small>IANA timezone, for example Asia/Kolkata or UTC.</small></label>
          <div className={styles.grid}>{(["startsAt", "expiresAt"] as const).map((field) => <label key={field}>{field === "startsAt" ? "Start instant (UTC)" : "Expiry instant (UTC)"}<input type="datetime-local" value={draft.cadence![field].slice(0, 16)} onChange={(event) => {
            const date = new Date(`${event.target.value}:00.000Z`); if (Number.isFinite(date.getTime())) edit({ ...draft, cadence: { ...draft.cadence!, [field]: date.toISOString() } });
          }} /></label>)}</div><button type="button" onClick={() => edit({ ...draft, cadence: null })}>Remove schedule from draft</button>
        </>}
      </section>
      <section className={styles.stack}><h3>Cumulative limits</h3><p>These limits apply across the entire responsibility, including resumed checks. Zero means no budget for that dimension.</p>
        {!draft.limits ? <button type="button" onClick={() => edit({ ...draft, limits: finitePilotLimits() })}>Set finite limits for up to seven pilot checks</button> : <>
          <div className={styles.grid}><label>Maximum checks<input type="number" min={1} max={10000} step={1} value={draft.limits.maxChecks} onChange={(event) => edit({ ...draft, limits: { ...draft.limits!, maxChecks: Number(event.target.value) } })} /></label>
            <label>Maximum notifications<input type="number" min={0} max={1000} step={1} value={draft.limits.maxNotifications} onChange={(event) => edit({ ...draft, limits: { ...draft.limits!, maxNotifications: Number(event.target.value) } })} /><small>Saved limit only. Separately enable owner inbox updates after activation.</small></label></div>
          <div className={styles.grid}>{budgetDimensions.map((key) => <label key={key}>{budgetLabels[key]}<input type="number" min={0} max={1e12} step={1} value={draft.limits!.cumulative[key]} onChange={(event) => edit({ ...draft, limits: { ...draft.limits!, cumulative: { ...draft.limits!.cumulative, [key]: Number(event.target.value) } } })} /></label>)}</div>
        </>}
      </section>
      <label className={styles.check}><input type="checkbox" checked={draft.notificationRule !== null} onChange={(event) => edit({ ...draft, notificationRule: event.target.checked ? { kind: "material_change_only", destination: "owner_in_app", quietOnNoChange: true } : null })} /><span>Request owner in-app updates only for material changes; keep no-change checks quiet.<small>Saving this request does not enable delivery.</small></span></label>
      <label><span id={`${fieldId}-success`}>{"Success condition"}</span><textarea aria-labelledby={`${fieldId}-success`} maxLength={1000} value={draft.successCondition} onChange={(event) => edit({ ...draft, successCondition: event.target.value })} /><small>Descriptive intent. Pilot stopping rules are expiry, meeting started, or meeting canceled.</small></label>
      <div className={styles.stack}><h3>Additional descriptive stop conditions</h3>{draft.stopConditions.map((condition, index) => <div className={styles.stack} key={index}><label>Stop condition {index + 1}<input maxLength={500} value={condition} onChange={(event) => edit({ ...draft, stopConditions: draft.stopConditions.map((item, position) => position === index ? event.target.value : item) })} /></label>
        <button type="button" onClick={() => edit({ ...draft, stopConditions: draft.stopConditions.filter((_, position) => position !== index) })}>Remove stop condition {index + 1}</button></div>)}
        <button type="button" disabled={draft.stopConditions.length >= 8} onClick={() => edit({ ...draft, stopConditions: [...draft.stopConditions, ""] })}>Add a stop condition</button></div>
      <div className={styles.actions}><button type="button" className={styles.primary} onClick={submit} disabled={stale}>{detail ? "Save inactive draft" : "Create inactive draft"}</button>
        {detail && <button type="button" onClick={() => { const saved = detail.record.draft; setState({ observed: revision, basis: revision, draft: saved, original: saved }); }}>Use current saved draft</button>}
        {detail && <button type="button" disabled={dirty || stale} onClick={preview}>Check exact references for review</button>}</div>
      {validation && <p role="alert">{validation}</p>}
      {detail && <section className={styles.stack}><h3>Exact draft review</h3>
        <p>Revision {revision} · {detail.record.state === "reviewed" ? "Reviewed; activation remains separate" : "Not reviewed"}</p>
        {detail.readiness.state === "ready" ? <>
          <p>References checked for this saved revision. A later change requires another review.</p>
          <details open><summary>Exact revision pins and review digest</summary><pre>{JSON.stringify(detail.readiness, null, 2)}</pre></details>
          <button type="button" disabled={dirty || stale} onClick={() => { if (detail.readiness.state === "ready") save({ action: "review", expectedRevision: revision, draftSha256: detail.readiness.draftSha256, reviewSha256: detail.readiness.reviewSha256 }); }}>Accept this exact inactive review</button>
        </> : <p>{detail.readiness.state === "not_checked" ? "Current references have not been checked." : `${readableCode(detail.readiness.state)}: ${detail.readiness.issues.map(readableCode).join("; ")}`}</p>}
        {detail.record.review && <details><summary>Saved review receipt pins</summary><pre>{JSON.stringify(detail.record.review, null, 2)}</pre></details>}
      </section>}
    </fieldset>
  </section>;
}
