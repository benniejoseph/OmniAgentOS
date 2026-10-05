"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TrashItemV1 } from "@/lib/trash/contracts";
import { mutationOptions, settingsJson, useAdvancedSettingsActions } from "./settings-advanced-lifecycle";
import { readTrashList, readTrashPreview, readTrashReceipt } from "./settings-recovery-state";
import { createTrashSelection, exactTrashId, readExactTrashItem, trashReviewMatches, type TrashRecoveryReview } from "./trash-exact-recovery-state";
import { Metadata, ReadNotice, SettingsDialog, SettingsField } from "./settings-advanced-ui";
import styles from "./settings-advanced.module.css";

function canRestore(item: TrashItemV1, asOf: number) {
  return item.state === "retained" && item.compensation.kind !== "unavailable" && Date.parse(item.restoreUntil) > asOf;
}

export function TrashRecoveryControls() {
  const actions = useAdvancedSettingsActions();
  const scope = JSON.stringify([actions.session?.context?.tenantId, actions.session?.context?.actorId,
    actions.session?.user?.id, actions.session?.membership?.role ?? actions.session?.context?.role]);
  return <TrashRecoveryContent key={scope} />;
}
function TrashRecoveryContent() {
  const actions = useAdvancedSettingsActions();
  const root = useRef<HTMLElement>(null);
  const [selection] = useState(createTrashSelection);
  const [exactSelection] = useState(createTrashSelection);
  const [items, setItems] = useState<TrashItemV1[]>();
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string>();
  const [page, setPage] = useState(0);
  const [review, setReview] = useState<TrashRecoveryReview>();
  const [exactId, setExactId] = useState("");
  const [exact, setExact] = useState<{ item: TrashItemV1; current: () => boolean }>();
  const [exactLoading, setExactLoading] = useState(false);
  const [exactError, setExactError] = useState<string>();
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof readTrashReceipt>>>();
  const [checkedAt, setCheckedAt] = useState(() => Date.now());
  const blocked = actions.blocked("manage.workflow");
  const readBlocked = Boolean(blocked);
  const tenantId = actions.session?.context?.tenantId, actorId = actions.session?.context?.actorId;
  const role = actions.session?.membership?.role ?? actions.session?.context?.role;
  const visible = useCallback(() => Boolean(root.current?.isConnected) && !root.current?.closest("[hidden]") && document.visibilityState !== "hidden", []);
  useLayoutEffect(() => {
    selection.mount(); exactSelection.mount();
    return () => { selection.dispose(); exactSelection.dispose(); };
  }, [selection, exactSelection]);
  useEffect(() => {
    const hide = () => {
      if (visible()) return;
      selection.invalidate(); exactSelection.invalidate();
      actions.gate.read("trash-exact"); actions.gate.read("trash-preview");
      setReview(undefined); setExact(undefined); setExactLoading(false);
    };
    const observer = new MutationObserver(hide);
    for (let ancestor = root.current; ancestor; ancestor = ancestor.parentElement) observer.observe(ancestor, { attributes: true, attributeFilter: ["hidden"] });
    document.addEventListener("visibilitychange", hide);
    return () => { observer.disconnect(); document.removeEventListener("visibilitychange", hide); };
  }, [actions.gate, selection, exactSelection, visible]);
  const exactFresh = Boolean(exact?.current()) && exact?.item.trashId === exactId;
  const sourceState = { items, listFresh: fresh, listLoading: loading, exactItem: exact?.item, exactFresh, exactLoading, exactCurrent: exact?.current };
  const itemBlocked = (item: TrashItemV1) => blocked || actions.blocked(item.resourceType === "mcp_connector" || item.resourceType === "openapi_connector" ? "manage.connector" : "manage.workflow");
  const load = useCallback(async () => {
    if (readBlocked) return;
    selection.invalidate();
    setCheckedAt(Date.now());
    const ticket = actions.gate.read("trash"); setLoading(true); setFresh(false); setError(undefined);
    try { const value = await readTrashList(await settingsJson("/api/trash?state=retained&limit=100", { signal: ticket.signal })); if (ticket.current()) { setItems(value); setFresh(true); } else if (ticket.owned()) setError("Trash read interrupted by a settings action. Refresh to recheck."); }
    catch (failure) { if (ticket.owned()) setError(ticket.current() ? failure instanceof Error ? failure.message : "Trash could not be checked." : "Trash read interrupted by a settings action. Refresh to recheck."); }
    finally { if (ticket.owned()) setLoading(false); }
  }, [actions.gate, readBlocked, selection]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  function chooseExact(value: string) {
    exactSelection.invalidate(); selection.invalidate();
    actions.gate.read("trash-exact"); actions.gate.read("trash-preview");
    setExactId(value); setExact(undefined); setExactError(undefined); setExactLoading(false); setReview(undefined);
  }
  async function findExact() {
    if (actions.busy || blocked || !tenantId || !actorId || !role || !visible()) return;
    setCheckedAt(Date.now());
    exactSelection.invalidate(); selection.invalidate(); setReview(undefined); setExact(undefined); setExactError(undefined);
    const ticket = actions.gate.read("trash-exact"), selected = exactSelection.capture();
    if (!exactTrashId(exactId)) { setExactError("Enter the complete Trash ID beginning with trash:."); setExactLoading(false); return; }
    const submittedId = exactId, requestId = crypto.randomUUID();
    setExactLoading(true);
    const current = () => selected() && ticket.current() && visible();
    try {
      const value = await readExactTrashItem(await settingsJson(`/api/trash/${encodeURIComponent(submittedId)}`, {
        signal: ticket.signal, headers: { "x-request-id": requestId },
      }), submittedId, { tenantId, actorId, role, requestId });
      if (current()) setExact({ item: value, current });
      else if (selected() && ticket.owned()) setExactError("The exact Trash read was interrupted. Find this ID again to verify its current state.");
    } catch (failure) {
      if (selected() && ticket.owned()) setExactError(current() && failure instanceof Error ? failure.message : "The exact Trash read was interrupted. Find this ID again.");
    } finally { if (selected() && ticket.owned()) setExactLoading(false); }
  }
  async function preview(item: TrashItemV1, action: "restore" | "purge", now: number, source: "list" | "exact" = "list") {
    setCheckedAt(now);
    if (actions.busy || itemBlocked(item) || !visible() || !trashReviewMatches({ item, source }, sourceState) || action === "restore" && !canRestore(item, now)) return;
    selection.invalidate(); const selected = selection.capture();
    const ticket = actions.gate.read("trash-preview"); setError(undefined); setReview(undefined);
    try {
      const value = await readTrashPreview(await settingsJson(`/api/trash/${encodeURIComponent(item.trashId)}/${action}`, { signal: ticket.signal }), item, action);
      if (selected() && ticket.current() && visible()) setReview({ item, preview: value, source });
    } catch (failure) { if (selected() && ticket.current()) setError(failure instanceof Error ? failure.message : "The recovery preview could not be checked."); }
  }
  async function commit(now: number) {
    if (!review || actions.busy || itemBlocked(review.item) || !visible()) return;
    setCheckedAt(now);
    const submitted = review;
    if (!trashReviewMatches(submitted, sourceState) || submitted.preview.action === "restore" && !canRestore(submitted.item, now) || Date.parse(submitted.preview.expiresAt) <= now) { setError("This reviewed item changed or the preview expired. Refresh and review it again."); return; }
    const selected = selection.capture();
    const result = await actions.run({ label: submitted.preview.action === "restore" ? "Restore trash item" : "Permanently purge trash item", permission: "manage.workflow", fingerprint: JSON.stringify(["trash", submitted.preview]), replayable: true,
      success: submitted.preview.action === "restore" ? "The restoration receipt was confirmed." : "The permanent deletion receipt was confirmed.", execute: async ({ idempotencyKey, current }) => {
        const dispatchedAt = Date.now();
        if (!current() || !selected() || !visible() || Date.parse(submitted.preview.expiresAt) <= dispatchedAt || submitted.preview.action === "restore" && !canRestore(submitted.item, dispatchedAt)) throw new Error("The selection or preview changed before submission. Review it again.");
        const value = await settingsJson(`/api/trash/${encodeURIComponent(submitted.item.trashId)}/${submitted.preview.action}`, mutationOptions(submitted.preview.action === "restore" ? "POST" : "DELETE", { preview: submitted.preview }, idempotencyKey));
        return readTrashReceipt(value, submitted.preview, submitted.item);
      } });
    if (result) { setReceipt(result.value); setReview(undefined); setFresh(false); exactSelection.invalidate(); void load(); }
  }
  const count = items?.length ?? 0;
  const start = Math.min(page * 10, Math.max(0, Math.floor((count - 1) / 10) * 10));
  const changed = review && !trashReviewMatches(review, sourceState);
  if (blocked) return <section ref={root} className={styles.panel} aria-labelledby="trash-recovery-title"><h3 id="trash-recovery-title">Trash recovery</h3><p className={styles.warning}>{blocked}</p></section>;
  return <section ref={root} className={styles.panel} aria-labelledby="trash-recovery-title">
    <div className={styles.rowHeader}><div><h3 id="trash-recovery-title">Trash recovery</h3><p>Review an exact restore or purge preview. Permanent deletion cannot be undone.</p></div><button type="button" disabled={Boolean(actions.busy) || Boolean(blocked)} onClick={() => void load()}>Refresh trash</button></div>
    <ReadNotice loaded={Boolean(items)} loading={loading && !blocked} error={blocked || error} label="Trash records" />
    {items ? <p className={styles.support}>{fresh ? "Loaded" : "Last loaded"}: {items.length} retained item{items.length === 1 ? "" : "s"}. This view is bounded to 100 returned items.</p> : <p className={styles.support}>Count unavailable.</p>}
    <form onSubmit={(event) => { event.preventDefault(); void findExact(); }} aria-label="Find an exact Trash item">
      <SettingsField label="Exact Trash ID"><input value={exactId} maxLength={42} autoComplete="off" spellCheck={false} disabled={Boolean(actions.busy)} placeholder="trash:00000000-0000-4000-8000-000000000000" onChange={(event) => chooseExact(event.target.value)} /></SettingsField>
      <p className={styles.support}>Paste the Trash ID from your receipt to find an older item outside this list. Use the same account and workspace that moved it to Trash.</p>
      <button type="submit" disabled={Boolean(actions.busy) || !exactTrashId(exactId)}>{exactLoading ? "Reading exact Trash item…" : "Find Trash item"}</button>
      {exactError ? <p role="alert" className={styles.error}>{exactError}</p> : null}
    </form>
    {exact ? <section className={styles.panel} aria-label="Exact Trash item"><h4>{exact.item.displayLabel}</h4><p className={styles.support}>{exactFresh ? "Verified by exact ID" : "Last verified exact item; find this ID again before another change."}</p>
      <Metadata items={[{ label: "Trash ID", value: exact.item.trashId }, { label: "Resource ID", value: exact.item.resourceId }, { label: "Owner", value: exact.item.ownerActorId }, { label: "State", value: exact.item.state }, { label: "Restore until", value: exact.item.restoreUntil }, { label: "Compensation", value: exact.item.compensation.kind }]} />
      {exact.item.compensation.limitation ? <p>{exact.item.compensation.limitation}</p> : null}
      {itemBlocked(exact.item) ? <p className={styles.warning}>{itemBlocked(exact.item)}</p> : null}
      {!canRestore(exact.item, checkedAt) ? <p>This item cannot be restored from its current state, compensation plan or restore window.</p> : null}
      <button type="button" disabled={Boolean(actions.busy) || Boolean(itemBlocked(exact.item)) || !exactFresh || exactLoading || !canRestore(exact.item, checkedAt)} onClick={() => void preview(exact.item, "restore", Date.now(), "exact")}>Review restore {exact.item.displayLabel}</button>
    </section> : null}
    <ul className={styles.rows}>{items?.slice(start, start + 10).map((item) => <li key={item.trashId} className={styles.panel}><h4>{item.displayLabel}</h4><Metadata items={[{ label: "Trash ID", value: item.trashId }, { label: "Resource ID", value: item.resourceId }, { label: "Resource type", value: item.resourceType }, { label: "Owner", value: item.ownerActorId }, { label: "State", value: item.state }, { label: "Revision", value: item.lifecycleRevision }, { label: "Restore until", value: item.restoreUntil }, { label: "Compensation", value: item.compensation.kind }, { label: "Target digest", value: item.targetSha256 }]} />{item.compensation.limitation ? <p>{item.compensation.limitation}</p> : null}<div className={styles.actions}><button type="button" disabled={Boolean(actions.busy) || Boolean(blocked) || !fresh || loading || item.compensation.kind === "unavailable"} onClick={() => void preview(item, "restore", Date.now())}>Review restore {item.displayLabel}</button><button type="button" disabled={Boolean(actions.busy) || Boolean(blocked) || !fresh || loading} onClick={() => void preview(item, "purge", Date.now())}>Review purge {item.displayLabel}</button></div></li>)}</ul>
    {items?.length === 0 ? <p className={styles.empty}>{fresh ? "No retained items were returned by this successful read." : "The last successful read returned no retained items. Current trash is unavailable."}</p> : null}
    {items && count > 10 ? <div className={styles.pagination}><button type="button" disabled={!start} onClick={() => setPage(start / 10 - 1)}>Previous trash items</button><span>{start + 1}–{Math.min(start + 10, count)} of {count}</span><button type="button" disabled={start + 10 >= count} onClick={() => setPage(start / 10 + 1)}>Next trash items</button></div> : null}
    {review ? <SettingsDialog title={review.preview.action === "restore" ? "Review restoration" : "Review permanent deletion"} busy={Boolean(actions.busy)} onClose={() => { selection.invalidate(); setReview(undefined); }}>
      <h3>{review.item.displayLabel}</h3><p>{review.preview.effectSummary}</p>
      {review.item.compensation.limitation ? <p>{review.item.compensation.limitation}</p> : null}
      <Metadata items={[{ label: "Trash ID", value: review.preview.trashId }, { label: "Resource ID", value: review.preview.resourceId }, { label: "Lifecycle revision", value: review.preview.lifecycleRevision }, { label: "Preview digest", value: review.preview.previewSha256 }, { label: "Expires", value: review.preview.expiresAt }]} />
      <details><summary>Exact reviewed preview</summary><pre>{JSON.stringify(review.preview, null, 2)}</pre></details>
      {changed ? <p className={styles.error}>The current item differs from this preview. Close it and review the current item.</p> : null}
      {error || actions.error ? <p role="alert" className={styles.error}>{error || actions.error}</p> : null}
      <button type="button" disabled={Boolean(actions.busy) || Boolean(itemBlocked(review.item)) || Boolean(changed) || review.preview.action === "restore" && !canRestore(review.item, checkedAt)} onClick={() => void commit(Date.now())}>{review.preview.action === "restore" ? "Confirm restore" : "Confirm permanent purge"}</button>
    </SettingsDialog> : null}
    {receipt ? <div className={styles.receipt}><p role="status">{receipt.item.state === "restored" ? "Restoration confirmed" : "Permanent deletion confirmed"}: {receipt.item.displayLabel}</p><Metadata items={[{ label: "Receipt digest", value: receipt.receipt.receiptSha256 }, { label: "Outcome", value: receipt.receipt.outcome }, { label: "Affected resource IDs", value: receipt.receipt.affectedResourceIds.join(" · ") || "None" }, { label: "Restored resource IDs", value: receipt.restoredResourceIds?.join(" · ") || "Not applicable" }]} />{receipt.limitation ? <p>{receipt.limitation}</p> : null}<details><summary>Full recovery receipt</summary><pre>{JSON.stringify(receipt.receipt, null, 2)}</pre></details></div> : null}
  </section>;
}
