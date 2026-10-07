"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Check, FileText, Info, Search, X } from "lucide-react";
import { clsx } from "clsx";
import type { WorkspaceLibraryItem } from "@/lib/library/contracts";
import styles from "./csm-workspace.module.css";

export const FILE_TYPE_LABELS: Record<WorkspaceLibraryItem["kind"], string> = {
  document: "Document", spreadsheet: "Spreadsheet", presentation: "Slide deck", file: "File", image: "Image",
  audio: "Audio", video: "Video", recording: "Recording", transcript: "Transcript", email: "Email",
  meeting: "Meeting", message: "Message", webpage: "Web page", record: "Saved item", generated_artifact: "Created file",
};
export const FILE_STATUS_LABELS: Record<WorkspaceLibraryItem["status"], string> = {
  ready: "Ready to use", processing: "Preparing to read", failed: "Could not prepare this file", unsupported: "File type not supported",
};
export async function readJson<T>(href: string, init?: RequestInit): Promise<T> {
  const response = await fetch(href, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(requestErrorMessage(body.error, response.status));
  return body as T;
}
export function jsonWrite(method: string, body: unknown, key: string): RequestInit {
  return { method, headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body) };
}
export function dateLabel(value?: string) {
  if (!value) return "Not scheduled";
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00` : value);
  return Number.isNaN(parsed.getTime()) ? "Date unavailable" : parsed.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
function requestErrorMessage(message: unknown, status: number) {
  const friendly: Record<string, string> = {
    "Your CSM role context changed. Reload it before saving.": "Your role context was updated elsewhere. Reload the saved context before saving your changes.",
    "Your CSM role context has conflicting active revisions.": "There are conflicting saved copies of your role notes. We can't safely choose one. Contact support for help.",
    "The saved CSM role context could not be verified.": "We couldn't verify your saved role context. Refresh the page; if it still won't open, contact support.",
    "An exact role-context edit intent is required.": "We couldn't safely save this change. Reload the saved role context before trying again.",
    "Saved CSM role context requires the database to be available.": "Your saved role context is temporarily unavailable. Please try again shortly.",
    "Role sources must be your private files without a client, workspace or mission scope. Link client material within its client instead.": "Choose one of your personal role guides or notes. Files belonging to a client or shared project should stay in that workspace.",
    "Role context changed. Reload it before saving your edit.": "Your role context was updated elsewhere. Reload the saved context before saving your changes.",
    "Role context was not found.": "Your role notes could not be found. Reload the page before trying again.",
    "Your role context can have up to 50 linked sources.": "You can add up to 50 role documents and notes. Remove one from this space before adding another.",
    "Invalid client context request.": "Some client details could not be saved. Check the fields and try again.",
    "Client context access is unavailable.": "We couldn't open this client's details. Refresh the page and check that you still have access.",
    "Client context is temporarily unavailable. Your accepted edits can be retried with the same edit key.": "We couldn't confirm whether your changes were saved. Try this action again to check or finish saving it.",
    "Client context changed. Reload it before saving your edit.": "This client brief was updated while you were editing. Load the saved brief before making further changes.",
    "Client context has conflicting active revisions.": "There are conflicting saved copies of this client brief. We can't safely choose one. Contact support for help.",
    "The saved client context could not be verified.": "We couldn't verify the saved client brief. Refresh the page; if it still won't open, contact support.",
    "Client context write access is required.": "You can view this client, but you don't have permission to change their brief or files.",
    "An exact client edit intent is required.": "We couldn't safely save this change. Refresh the saved brief before trying again.",
    "This edit key was already used for another change.": "The details of this change no longer match the earlier attempt. Refresh the saved brief before trying again.",
    "Client context belongs to another project.": "These details don't belong to the selected client. Reopen the client before saving.",
    "Client context was not found.": "This client's brief could not be found. Reopen the client to check whether it is still available.",
    "The selected source is no longer available.": "This file is no longer available. Choose another file from Library.",
    "The source changed. Select its current Library version again.": "This file was updated. Refresh Library and choose it again.",
    "A client can have up to 50 linked sources.": "You can add up to 50 files or notes to a client. Remove one from this client before adding another.",
    "Archived client work is read-only.": "This client is archived. Reopen their project in Other projects before making changes.",
    "Project not found.": "This client is no longer available, or you don't have access to it.",
    "Invalid project task": "Check the action's title, note and due date before trying again.",
    "Invalid task update": "This action could not be updated. Refresh the saved actions before trying again.",
    "Invalid project": "Check the client name and goals before trying again.",
  };
  if (typeof message === "string" && friendly[message]) return friendly[message];
  if (typeof message === "string" && message.startsWith("Idempotency-Key")) return "We couldn't safely repeat this action because its details changed. Refresh the saved work before trying again.";
  if (status === 401) return "Please sign in again to continue with this client.";
  if (status === 403) return "You don't have permission to make this request. Check your access before trying again.";
  return typeof message === "string" ? message : "We couldn't complete this request. Refresh the saved work before trying again.";
}
export function errorText(error: unknown) {
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return "The connection was interrupted. Refresh the saved work before retrying; your changes may have been saved.";
  return error instanceof Error ? error.message : "This action could not be completed.";
}

export function LibraryPicker({ open, onClose, linkedIds, onSelect }: { open: boolean; onClose: () => void; linkedIds: string[]; onSelect: (item: WorkspaceLibraryItem) => Promise<void> }) {
  const [items, setItems] = useState<WorkspaceLibraryItem[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => { setLoading(true); void readJson<{ items: WorkspaceLibraryItem[] }>(`/api/library?limit=40&q=${encodeURIComponent(query)}`, { signal: controller.signal }).then((data) => { if (!controller.signal.aborted) { setItems(data.items); setError(""); } }).catch((caught) => { if (!controller.signal.aborted) setError(errorText(caught)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); }); }, 180);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [open, query]);
  return <Modal open={open} title="Add documents & notes" onClose={onClose} preventClose={Boolean(busy)}>
    <p className={styles.hint}>Choose documents, notes, images or recordings to add. The originals stay in Library, and their sharing settings stay the same.</p>
    <label className={styles.search}><Search size={16} /><input aria-label="Search documents and notes" placeholder="Find a transcript, deck, or recording" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    {error ? <Notice error>{error}</Notice> : null}
    {loading ? <p role="status" className={styles.muted}>Finding documents and notes…</p> : null}
    <ul className={styles.sourceList}>{items.map((item) => <li className={styles.sourceRow} key={item.id}><FileText className={styles.sourceIcon} size={19} /><div className={styles.sourceBody}><p className={styles.sourceTitle}>{item.title}</p><p className={styles.sourceMeta}>{FILE_TYPE_LABELS[item.kind]} · {FILE_STATUS_LABELS[item.status]} · {dateLabel(item.updatedAt)}</p></div><button className={styles.button} disabled={Boolean(busy) || linkedIds.includes(item.id) || item.status === "failed" || item.status === "unsupported"} onClick={() => { setBusy(item.id); setError(""); void onSelect(item).catch((caught) => setError(errorText(caught))).finally(() => setBusy("")); }}>{linkedIds.includes(item.id) ? <><Check size={15} />Added</> : busy === item.id ? "Adding…" : "Add"}</button></li>)}</ul>
    {!loading && !items.length ? <p className={styles.hint}>No matching documents or notes. Upload a file here or add it through Capture first.</p> : null}
    <div className={styles.dialogFooter}><button className={styles.button} onClick={onClose} disabled={Boolean(busy)}>Done</button></div>
  </Modal>;
}

export function Modal({ open, title, children, onClose, preventClose = false }: { open: boolean; title: string; children: ReactNode; onClose: () => void; preventClose?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const headingId = useId();
  useEffect(() => { const dialog = ref.current; if (!dialog) return; if (open && !dialog.open) dialog.showModal(); else if (!open && dialog.open) dialog.close(); }, [open]);
  return <dialog ref={ref} className={styles.dialog} aria-labelledby={headingId} onCancel={(event) => { event.preventDefault(); if (!preventClose) onClose(); }} onClose={() => { if (!preventClose && open) onClose(); }}><header className={styles.dialogHeader}><h2 id={headingId}>{title}</h2><button type="button" className={styles.iconButton} aria-label="Close dialog" disabled={preventClose} onClick={onClose}><X size={18} /></button></header>{children}</dialog>;
}
export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <div className={clsx(styles.notice, error && styles.error)} role={error ? "alert" : "status"}><Info size={17} /><div>{children}</div></div>;
}
