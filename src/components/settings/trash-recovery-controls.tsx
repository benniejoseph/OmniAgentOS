"use client";

import { useCallback, useEffect, useState } from "react";
import type { TrashActionPreviewV1, TrashItemV1 } from "@/lib/trash/contracts";
import { mutationOptions, settingsJson, useAdvancedSettingsActions } from "./settings-advanced-lifecycle";
import { readTrashList, readTrashPreview, readTrashReceipt } from "./settings-recovery-state";
import { Metadata, ReadNotice, SettingsDialog } from "./settings-advanced-ui";
import styles from "./settings-advanced.module.css";

export function TrashRecoveryControls() {
  const actions = useAdvancedSettingsActions();
  const [items, setItems] = useState<TrashItemV1[]>();
  const [loading, setLoading] = useState(true);
  const [fresh, setFresh] = useState(false);
  const [error, setError] = useState<string>();
  const [page, setPage] = useState(0);
  const [review, setReview] = useState<{ item: TrashItemV1; preview: TrashActionPreviewV1 }>();
  const [receipt, setReceipt] = useState<Awaited<ReturnType<typeof readTrashReceipt>>>();
  const blocked = actions.blocked("manage.workflow");
  const load = useCallback(async () => {
    if (blocked) return;
    const ticket = actions.gate.read("trash"); setLoading(true); setFresh(false); setError(undefined);
    try { const value = await readTrashList(await settingsJson("/api/trash?state=retained&limit=100", { signal: ticket.signal })); if (ticket.current()) { setItems(value); setFresh(true); } else if (ticket.owned()) setError("Trash read interrupted by a settings action. Refresh to recheck."); }
    catch (failure) { if (ticket.owned()) setError(ticket.current() ? failure instanceof Error ? failure.message : "Trash could not be checked." : "Trash read interrupted by a settings action. Refresh to recheck."); }
    finally { if (ticket.owned()) setLoading(false); }
  }, [actions.gate, blocked]);
  useEffect(() => { const timer = setTimeout(() => void load(), 0); return () => clearTimeout(timer); }, [load]);
  async function preview(item: TrashItemV1, action: "restore" | "purge") {
    if (actions.busy || blocked || !fresh || loading) return;
    const ticket = actions.gate.read("trash-preview"); setError(undefined);
    try {
      const value = await readTrashPreview(await settingsJson(`/api/trash/${encodeURIComponent(item.trashId)}/${action}`, { signal: ticket.signal }), item, action);
      if (ticket.current()) setReview({ item, preview: value });
    } catch (failure) { if (ticket.current()) setError(failure instanceof Error ? failure.message : "The recovery preview could not be checked."); }
  }
  async function commit() {
    if (!review || actions.busy || blocked || !fresh || loading) return;
    const submitted = review;
    if (items?.find((item) => item.trashId === submitted.item.trashId)?.itemSha256 !== submitted.item.itemSha256 || Date.parse(submitted.preview.expiresAt) <= Date.now()) { setError("This reviewed item changed or the preview expired. Refresh and review it again."); return; }
    const result = await actions.run({ label: submitted.preview.action === "restore" ? "Restore trash item" : "Permanently purge trash item", permission: "manage.workflow", fingerprint: JSON.stringify(["trash", submitted.preview]), replayable: true,
      success: submitted.preview.action === "restore" ? "The restoration receipt was confirmed." : "The permanent deletion receipt was confirmed.", execute: async ({ idempotencyKey }) => {
        const value = await settingsJson(`/api/trash/${encodeURIComponent(submitted.item.trashId)}/${submitted.preview.action}`, mutationOptions(submitted.preview.action === "restore" ? "POST" : "DELETE", { preview: submitted.preview }, idempotencyKey));
        return readTrashReceipt(value, submitted.preview, submitted.item);
      } });
    if (result) { setReceipt(result.value); setReview(undefined); setFresh(false); void load(); }
  }
  const count = items?.length ?? 0;
  const start = Math.min(page * 10, Math.max(0, Math.floor((count - 1) / 10) * 10));
  const changed = review && items?.find((item) => item.trashId === review.item.trashId)?.itemSha256 !== review.item.itemSha256;
  return <section className={styles.panel} aria-labelledby="trash-recovery-title">
    <div className={styles.rowHeader}><div><h3 id="trash-recovery-title">Trash recovery</h3><p>Review an exact restore or purge preview. Permanent deletion cannot be undone.</p></div><button type="button" disabled={Boolean(actions.busy) || Boolean(blocked)} onClick={() => void load()}>Refresh trash</button></div>
    <ReadNotice loaded={Boolean(items)} loading={loading && !blocked} error={blocked || error} label="Trash records" />
    {items ? <p className={styles.support}>{fresh ? "Loaded" : "Last loaded"}: {items.length} retained item{items.length === 1 ? "" : "s"}. This view is bounded to 100 returned items.</p> : <p className={styles.support}>Count unavailable.</p>}
    <ul className={styles.rows}>{items?.slice(start, start + 10).map((item) => <li key={item.trashId} className={styles.panel}><h4>{item.displayLabel}</h4><Metadata items={[{ label: "Trash ID", value: item.trashId }, { label: "Resource ID", value: item.resourceId }, { label: "Resource type", value: item.resourceType }, { label: "Owner", value: item.ownerActorId }, { label: "State", value: item.state }, { label: "Revision", value: item.lifecycleRevision }, { label: "Restore until", value: item.restoreUntil }, { label: "Compensation", value: item.compensation.kind }, { label: "Target digest", value: item.targetSha256 }]} />{item.compensation.limitation ? <p>{item.compensation.limitation}</p> : null}<div className={styles.actions}><button type="button" disabled={Boolean(actions.busy) || Boolean(blocked) || !fresh || loading || item.compensation.kind === "unavailable"} onClick={() => void preview(item, "restore")}>Review restore {item.displayLabel}</button><button type="button" disabled={Boolean(actions.busy) || Boolean(blocked) || !fresh || loading} onClick={() => void preview(item, "purge")}>Review purge {item.displayLabel}</button></div></li>)}</ul>
    {items?.length === 0 ? <p className={styles.empty}>{fresh ? "No retained items were returned by this successful read." : "The last successful read returned no retained items. Current trash is unavailable."}</p> : null}
    {items && count > 10 ? <div className={styles.pagination}><button type="button" disabled={!start} onClick={() => setPage(start / 10 - 1)}>Previous trash items</button><span>{start + 1}–{Math.min(start + 10, count)} of {count}</span><button type="button" disabled={start + 10 >= count} onClick={() => setPage(start / 10 + 1)}>Next trash items</button></div> : null}
    {review ? <SettingsDialog title={review.preview.action === "restore" ? "Review restoration" : "Review permanent deletion"} busy={Boolean(actions.busy)} onClose={() => setReview(undefined)}>
      <h3>{review.item.displayLabel}</h3><p>{review.preview.effectSummary}</p>
      {review.item.compensation.limitation ? <p>{review.item.compensation.limitation}</p> : null}
      <Metadata items={[{ label: "Trash ID", value: review.preview.trashId }, { label: "Resource ID", value: review.preview.resourceId }, { label: "Lifecycle revision", value: review.preview.lifecycleRevision }, { label: "Preview digest", value: review.preview.previewSha256 }, { label: "Expires", value: review.preview.expiresAt }]} />
      <details><summary>Exact reviewed preview</summary><pre>{JSON.stringify(review.preview, null, 2)}</pre></details>
      {changed ? <p className={styles.error}>The current item differs from this preview. Close it and review the current item.</p> : null}
      {error || actions.error ? <p role="alert" className={styles.error}>{error || actions.error}</p> : null}
      <button type="button" disabled={Boolean(actions.busy) || Boolean(blocked) || !fresh || loading || Boolean(changed)} onClick={() => void commit()}>{review.preview.action === "restore" ? "Confirm restore" : "Confirm permanent purge"}</button>
    </SettingsDialog> : null}
    {receipt ? <div className={styles.receipt}><p role="status">{receipt.item.state === "restored" ? "Restoration confirmed" : "Permanent deletion confirmed"}: {receipt.item.displayLabel}</p><Metadata items={[{ label: "Receipt digest", value: receipt.receipt.receiptSha256 }, { label: "Outcome", value: receipt.receipt.outcome }, { label: "Affected resource IDs", value: receipt.receipt.affectedResourceIds.join(" · ") || "None" }, { label: "Restored resource IDs", value: receipt.restoredResourceIds?.join(" · ") || "Not applicable" }]} />{receipt.limitation ? <p>{receipt.limitation}</p> : null}<details><summary>Full recovery receipt</summary><pre>{JSON.stringify(receipt.receipt, null, 2)}</pre></details></div> : null}
  </section>;
}
