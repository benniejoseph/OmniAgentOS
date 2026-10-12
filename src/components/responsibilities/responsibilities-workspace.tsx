"use client";
import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { canPerform, useWorkspaceSession } from "@/components/app-shell/session-context";
import { responsibilityId } from "./client";
import { ResponsibilityController } from "./controller";
import { DraftEditor } from "./draft-editor";
import { ObservationsPanel } from "./observations-panel";
import { responsibilityHref, sessionResponsibilityOwner, type Owner } from "./model";
import { RuntimePanel } from "./runtime-panel";
import { NotificationsPanel } from "./notifications-panel";
import styles from "./responsibilities.module.css";

export function ResponsibilityWorkspace({ id, deployment }: { id?: string; deployment: string }) {
  const { session, status, role } = useWorkspaceSession();
  const owner = sessionResponsibilityOwner(session);
  // Role, deployment or owner changes replace all private state. A temporary
  // same-owner session refresh hides the view while retaining unsaved fields.
  const scope = JSON.stringify([deployment, owner?.tenantId, owner?.actorId, session?.context?.actorId, role]);
  if (!owner) return <div className={styles.workspace}><h1>Follow-ups</h1><p role="status">Sign in with a verified workspace account to view responsibilities.</p></div>;
  if (id && !responsibilityId(id)) return <div className={styles.workspace}><h1>Responsibility unavailable</h1><p>The full responsibility identity is invalid.</p><Link href="/app/responsibilities">All follow-ups</Link></div>;
  return <ScopedWorkspace key={`${scope}:${id ?? "list"}`} scope={scope} owner={owner} id={id}
    active={status === "ready"} sessionStatus={status} canManage={canPerform(role, "manage.workflow")} />;
}
function ScopedWorkspace({ scope, owner, id, active, sessionStatus, canManage }: {
  scope: string; owner: Owner; id?: string; active: boolean; sessionStatus: string; canManage: boolean;
}) {
  const [controller] = useState(() => new ResponsibilityController(scope, owner));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const [recoveringKey, setRecoveringKey] = useState<string>();
  const recoveryButton = useRef<HTMLButtonElement | null>(null); const removedFocusedRecovery = useRef(false); const acceptedHeading = useRef<HTMLHeadingElement>(null);
  const recoveryRef = useCallback((node: HTMLButtonElement | null) => {
    // React detaches the ref before removing this control. Capture actual
    // focus then; a prior click is not evidence that focus stayed here.
    if (!node && recoveryButton.current && document.hasFocus() && document.activeElement === recoveryButton.current) removedFocusedRecovery.current = true;
    recoveryButton.current = node;
  }, []);
  useLayoutEffect(() => {
    const restore = removedFocusedRecovery.current; removedFocusedRecovery.current = false;
    if (restore && state.accepted && document.hasFocus() && document.activeElement === document.body && acceptedHeading.current?.isConnected) {
      acceptedHeading.current.focus({ preventScroll: true }); acceptedHeading.current.scrollIntoView({ block: "nearest", behavior: "instant" });
    }
  });
  const [creating, setCreating] = useState(false); const [limit, setLimit] = useState(40);
  useEffect(() => { controller.setActive(active); if (active) void controller.open(id); return () => controller.setActive(false); }, [controller, active, id]);
  // Hide and inert the retained subtree synchronously, before effect cleanup.
  // Keeping it mounted preserves a dirty same-owner draft during session reads.
  const detail = state.detail.value; const frozen = Boolean(state.pending) || state.submitting;
  const created = !id && state.accepted?.kind === "draft" && state.accepted.result.receipt.action === "created";
  return <>{!active && <div className={styles.workspace}><h1>Follow-ups</h1><p role="status">{sessionStatus === "loading" ? "Checking workspace permissions…" : "Workspace permissions are unavailable. Refresh your session to continue."} Same-account drafts remain in this page.</p></div>}
    <div className={styles.workspace} hidden={!active} inert={!active} aria-hidden={!active || undefined} data-testid="responsibilities-workspace">
    <header className={styles.header}><div><h1>{id ? "Follow-up" : "Follow-ups"}</h1>
      <p>Keep important commitments in view. Follow a work item or meeting, and hear from Asael when something changes.</p></div>
      {id ? <Link href="/app/responsibilities">All follow-ups</Link> : canManage && !creating && <button type="button" onClick={() => setCreating(true)}>New follow-up</button>}
    </header>
    <details className={styles.support}><summary>Access details</summary><p className={styles.identity}>Workspace: {owner.tenantId}{detail?.record.actorId || state.references.value?.owner.actorId || owner.actorId ? ` · owner: ${detail?.record.actorId ?? state.references.value?.owner.actorId ?? owner.actorId}` : ""}</p></details>
    {state.submitting && <p role="status" className={styles.notice}>Submitting the frozen exact request. Draft, lifecycle and notification controls are locked until its result is known.</p>}
    {(state.mutationError || state.pending && state.pending.key === recoveringKey) && <div role="alert" className={styles.notice}><p>{state.mutationError ?? "Recovering the exact submitted receipt…"}</p>{state.pending && <button ref={recoveryRef} type="button" aria-disabled={state.submitting} onClick={() => {
      if (!state.submitting && state.pending) { setRecoveringKey(state.pending.key); void controller.retry(); }
    }}>Retry exact submitted request</button>}</div>}
    {state.accepted && <section className={styles.receipt} role="status" aria-label="Accepted responsibility receipt"><h2 ref={acceptedHeading} tabIndex={-1}>Saved confirmation</h2>
      <p>{state.accepted.result.replayed ? "Recovered your saved confirmation." : savedConfirmation(state.accepted.kind, state.accepted.result.receipt.action)}</p>
      {state.accepted.result.current.revision !== state.accepted.result.receipt.snapshot.revision && <p>Newer changes were returned with this confirmation. Refresh the details to check the current state.</p>}
      {state.accepted.kind === "notifications" && <p>{state.accepted.result.receipt.action === "stop" ? "This records the choice to stop future inbox updates. Earlier delivered updates are kept." : "This records permission for future inbox updates. It does not confirm that an update was delivered."}</p>}
      {state.accepted.kind === "draft" && <Link href={responsibilityHref(state.accepted.result.receipt.snapshot.id)}>Open this responsibility</Link>}
      {created && <button type="button" onClick={() => { controller.clearAccepted(); setCreating(false); }}>Start another draft</button>}
      <details><summary>Exact accepted receipt</summary>
        <p>Action: {state.accepted.result.receipt.action} · accepted revision {state.accepted.result.receipt.snapshot.revision} · response revision {state.accepted.result.current.revision}.</p>
        <p>Later refresh failures do not undo this saved confirmation.</p>
        <pre>{JSON.stringify(state.accepted.result.receipt, null, 2)}</pre>
      </details>
    </section>}
    {!id && <>
      {creating && !created && <DraftEditor key="new" canManage={canManage} frozen={frozen} references={state.references} refreshReferences={() => void controller.load("references")}
        save={(body) => void controller.submit({ kind: "draft", body })} preview={() => undefined} />}
      {creating && created && <p>The inactive draft was created. Open its permanent link above to edit or review it.</p>}
      <section className={styles.card} aria-labelledby="responsibility-list"><div className={styles.header}><h2 id="responsibility-list">Your follow-ups</h2><button type="button" disabled={state.list.state === "loading"} onClick={() => void controller.load("list", undefined, false, limit)}>Refresh list</button></div>
        {state.list.state === "loading" && <p role="status">Loading recent responsibilities…</p>}
        {state.list.state === "error" && <p role="status">List unavailable. {state.list.error}{state.list.value ? " Previously loaded records may be stale." : " The list is not known to be empty."}</p>}
        {state.list.value && (state.list.value.records.length === 0 ? <p>No follow-ups yet in this recent window. Create one when you have an outcome you want Asael to keep checking.</p> : <ul className={styles.list}>{state.list.value.records.map((item) => <li key={item.id}>
          <Link href={responsibilityHref(item.id)}><strong>{item.draft.purpose || "Untitled inactive draft"}</strong><span>{item.state.replaceAll("_", " ")}</span></Link>
          <p>{item.draft.desiredOutcome || "No desired outcome recorded."}</p><p>Updated {item.updatedAt}. Open for current lifecycle, evidence and limits.</p>
        </li>)}</ul>)}
        {state.list.value && <p className={styles.support}>{state.list.value.records.length} most recent records shown, requested limit {limit}; total unavailable. Draft review status does not imply an active watcher.</p>}
        {state.list.value?.hasMore && limit < 100 && <button type="button" disabled={state.list.state === "loading"} onClick={() => { const next = Math.min(100, limit + 40); setLimit(next); void controller.load("list", undefined, false, next); }}>Show a larger recent window</button>}
        {state.list.value?.hasMore && limit === 100 && <p>Older records are outside this 100-record window. Exact permanent links still open them.</p>}
      </section>
    </>}
    {id && <>
      <details><summary>Reference</summary><p className={styles.identity}>{id}</p></details><button type="button" disabled={state.detail.state === "loading" || frozen} onClick={() => void controller.load("detail", id)}>Refresh saved draft</button>
      {state.detail.state === "loading" && <p role="status">Loading the exact responsibility…</p>}
      {state.detail.state === "error" && <p role="status">Responsibility unavailable. {state.detail.error}{detail ? " Last-loaded draft is read only until refreshed." : " It may be missing or no longer accessible."}</p>}
      {detail && <>
        <DraftEditor detail={detail} canManage={canManage && state.detail.state === "ready"} frozen={frozen} references={state.references}
          refreshReferences={() => void controller.load("references")} save={(body) => void controller.submit({ kind: "draft", id, body })} preview={() => void controller.load("detail", id, true)} />
        <RuntimePanel record={detail.record} resource={state.runtime} enabled={canManage && state.detail.state === "ready"} frozen={frozen}
          refresh={() => void controller.load("runtime", id)} preview={() => void controller.load("runtime", id, true)} control={(body) => void controller.submit({ kind: "runtime", id, body })} />
        <ObservationsPanel resource={state.observations} refresh={() => void controller.load("observations", id)} />
        <NotificationsPanel record={detail.record} resource={state.notifications} enabled={canManage && state.detail.state === "ready"} frozen={frozen}
          refresh={() => void controller.load("notifications", id)} preview={() => void controller.load("notifications", id, true)} control={(body) => void controller.submit({ kind: "notifications", id, body })} />
      </>}
    </>}
  </div></>;
}

function savedConfirmation(kind: "draft" | "runtime" | "notifications", action: string) {
  if (kind === "draft") {
    if (action === "created") return "Your inactive draft was created.";
    if (action === "updated") return "Your draft changes were saved.";
    if (action === "reviewed") return "Your review was saved without starting checks.";
  }
  if (kind === "runtime") {
    if (action === "activate") return "Your request to start scheduled checks was saved.";
    if (action === "resume") return "Your request to resume scheduled checks was saved.";
    if (action === "pause") return "Your request to pause scheduled checks was saved.";
    if (action === "end") return "Your request to end tracking was saved.";
  }
  if (kind === "notifications") return action === "stop" ? "Your choice to stop future inbox updates was saved." : "Your choice to enable future inbox updates was saved.";
  return "Your request was saved.";
}
