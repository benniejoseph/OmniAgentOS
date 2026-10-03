"use client";
import Link from "next/link";
import { useState } from "react";
import type { Resource } from "./controller";
import { readableCode, responsibilityHref, sameJson, type ResponsibilityRecord } from "./model";
import type { NotificationControlRequest, NotificationsView } from "./notifications-model";
import styles from "./notifications-panel.module.css";

export function NotificationsPanel({ resource, record, enabled, frozen, refresh, preview, control }: {
  resource: Resource<NotificationsView>; record: ResponsibilityRecord; enabled: boolean; frozen: boolean;
  refresh: () => void; preview: () => void; control: (request: NotificationControlRequest) => void;
}) {
  const [acknowledged, setAcknowledged] = useState<string>();
  const value = resource.value; const current = value?.current;
  const ready = value?.preview?.state === "ready" ? value.preview : undefined;
  const exact = ready && record.state === "reviewed" && ready.configuration.responsibilityRevision === record.revision && ready.configuration.draftSha256 === record.draftSha256 &&
    ready.configuration.reviewSha256 === record.review?.reviewSha256 && record.draft.sources.some((source) => sameJson(source, ready.configuration.source)) &&
    ready.configuration.maximumNotifications === record.draft.limits?.maxNotifications && record.draft.notificationRule?.destination === "owner_in_app";
  const acknowledgement = ready ? JSON.stringify([record.revision, ready.configuration.configurationSha256, ready.expectedRuntimeRevision, ready.expectedRuntimeGeneration]) : "";
  const available = enabled && !frozen && resource.state === "ready";
  const canEnable = available && !current && exact && acknowledged === acknowledgement;
  return <section className={styles.panel} aria-labelledby="responsibility-notifications-heading">
    <h2 className={styles.heading} id="responsibility-notifications-heading">In-app notifications</h2>
    <p className={styles.reading}>A saved notification request and a meeting pilot activation do not enable delivery. Review and enable the separate owner inbox destination below.</p>
    <div className={styles.actions}><button type="button" className={styles.button} onClick={refresh} disabled={resource.state === "loading" || frozen}>Refresh in-app notifications</button>
      <button type="button" className={styles.button} onClick={preview} disabled={!enabled || frozen || resource.state === "loading" || record.state !== "reviewed" || Boolean(current)}>Review in-app notification delivery</button></div>
    {!enabled && <p className={styles.support}>A current saved draft and workflow management permission are required to change notification admission.</p>}
    {resource.state === "idle" && <p role="status">Notification admission and history have not been read. Counts are unavailable.</p>}
    {resource.state === "loading" && <p role="status">Reading in-app notification admission and history…{value ? " Last-loaded values may be stale." : " Counts are unavailable."}</p>}
    {resource.state === "error" && <p role="status">In-app notification history unavailable. {resource.error}{value ? " Last-loaded values below may be stale; changes are disabled." : " Admission, pending changes and delivery counts are unknown."}</p>}
    {value && <>
      <p><strong>{current ? current.reason === "owner_stopped" ? "Stopped by owner" : readableCode(current.state) : "Not enabled"}</strong>{current ? ` · generation ${current.generation} · revision ${current.revision}` : " · no separate inbox admission recorded"}</p>
      <p className={styles.support}>{value.disclosure} Enabling does not backfill earlier observations.</p>
      {current && <>
        <dl className={styles.metadata}>
          <div><dt>Confirmed delivered</dt><dd>{current.used}</dd></div><div><dt>Reserved for pending changes</dt><dd>{current.reserved}</dd></div>
          <div><dt>Remaining unreserved allowance</dt><dd>{current.configuration.maximumNotifications - current.used - current.reserved} of {current.configuration.maximumNotifications}</dd></div>
          <div><dt>Destination</dt><dd>This owner’s Asael inbox</dd></div><div><dt>Admission expiry</dt><dd>{current.configuration.expiresAt}</dd></div>
          <div><dt>Last recorded transition</dt><dd>{current.updatedAt} · {readableCode(current.reason)}</dd></div>
        </dl>
        {current.state === "draining" && <p>Checks have exhausted their limit. Only already admitted finite changes may still reach the inbox. Stop in-app notifications to cancel remaining holds.</p>}
        {current.state === "paused" && <p>The responsibility is paused. Its earlier pending changes were canceled; resuming checks does not recreate those candidates.</p>}
        {current.reason === "owner_stopped" && <p>This notification admission is permanently stopped. Runtime changes cannot enable it again. Delivered history and cumulative use remain.</p>}
        <details><summary>Exact notification admission</summary><pre>{JSON.stringify(current, null, 2)}</pre></details>
      </>}
      {value.preview?.state === "blocked" && <p role="status">Notification review is blocked: {readableCode(value.preview.reason)}.</p>}
      {ready && <div className={styles.review}>
        <h3 className={styles.subheading}>Exact inbox delivery review</h3>
        <p>At most {ready.configuration.maximumNotifications} confirmed in-app notifications before {ready.configuration.expiresAt}. Quiet hours hold a finite pending change; no change produces no notification.</p>
        <dl className={styles.metadata}><div><dt>Owner</dt><dd>{ready.configuration.tenantId} · {ready.configuration.actorId}</dd></div>
          <div><dt>Meeting source</dt><dd>{ready.configuration.source.workspaceId} · {ready.configuration.source.id}</dd></div>
          <div><dt>Reviewed runtime</dt><dd>Revision {ready.expectedRuntimeRevision} · generation {ready.expectedRuntimeGeneration}</dd></div>
          <div><dt>Configuration SHA-256</dt><dd>{ready.configuration.configurationSha256}</dd></div></dl>
        <details><summary>Full reviewed notification configuration</summary><pre>{JSON.stringify(ready.configuration, null, 2)}</pre></details>
        {!exact && <p role="status">This preview does not match the displayed saved review. Refresh the draft and review notification delivery again.</p>}
      </div>}
    </>}
    <label className={styles.acknowledgement}><input type="checkbox" checked={Boolean(acknowledgement) && acknowledged === acknowledgement} disabled={!available || !exact || Boolean(current)} onChange={(event) => setAcknowledged(event.target.checked ? acknowledgement : undefined)} />
      <span>I reviewed the exact owner, source, configuration, runtime revision and generation, finite limit, expiry and owner inbox destination.</span></label>
    <div className={styles.actions}>
      <button type="button" className={styles.button} disabled={!canEnable} onClick={() => { if (canEnable && ready) control({ action: "enable", expectedRuntimeRevision: ready.expectedRuntimeRevision,
        expectedRuntimeGeneration: ready.expectedRuntimeGeneration, configurationSha256: ready.configuration.configurationSha256, acknowledgeDestination: "owner_in_app" }); }}>Enable exact in-app notifications</button>
      <button type="button" className={styles.button} disabled={!available || !current || current.state === "ended"} onClick={() => { if (available && current && current.state !== "ended") control({ action: "stop", expectedRevision: current.revision, expectedGeneration: current.generation }); }}>Stop in-app notifications</button>
    </div>
    <p className={styles.support}>{!current ? "First read a fresh delivery review and acknowledge it to enable. " : ""}Stopping cancels pending and held changes permanently, preserves confirmed deliveries, and does not change the meeting check lifecycle. No email, push or browser OS notification is enabled here.</p>
    {value && <>
      <h3 className={styles.subheading}>Recent notification candidates</h3>
      {value.candidates.length === 0 ? <p>No notification candidates were returned in this bounded history.</p> : <ul className={styles.rows}>{value.candidates.map((candidate) => <li key={candidate.id}>
        <p><strong>{readableCode(candidate.state)}</strong> · {readableCode(candidate.reason)} · generation {candidate.generation}</p>
        <p>{candidate.state === "delivered" ? "Confirmed in the Asael inbox by the recorded delivery receipt." : candidate.state === "pending" || candidate.state === "held" ? "Delivery is not confirmed. This exact change retains a reservation until delivery or a terminal outcome." : "This candidate cannot be delivered. No notification was recorded for it."}</p>
        <dl className={styles.metadata}><div><dt>Candidate</dt><dd>{candidate.id}</dd></div><div><dt>Material change</dt><dd>{candidate.changeId}</dd></div>
          <div><dt>Updated</dt><dd>{candidate.updatedAt}</dd></div><div><dt>Retry / expiry</dt><dd>{candidate.nextAttemptAt ?? "No retry scheduled"} / {candidate.expiresAt}</dd></div>
          {candidate.notificationId && <div><dt>Inbox receipt</dt><dd>{candidate.notificationId}</dd></div>}{candidate.dispositionId && <div><dt>Disposition</dt><dd>{candidate.dispositionId}</dd></div>}
        </dl>
        {candidate.state === "delivered" && <Link className={styles.link} href={responsibilityHref(record.id)}>Open notification source</Link>}
        <details><summary>Exact candidate and delivery binding</summary><pre>{JSON.stringify(candidate, null, 2)}</pre></details>
      </li>)}</ul>}
      <details><summary>Recent notification transition receipts ({value.receipts.length})</summary>{value.receipts.length === 0 ? <p>No notification admission or transition receipt returned.</p> : <ul className={styles.rows}>{value.receipts.map((receipt) => <li key={receipt.id}><p>{readableCode(receipt.action)} · {receipt.savedAt} · accepted revision {receipt.snapshot.revision}</p><pre>{JSON.stringify(receipt, null, 2)}</pre></li>)}</ul>}</details>
      <p className={styles.support}>Newest {value.coverage.limit} candidates and transition receipts per history. Totals are unavailable.{value.coverage.hasMoreCandidates || value.coverage.hasMoreReceipts ? " Older history exists outside this window." : ""}</p>
    </>}
  </section>;
}
