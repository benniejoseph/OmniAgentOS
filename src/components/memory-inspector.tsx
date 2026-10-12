"use client";

import Link from "next/link";
import { Archive, ArrowRight, CircleAlert, LoaderCircle, Pin, PinOff, RotateCcw, Trash2, X } from "lucide-react";
import { csmRoleSnapshotSchema } from "@/lib/csm/role-contracts";
import type { MemoryRecord } from "@/lib/memory/types";
import { displayMemoryTitle, memoryLabel, startCase, relativeDate } from "./memory-display";
import { useMemoryDialog } from "./use-memory-dialog";
import styles from "./memory-intelligence-workspace.module.css";

export type ForgetPreview = {
  memory: { id: string; title: string };
  expectedReceiptManifestSha256: string;
  guarantee: "rollback_proof_barrier" | "best_effort";
  impact: {
    descendantMemoryCount: number;
    retrievalTraceCount: number;
    graphNodeCount: number;
    graphEdgeCount: number;
  };
};
export function MemoryInspector(props: { memory?: MemoryRecord; loading: boolean; busy?: string; error?: string; preview?: ForgetPreview; onClose: () => void; onLifecycle: (action: "pin" | "unpin" | "archive" | "restore") => void; onPreviewForget: () => void; onForget: () => void; onCancelForget: () => void }) {
  const dialogRef = useMemoryDialog();
  const roleContext = (() => { try { const result = csmRoleSnapshotSchema.safeParse(JSON.parse(props.memory?.content || "")); return result.success ? result.data : undefined; } catch { return undefined; } })();
  const visibleTags = props.memory?.tags.filter((tag) => !roleContext || tag !== "csm-role-context-v1") || [];
  const lifecycleHelp = props.memory?.archivedAt
    ? "Restore this memory before pinning it."
    : props.memory?.pinnedAt
      ? "Unpin this memory before archiving it."
      : undefined;
  return <dialog ref={dialogRef} className={styles.inspectorLayer} aria-labelledby="memory-details-title" onCancel={(event) => { event.preventDefault(); props.onClose(); }} onClick={(event) => { if (event.target === event.currentTarget) props.onClose(); }}>
    <div className={styles.inspector}>
      <header><p id="memory-details-title">Memory details</p><button type="button" onClick={props.onClose} aria-label="Close memory details"><X size={18} /></button></header>
      {props.error ? <p className={styles.modalError} role="alert"><CircleAlert size={17} aria-hidden="true" />{props.error}</p> : null}
      {props.loading ? <div className={styles.inspectorLoading} role="status">Loading selected memory…</div> : props.memory ? <>
        <div className={styles.inspectorTitle}><span>{memoryLabel(props.memory.tier || props.memory.type)} · {props.memory.scope === "user" ? "Personal" : startCase(props.memory.scope)}</span><h2>{displayMemoryTitle(props.memory.title, props.memory.updatedAt)}</h2>{roleContext ? <><p>{roleContext.text.trim() || "No role notes saved yet. Add your responsibilities, working preferences and guidance in My CSM role."}</p><p>{roleContext.sourceLinks.length ? `${roleContext.sourceLinks.length} linked ${roleContext.sourceLinks.length === 1 ? "document" : "documents"}. Open My CSM role to view the saved sources.` : "No role documents linked yet."}</p><Link href="/app/projects?view=role">Open My CSM role <ArrowRight size={15} /></Link></> : <p>{props.memory.content}</p>}</div>
        <dl className={styles.memoryMetadata}>
          <div><dt>Confidence</dt><dd>{props.memory.confidence !== undefined ? `${Math.round(props.memory.confidence * 100)}%` : "Not recorded"}</dd></div>
          <div><dt>Importance</dt><dd>{Math.round(props.memory.importance * 100)}%</dd></div>
          <div><dt>Used</dt><dd>{props.memory.useCount !== undefined ? `${props.memory.useCount} times` : "Not recorded"}</dd></div>
          <div><dt>Updated</dt><dd>{relativeDate(props.memory.updatedAt)}</dd></div>
          <div><dt>Asserted by</dt><dd>{props.memory.assertedBy === "user" ? "You" : props.memory.assertedBy === "agent" ? "Assistant" : props.memory.assertedBy ? "Imported source" : "Not recorded"}</dd></div>
        </dl>
        {visibleTags.length ? <div className={styles.memoryTags} aria-label="Memory tags">{visibleTags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}
        <div className={styles.lifecycle}>
          <button type="button" disabled={Boolean(props.busy) || Boolean(props.memory.archivedAt)} aria-describedby={lifecycleHelp ? "memory-lifecycle-help" : undefined} onClick={() => props.onLifecycle(props.memory?.pinnedAt ? "unpin" : "pin")}>{props.memory.pinnedAt ? <PinOff size={15} /> : <Pin size={15} />}{props.memory.pinnedAt ? "Unpin" : "Pin"}</button>
          <button type="button" disabled={Boolean(props.busy) || Boolean(props.memory.pinnedAt)} aria-describedby={lifecycleHelp ? "memory-lifecycle-help" : undefined} onClick={() => props.onLifecycle(props.memory?.archivedAt ? "restore" : "archive")}>{props.memory.archivedAt ? <RotateCcw size={15} /> : <Archive size={15} />}{props.memory.archivedAt ? "Restore" : "Archive"}</button>
        </div>
        {lifecycleHelp ? <p id="memory-lifecycle-help" className={styles.lifecycleHelp}>{lifecycleHelp}</p> : null}
        <details className={styles.technicalDetails}><summary>Source and technical details</summary><p>Original title: {props.memory.title}</p><p>Source: {props.memory.source || "Not recorded"}</p><p>Reference: {props.memory.id}</p>{roleContext ? <><p>Stored role record</p><pre>{props.memory.content}</pre><p>Stored tags: {props.memory.tags.join(", ")}</p></> : null}</details>
        {props.preview ? <section className={styles.forgetPreview} aria-labelledby="forget-impact-title">
          <h3 id="forget-impact-title"><CircleAlert size={16} aria-hidden="true" /> Delete this memory?</h3>
          <p>This permanently removes “{displayMemoryTitle(props.memory.title, props.memory.updatedAt)}” and {props.preview.impact.descendantMemoryCount} memories created from it. It also removes their map connections and recall history. This cannot be undone.</p>
          <p>{props.preview.guarantee === "rollback_proof_barrier" ? "A saved deletion record prevents these memories from returning after a restore." : "Deletion is best effort: older backups may still contain this memory."} Original files and messages are not deleted.</p>
          <details><summary>View deletion details</summary><p>{props.preview.impact.graphNodeCount} map items, {props.preview.impact.graphEdgeCount} connections and {props.preview.impact.retrievalTraceCount} recall records will be removed. A deletion receipt is retained.</p></details>
          <div><button type="button" onClick={props.onCancelForget}>Cancel</button><button type="button" onClick={props.onForget} disabled={props.busy === "forget"}>{props.busy === "forget" ? <LoaderCircle size={15} className={styles.spin} /> : <Trash2 size={15} />} Delete permanently</button></div>
        </section> : <button type="button" className={styles.forgetButton} onClick={props.onPreviewForget} disabled={Boolean(props.busy)}><Trash2 size={15} />{props.busy === "forget-preview" ? "Checking deletion…" : "Delete memory"}</button>}
      </> : <div className={styles.inspectorLoading}>{props.error ? "This memory could not be loaded." : "Loading selected memory…"}</div>}
    </div>
  </dialog>;
}
