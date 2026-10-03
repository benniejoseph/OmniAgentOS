"use client";
import { useState } from "react";
import type { Resource } from "./controller";
import { budgetDimensions, budgetLabels, readableCode, remainingBudget, sameJson, type ResponsibilityLifecycleRequest, type ResponsibilityRecord, type RuntimeView } from "./model";
import styles from "./responsibilities.module.css";

export function RuntimePanel({ resource, record, enabled, frozen, refresh, preview, control }: {
  resource: Resource<RuntimeView>; record: ResponsibilityRecord; enabled: boolean; frozen: boolean;
  refresh: () => void; preview: () => void; control: (request: ResponsibilityLifecycleRequest) => void;
}) {
  const [acknowledged, setAcknowledged] = useState<string>();
  const value = resource.value; const current = value?.current;
  const ready = value?.preview?.state === "ready" ? value.preview.configuration : undefined;
  const acknowledgement = ready ? JSON.stringify([ready.configurationSha256, current?.revision ?? 0, current?.generation ?? 0, record.revision]) : "";
  const exact = ready && record.state === "reviewed" && ready.responsibilityRevision === record.revision && ready.draftSha256 === record.draftSha256 &&
    ready.reviewSha256 === record.review?.reviewSha256 && sameJson(ready.pins, record.review.pins) && (!current || ready.configurationSha256 === current.configuration.configurationSha256);
  const enabledNow = enabled && !frozen && resource.state === "ready";
  const submitted = (action: "pause" | "end") => { if (current) control({ action, expectedRevision: current.revision, expectedGeneration: current.generation }); };
  return <section className={styles.card} aria-labelledby="runtime-heading">
    <h2 id="runtime-heading">Meeting pilot lifecycle</h2>
    <div className={styles.actions}><button type="button" onClick={refresh} disabled={resource.state === "loading" || frozen}>Refresh lifecycle</button>
      {enabled && <button type="button" onClick={preview} disabled={frozen || resource.state === "loading" || record.state !== "reviewed"}>Review exact pilot activation</button>}</div>
    {resource.state === "loading" && <p role="status">Checking current lifecycle…</p>}
    {resource.state === "error" && <p role="status">Lifecycle unavailable. {resource.error}{value ? " Last-loaded metadata below may be stale; actions are disabled." : " Activation status is unknown."}</p>}
    {value && <>
      <p><strong>{current ? readableCode(current.state) : "Inactive"}</strong>{current ? ` · generation ${current.generation} · revision ${current.revision}` : " · no activation recorded"}</p>
      {current && <p>{readableCode(current.reason)}. {current.state === "pausing" || current.state === "ending" ? "Queued work is fenced. Started work still holds reservations until its outcome is confirmed." : ""}</p>}
      <div className={styles.notice}><h3>Supported pilot</h3><ul>{(["source", "comparison", "cadence", "stops", "execution"] as const).map((key) => <li key={key}>{value.disclosure[key]}</li>)}</ul>
        <p>Dispatch readiness has not been observed. An activation receipt alone does not show that a check ran. This meeting-check activation grants no notification authority; owner inbox delivery requires the separate in-app review below.</p></div>
      {current && <>
        <dl className={styles.metadata}><div><dt>Next check</dt><dd>{current.nextDueAt ?? "None scheduled"}</dd></div><div><dt>Expiry</dt><dd>{current.configuration.cadence.expiresAt}</dd></div>
          <div><dt>Cadence</dt><dd>Every {current.configuration.cadence.interval} {current.configuration.cadence.frequency} · {current.configuration.cadence.timezone} · missed checks skipped</dd></div>
          <div><dt>Checks used / reserved / remaining</dt><dd>{current.budget.usedChecks} / {current.budget.reservedChecks} / {current.budget.maximumChecks - current.budget.usedChecks - current.budget.reservedChecks} of {current.budget.maximumChecks}</dd></div></dl>
        {current.configuration.draftSha256 !== record.draftSha256 && <p role="status">The saved draft differs from the activated configuration. Current authority must be checked again; draft edits do not expand the active pilot.</p>}
        <div className={styles.tableWrap} tabIndex={0} role="region" aria-label="Cumulative pilot budget"><table><caption>Cumulative upper-bound accounting; these counters are not measured billing.</caption><thead><tr><th>Dimension</th><th>Used</th><th>Reserved</th><th>Remaining</th><th>Limit</th></tr></thead><tbody>{budgetDimensions.map((key) => <tr key={key}><th scope="row">{budgetLabels[key]}</th><td>{current.budget.used[key]}</td><td>{current.budget.reserved[key]}</td><td>{remainingBudget(current, key)}</td><td>{current.budget.limits[key]}</td></tr>)}</tbody></table></div>
        <div className={styles.actions}>{current.state === "active" && <button type="button" disabled={!enabledNow} onClick={() => submitted("pause")}>Pause responsibility</button>}
          {current.state !== "ended" && current.state !== "ending" && <button type="button" disabled={!enabledNow} onClick={() => submitted("end")}>End responsibility</button>}</div>
      </>}
      {value.preview?.state === "blocked" && <p role="status">Pilot activation is blocked: {readableCode(value.preview.reason)}.</p>}
      {ready && <div className={styles.stack}>
        <h3>Exact pilot review</h3><p>This configuration admits only the displayed read-only meeting check. Resuming retains every cumulative counter.</p>
        <details open><summary>Configuration, source, work, procedure and Agent pins</summary><pre>{JSON.stringify(ready, null, 2)}</pre></details>
        {!exact && <p role="status">This preview does not match the currently displayed review and lifecycle. Refresh both before continuing.</p>}
        {exact && (!current || current.state === "paused") && <>
          <label className={styles.check}><input type="checkbox" disabled={!enabledNow} checked={acknowledged === acknowledgement} onChange={(event) => setAcknowledged(event.target.checked ? acknowledgement : undefined)} /><span>I reviewed this finite meeting pilot, its exact configuration, and the absence of notification or mutation authority.</span></label>
          <button type="button" className={styles.primary} disabled={!enabledNow || acknowledged !== acknowledgement} onClick={() => control(current
            ? { action: "resume", expectedRevision: current.revision, expectedGeneration: current.generation, configurationSha256: ready.configurationSha256, acknowledgePilot: "native_meeting_metadata_v1" }
            : { action: "activate", expectedRevision: 0, expectedGeneration: 0, configurationSha256: ready.configurationSha256, acknowledgePilot: "native_meeting_metadata_v1" })}>{current ? "Resume this exact pilot" : "Activate this exact pilot"}</button>
        </>}
      </div>}
      <h3>Recent checks</h3>{value.wakes.length === 0 ? <p>No check receipts in this bounded history.</p> : <ul className={styles.history}>{value.wakes.map((wake) => <li key={wake.id}><strong>{readableCode(wake.state)}</strong> · {wake.scheduledFor} · generation {wake.generation}<small className={styles.identity}>{wake.id}</small>
        {wake.state === "uncertain" && <p>Started work is unresolved. Its reservation remains held.</p>}
        {wake.workflowRunId && <p className={styles.identity}>Workflow run: {wake.workflowRunId}</p>}
        {wake.observationId && <p className={styles.identity}>Observation: {wake.observationId}</p>}
      </li>)}</ul>}
      <details><summary>Recent lifecycle receipts ({value.receipts.length})</summary>{value.receipts.length === 0 ? <p>No lifecycle receipt recorded.</p> : value.receipts.map((receipt) => <div key={receipt.id}><p>{readableCode(receipt.action)} · {receipt.savedAt} · accepted revision {receipt.snapshot.revision}</p><pre>{JSON.stringify(receipt, null, 2)}</pre></div>)}</details>
      <p className={styles.support}>Newest {value.coverage.limit} checks and lifecycle receipts per history. Totals are unavailable.{value.coverage.hasMoreWakes || value.coverage.hasMoreReceipts ? " Older history exists beyond this window." : ""}</p>
    </>}
  </section>;
}
