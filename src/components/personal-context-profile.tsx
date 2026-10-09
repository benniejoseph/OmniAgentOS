"use client";

import Link from "next/link";
import { ArrowUpRight, BookOpen, Check, Eye, Loader2, PencilLine, RefreshCw, UserRound, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import {
  PERSONAL_PROFILE_FIELD_DETAILS, personalProfileResponseSchema,
  type PersonalProfile, type PersonalProfileField, type PersonalProfileResponse,
} from "@/lib/personal-context/contracts";
import styles from "./personal-context-profile.module.css";

const ENDPOINT = "/api/personal-context/profile";
const fields = [
  { key: "name", label: "What should ATLAS call you?", preview: "Name", hint: "The name you want ATLAS to use.", rows: 1 },
  { key: "role", label: "What you do", preview: "Role", hint: "Your role and the responsibilities that matter most.", rows: 2 },
  { key: "workingContext", label: "How you work", preview: "Working context", hint: "Your day-to-day context, tools, constraints and ways of working.", rows: 5 },
  { key: "preferences", label: "How you like to be helped", preview: "Preferences", hint: "Your communication style, working preferences and useful boundaries.", rows: 5 },
  { key: "goals", label: "What you’re working towards", preview: "Goals", hint: "The outcomes you want ATLAS to help you make progress on.", rows: 4 },
  { key: "interests", label: "What interests you", preview: "Interests", hint: "Topics you want ATLAS to understand when they are relevant.", rows: 3 },
] as const;
type Field = PersonalProfileField;
type Draft = { enabled: boolean; profile: PersonalProfile };
type Snapshot = PersonalProfileResponse;
type Submission = { key: string; body: string; draft: Draft };
type Editor = { saved?: Snapshot; draft?: Draft; conflicts: string[]; pending?: Submission };

function copyDraft(snapshot: Draft): Draft {
  return { enabled: snapshot.enabled, profile: { ...snapshot.profile } };
}
function sameDraft(a: Draft, b: Draft) {
  return a.enabled === b.enabled && fields.every(({ key }) => a.profile[key] === b.profile[key]);
}
function parseSnapshot(value: unknown): Snapshot | undefined {
  const result = personalProfileResponseSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
function sourceLabel(source: Snapshot["fieldSources"][Field]) {
  return source?.source === "conversation" ? "Added from our conversation" : source?.source === "you" ? "Provided by you" : "Saved in your profile";
}
function dateLabel(value: string) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
async function expectedOwnerHeader(tenantId: string, actorId: string) {
  const bytes = new TextEncoder().encode(`asael.companion-owner:1\0${tenantId}\0${actorId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Preserve local edits, accept unrelated changes from another device, and ask
// the owner to resolve only fields that both editors changed.
function reconcile(editor: Editor, latest: Snapshot): Editor {
  if (editor.saved?.revision === latest.revision) return { ...editor, saved: latest };
  if (!editor.saved || !editor.draft || sameDraft(editor.saved, editor.draft)) return { saved: latest, draft: copyDraft(latest), conflicts: [] };
  const draft = copyDraft(editor.draft);
  const conflicts: string[] = [];
  for (const field of fields) {
    const before = editor.saved.profile[field.key];
    if (draft.profile[field.key] === before) draft.profile[field.key] = latest.profile[field.key];
    else if (latest.profile[field.key] !== before && latest.profile[field.key] !== draft.profile[field.key]) conflicts.push(field.preview);
  }
  if (draft.enabled === editor.saved.enabled) draft.enabled = latest.enabled;
  return { saved: latest, draft, conflicts };
}

export function PersonalContextProfile() {
  const { session, status, refresh } = useWorkspaceSession();
  const blocked = permissionMessage(session, status, "read");
  const tenant = session?.context?.tenantId;
  const actor = session?.context?.actorId;
  if (blocked || !tenant || !actor) return <section className={styles.shell} aria-labelledby="personal-context-title">
    <h2 id="personal-context-title">About me</h2>
    <p className={styles.support} role="status">{blocked || "Your account is unavailable. Check access to load your profile."}</p>
    <button className={styles.button} type="button" disabled={status === "loading"} onClick={() => void refresh()}>Check account access</button>
  </section>;
  return <ScopedProfile key={JSON.stringify([tenant, actor, session?.membership?.role ?? session?.context?.role])} tenantId={tenant} actorId={actor} />;
}

function ScopedProfile({ tenantId, actorId }: { tenantId: string; actorId: string }) {
  const [editor, setEditor] = useState<Editor>({ conflicts: [] });
  const editorRef = useRef(editor);
  const [tab, setTab] = useState<"edit" | "saved">("edit");
  const [busy, setBusy] = useState<"read" | "write">();
  const busyRef = useRef<"read" | "write" | undefined>(undefined);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const active = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const updateEditor = useCallback((next: Editor | ((current: Editor) => Editor)) => {
    const value = typeof next === "function" ? next(editorRef.current) : next;
    editorRef.current = value;
    setEditor(value);
  }, []);
  const setOperation = useCallback((next: "read" | "write" | undefined) => { busyRef.current = next; setBusy(next); }, []);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; generation.current += 1; controller.current?.abort(); };
  }, []);

  const load = useCallback(async () => {
    if (!active.current || busyRef.current || editorRef.current.pending) return;
    const request = new AbortController();
    const token = ++generation.current;
    controller.current = request;
    const timeout = window.setTimeout(() => request.abort(), 15_000);
    setOperation("read"); setError(undefined);
    try {
      const owner = await expectedOwnerHeader(tenantId, actorId);
      if (!active.current || token !== generation.current) return;
      request.signal.throwIfAborted();
      const response = await fetch(ENDPOINT, { cache: "no-store", headers: { accept: "application/json", "x-asael-companion-owner-sha256": owner }, signal: request.signal });
      const payload: unknown = await response.json();
      if (!active.current || token !== generation.current) return;
      const snapshot = response.ok ? parseSnapshot(payload) : undefined;
      if (!snapshot) throw new Error("Your profile could not be loaded. Try again when your connection is ready.");
      if (editorRef.current.saved && snapshot.revision < editorRef.current.saved.revision) throw new Error("The latest profile could not be confirmed. Your current details are still shown; try refreshing again.");
      updateEditor((current) => reconcile(current, snapshot));
    } catch (caught) {
      if (active.current && token === generation.current) setError(caught instanceof Error && caught.name !== "AbortError" ? caught.message : "The profile request timed out. Your unsaved details are still here.");
    } finally {
      window.clearTimeout(timeout);
      if (active.current && token === generation.current) { controller.current = null; setOperation(undefined); }
    }
  }, [actorId, tenantId, setOperation, updateEditor]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  async function send(submission: Submission) {
    if (!active.current || busyRef.current || editorRef.current.pending !== submission) return;
    const request = new AbortController();
    const token = ++generation.current;
    controller.current = request;
    const timeout = window.setTimeout(() => request.abort(), 30_000);
    setOperation("write"); setError(undefined); setNotice(undefined);
    let reloadAfterConflict = false;
    try {
      const owner = await expectedOwnerHeader(tenantId, actorId);
      if (!active.current || token !== generation.current) return;
      request.signal.throwIfAborted();
      const response = await fetch(ENDPOINT, {
        method: "PUT", cache: "no-store", headers: { accept: "application/json", "content-type": "application/json", "idempotency-key": submission.key, "x-asael-companion-owner-sha256": owner },
        body: submission.body, signal: request.signal,
      });
      const payload: unknown = await response.json();
      if (!active.current || token !== generation.current) return;
      const snapshot = response.ok ? parseSnapshot(payload) : undefined;
      if (snapshot) {
        updateEditor({ saved: snapshot, draft: copyDraft(snapshot), conflicts: [] });
        setNotice(sameDraft(snapshot, submission.draft) ? "About me saved. Your next message or new voice conversation can use these details." : "Your save was received, and the profile has since changed. The latest saved details are shown below.");
      } else if (response.status === 409) {
        updateEditor((current) => ({ ...current, pending: undefined }));
        setError("Your profile changed on another device. Loading the latest version so you can review both sets of changes.");
        reloadAfterConflict = true;
      } else if (response.status >= 400 && response.status < 500) {
        updateEditor((current) => ({ ...current, pending: undefined }));
        setError(response.status === 401 || response.status === 403 ? "Your account access changed. Sign in again before saving." : "Your changes were not saved. Check the field lengths and try again.");
      } else {
        setError("The save could not be confirmed. Use Check save to retry this same update safely; your draft is still here.");
      }
    } catch {
      if (active.current && token === generation.current) setError("The save could not be confirmed. Use Check save to retry this same update safely; your draft is still here.");
    } finally {
      window.clearTimeout(timeout);
      if (active.current && token === generation.current) { controller.current = null; setOperation(undefined); }
    }
    if (reloadAfterConflict && active.current) await load();
  }

  function save(event: FormEvent) {
    event.preventDefault();
    const current = editorRef.current;
    if (busyRef.current || current.pending || current.conflicts.length || !current.saved || !current.draft || sameDraft(current.saved, current.draft)) return;
    const draft = copyDraft(current.draft);
    // Match the saved, trimmed values rather than leaving a whitespace-only
    // field looking populated after the server has removed it.
    for (const { key } of fields) draft.profile[key] = draft.profile[key].trim();
    const submission = { key: crypto.randomUUID(), body: JSON.stringify({ expectedRevision: current.saved.revision, enabled: draft.enabled, profile: draft.profile }), draft };
    updateEditor({ ...current, draft, pending: submission });
    void send(submission);
  }
  function edit(field: Field, value: string) {
    if (busyRef.current || editorRef.current.pending) return;
    updateEditor((current) => current.draft ? { ...current, draft: { ...current.draft, profile: { ...current.draft.profile, [field]: value } } } : current);
    setNotice(undefined);
  }
  const { saved, draft, conflicts, pending } = editor;
  const dirty = Boolean(saved && draft && !sameDraft(saved, draft));
  const disabled = Boolean(busy || pending);
  const savedFields = fields.filter(({ key }) => saved?.profile[key]);

  return <section className={styles.shell} aria-labelledby="personal-context-title">
    <header className={styles.header}>
      <div><div className={styles.eyebrow}><UserRound size={16} aria-hidden="true" />Your personal context</div><h2 id="personal-context-title">About me</h2><p>A little context makes ATLAS more useful. Keep the details you want it to remember about you in one place, across text, voice and your devices.</p></div>
      <button type="button" className={styles.iconButton} aria-label="Refresh saved profile" title="Refresh saved profile" disabled={disabled} onClick={() => void load()}><RefreshCw size={17} aria-hidden="true" /></button>
    </header>
    {error ? <div className={styles.error} role="alert"><p>{error}</p>{!saved && !busy ? <button type="button" className={styles.button} onClick={() => void load()}>Try again</button> : null}</div> : null}
    {notice ? <p className={styles.notice} role="status"><Check size={16} aria-hidden="true" />{notice}</p> : null}
    {!saved || !draft ? <div className={styles.loading} role="status">{busy === "read" ? <><Loader2 size={18} className={styles.spinner} aria-hidden="true" />Loading your profile…</> : "Your profile will appear here once it can be loaded."}</div> : <>
      <div className={styles.statusRow}><span className={styles.status}><span className={saved.enabled ? styles.enabledDot : styles.disabledDot} aria-hidden="true" />{saved.enabled ? "Available to ATLAS" : "Personal context is off"}</span><span className={styles.support}>{saved.updatedAt ? `Saved ${dateLabel(saved.updatedAt)}` : "No profile saved yet"}</span></div>
      <div className={styles.tabs} aria-label="Profile views">
        <button type="button" className={styles.tab} aria-pressed={tab === "edit"} onClick={() => setTab("edit")}><PencilLine size={16} aria-hidden="true" />My details</button>
        <button type="button" className={styles.tab} aria-pressed={tab === "saved"} onClick={() => setTab("saved")}><Eye size={16} aria-hidden="true" />What ATLAS knows</button>
      </div>
      {conflicts.length ? <div className={styles.conflict} role="alert"><h3>Review changes from another device</h3><p>Both copies changed {conflicts.join(", ").toLowerCase()}. Your draft is kept in My details; What ATLAS knows shows the latest saved copy. Changes to other fields have already been combined.</p><div className={styles.actions}><button className={styles.button} type="button" disabled={disabled} onClick={() => { updateEditor((current) => ({ ...current, conflicts: [] })); setError(undefined); setNotice("Your draft is ready. Save changes to replace the conflicting details."); }}>Keep my edits</button><button className={styles.button} type="button" disabled={disabled} onClick={() => { updateEditor({ saved, draft: copyDraft(saved), conflicts: [] }); setError(undefined); }}>Use saved profile</button></div></div> : null}
      <form onSubmit={save}>
        <div hidden={tab !== "edit"}>
          <label className={styles.usage}><input type="checkbox" checked={draft.enabled} disabled={disabled} onChange={(event) => { const enabled = event.target.checked; updateEditor((current) => current.draft ? { ...current, draft: { ...current.draft, enabled } } : current); setNotice(undefined); }} /><span><strong>Use About me in conversations</strong><span>Include these details with your normal text and voice conversations, including Conversation only. Save changes to apply your choice.</span></span></label>
          <div className={styles.fieldList}>{fields.map((field) => {
            const changed = draft.profile[field.key] !== saved.profile[field.key];
            const source = saved.fieldSources[field.key];
            return <section className={styles.fieldRow} key={field.key}>
              <div className={styles.fieldHeading}><label htmlFor={`personal-context-${field.key}`}>{field.label}</label><p id={`personal-context-${field.key}-hint`}>{field.hint}</p>{source ? <p className={styles.source}>{sourceLabel(source)}<br /><time dateTime={source.updatedAt}>{dateLabel(source.updatedAt)}</time></p> : null}</div>
              <div className={styles.fieldInput}>{field.rows === 1 ? <input id={`personal-context-${field.key}`} value={draft.profile[field.key]} autoComplete="off" maxLength={PERSONAL_PROFILE_FIELD_DETAILS[field.key].maxLength} disabled={disabled} aria-describedby={`personal-context-${field.key}-hint`} onChange={(event) => edit(field.key, event.target.value)} /> : <textarea id={`personal-context-${field.key}`} value={draft.profile[field.key]} rows={field.rows} maxLength={PERSONAL_PROFILE_FIELD_DETAILS[field.key].maxLength} disabled={disabled} aria-describedby={`personal-context-${field.key}-hint`} onChange={(event) => edit(field.key, event.target.value)} />}<div className={styles.fieldFooter}><span className={styles.support}>{changed ? draft.profile[field.key] ? "Unsaved changes" : "Will be removed when saved" : draft.profile[field.key] ? "Saved" : "Optional"}</span>{draft.profile[field.key] ? <button type="button" className={styles.textButton} disabled={disabled} onClick={() => edit(field.key, "")} aria-label={`Remove ${field.preview.toLowerCase()} from profile`}><X size={14} aria-hidden="true" />Remove</button> : null}</div></div>
            </section>;
          })}</div>
        </div>
        <section hidden={tab !== "saved"} className={styles.knowledge} aria-labelledby="saved-profile-title">
          <h3 id="saved-profile-title">Your saved personal context</h3><p className={styles.support}>{saved.enabled ? "These are the details ATLAS can use in eligible conversations. It uses them when relevant; it does not infer new facts from this page." : "These details are saved, but About me is switched off. ATLAS is not given this profile in new conversations."}{dirty ? " Your unsaved edits are not included here." : ""}</p>
          {savedFields.length ? <dl className={styles.knowledgeList}>{savedFields.map((field) => { const source = saved.fieldSources[field.key]; return <div key={field.key}><dt>{field.preview}</dt><dd><p>{saved.profile[field.key]}</p><span className={styles.source}>{sourceLabel(source)}{source ? <> · <time dateTime={source.updatedAt}>{dateLabel(source.updatedAt)}</time></> : null}</span></dd></div>; })}</dl> : <div className={styles.empty}><UserRound size={24} aria-hidden="true" /><p>No personal details saved yet.</p><button className={styles.button} type="button" onClick={() => setTab("edit")}>Add my details</button></div>}
          <p className={styles.support}>This view shows your About me profile. It does not list every conversation, memory, client document or connected email.</p>
        </section>
        <footer className={styles.saveBar}><div><p role="status">{pending ? busy === "write" ? "Saving your profile…" : "Save needs confirmation" : conflicts.length ? "Resolve the changes above before saving" : dirty ? "You have unsaved changes" : saved.revision ? "All changes saved" : "Add the details you want ATLAS to know"}</p><p className={styles.support}>Updates apply to your next message or new voice conversation.</p></div><div className={styles.actions}>{pending ? <button className={`${styles.button} ${styles.primary}`} type="button" disabled={Boolean(busy)} onClick={() => void send(pending)}>{busy === "write" ? "Saving…" : "Check save"}</button> : <><button className={styles.button} type="button" disabled={disabled || !dirty} onClick={() => { updateEditor({ saved, draft: copyDraft(saved), conflicts: [] }); setError(undefined); setNotice(undefined); }}>Discard changes</button><button className={`${styles.button} ${styles.primary}`} disabled={disabled || !dirty || Boolean(conflicts.length)}>{busy === "write" ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}Save changes</button></>}</div></footer>
      </form>
      <details className={styles.details}><summary>How ATLAS uses this context</summary><div><p>Your saved profile is shared across your devices for this account. It gives ATLAS a consistent starting point in normal text and voice conversations.</p><p>Current message only, No extra context and Reviewed saved context exclude About me. Turning it off affects future requests; it does not erase details already mentioned in conversation history.</p><p>Saved memories and connected sources have separate controls. Choose Personal automatic in Assistant to recall relevant personal memories when consent is enabled. Email, calendar and file access still depends on the connection and available synced content.</p><p>Removing a field here removes it from this profile. To remove a separately saved memory, open Memory.</p></div></details>
      <nav className={styles.related} aria-label="Related personal context"><Link href="/app/projects?view=role" prefetch={false}><BookOpen size={17} aria-hidden="true" /><span><strong>My CSM role</strong><small>Add your detailed role playbook and documents</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link><Link href="/app/memory" prefetch={false}><Eye size={17} aria-hidden="true" /><span><strong>Memory</strong><small>Review saved knowledge and personal recall</small></span><ArrowUpRight size={16} aria-hidden="true" /></Link></nav>
    </>}
  </section>;
}
