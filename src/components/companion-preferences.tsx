"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import {
  applyCompanionRead, applyCompanionReceipt, companionDraftIsDirty, companionRefusalSettlesSubmission, companionWriteRejection,
  createCompanionRequestGate, freezeCompanionSubmission, parseCompanionConversations, parseCompanionResponse,
  type CompanionConversation, type CompanionEditor, type CompanionSubmission,
} from "@/components/companion-preferences-state";
import {
  COMPANION_DESTINATIONS, COMPANION_INTENSITIES, COMPANION_MOTION, effectiveCompanionMotion,
  type CompanionPreferences as Preferences,
} from "@/lib/companion/model";
import { VoiceAppearancePicker } from "./voice/voice-appearance-picker";
import styles from "./companion-preferences.module.css";

const intensityLabels = { quiet: "Quiet", balanced: "Balanced", expressive: "Expressive" } as const;
const motionLabels = { full: "Full", reduced: "Reduced", off: "Off" } as const;
const destinationLabels = { assistant: "Assistant", today: "Today", activity: "Activity", work: "Work" } as const;
const sample = {
  quiet: "What would you like to work on?",
  balanced: "What are we getting done today?",
  expressive: "What are we taking off your list today?",
} as const;
function subscribeReducedMotion(change: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
}
function readReducedMotion() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
function serverReducedMotion() { return undefined; }

export function CompanionPreferences() {
  const { session, status, refresh } = useWorkspaceSession();
  // All current roles may manage their own preferences; the server owns the dedicated write permission.
  const blocked = permissionMessage(session, status, "read");
  const tenantId = session?.context?.tenantId;
  const actorId = session?.context?.actorId;
  if (!tenantId || !actorId || (session?.authEnabled && !session.authenticated)) return <section className={styles.shell} aria-labelledby="companion-preferences-title">
    <h2 id="companion-preferences-title">Companion preferences</h2>
    <p role="status">{blocked || "Your workspace identity is unavailable. Check access before loading preferences."}</p>
    <button type="button" className={styles.button} onClick={() => void refresh()} disabled={status === "loading"}>Check workspace access</button>
  </section>;
  return <ScopedCompanionPreferences key={JSON.stringify([tenantId, actorId])} tenantId={tenantId} actorId={actorId} blocked={blocked} checkAccess={() => void refresh()} />;
}

function ScopedCompanionPreferences({ tenantId, actorId, blocked, checkAccess }: { tenantId: string; actorId: string; blocked?: string; checkAccess: () => void }) {
  const [editor, setEditor] = useState<CompanionEditor>({});
  const editorRef = useRef<CompanionEditor>({});
  const [gate] = useState(createCompanionRequestGate);
  const permissionRef = useRef(blocked);
  const readController = useRef<AbortController | null>(null);
  const writeController = useRef<AbortController | null>(null);
  const threadsController = useRef<AbortController | null>(null);
  const [loading, setLoading] = useState(false);
  const [fresh, setFresh] = useState(false);
  const [readError, setReadError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [writeNotice, setWriteNotice] = useState<string>();
  const [confirm, setConfirm] = useState<"reset" | "discard">();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [threads, setThreads] = useState<CompanionConversation[]>();
  const [omitted, setOmitted] = useState(0);
  const [threadsLoading, setThreadsLoading] = useState(false);
  const [threadsError, setThreadsError] = useState<string>();
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState(20);
  const osReducedMotion = useSyncExternalStore<boolean | undefined>(subscribeReducedMotion, readReducedMotion, serverReducedMotion);
  const pickerTrigger = useRef<HTMLButtonElement>(null);
  const firstStyleInput = useRef<HTMLInputElement>(null);
  const resetTrigger = useRef<HTMLButtonElement>(null);
  const discardTrigger = useRef<HTMLButtonElement>(null);
  const updateEditor = useCallback((update: (current: CompanionEditor) => CompanionEditor) => {
    const next = update(editorRef.current);
    editorRef.current = next;
    setEditor(next);
  }, []);

  useLayoutEffect(() => { permissionRef.current = blocked; }, [blocked]);
  useLayoutEffect(() => {
    gate.activate();
    return () => {
      gate.dispose(); readController.current?.abort(); writeController.current?.abort(); threadsController.current?.abort();
    };
  }, [gate]);
  const load = useCallback(async () => {
    if (permissionRef.current) return;
    const token = gate.beginRead();
    if (!token) return;
    readController.current?.abort();
    const controller = new AbortController();
    readController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setLoading(true); setFresh(false); setReadError(undefined);
    try {
      const response = await fetch("/api/companion/preferences", { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
      const body: unknown = await response.json();
      if (!gate.readCurrent(token)) return;
      const parsed = response.ok ? parseCompanionResponse(body) : undefined;
      if (!parsed) throw new Error("Preferences could not be verified. The last loaded values and your draft are retained.");
      if (editorRef.current.current && parsed.snapshot.revision < editorRef.current.current.snapshot.revision) throw new Error("An older preference snapshot was returned. The newer confirmed values are retained; refresh again.");
      updateEditor((current) => applyCompanionRead(current, parsed));
      setFresh(true);
    } catch (error) {
      if (gate.readCurrent(token)) setReadError(error instanceof Error && error.name !== "AbortError" ? error.message : "The preference read did not finish. Your last loaded values and draft are retained.");
    } finally {
      window.clearTimeout(timeout);
      if (gate.readCurrent(token)) { setLoading(false); readController.current = null; }
    }
  }, [gate, updateEditor]);
  useEffect(() => {
    if (blocked) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [blocked, load]);

  const loadThreads = useCallback(async () => {
    if (permissionRef.current) return;
    const token = gate.beginConversations();
    if (!token) return;
    threadsController.current?.abort();
    const controller = new AbortController(); threadsController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 15_000);
    setThreadsLoading(true); setThreadsError(undefined);
    try {
      const response = await fetch("/api/threads?limit=100", { cache: "no-store", headers: { accept: "application/json" }, signal: controller.signal });
      const body: unknown = await response.json();
      if (!gate.conversationsCurrent(token)) return;
      const parsed = response.ok ? parseCompanionConversations(body, tenantId, actorId) : undefined;
      if (!parsed) throw new Error("Conversation choices are unavailable. Refresh the list to choose a home.");
      setThreads(parsed.threads); setOmitted(parsed.omitted);
    } catch {
      if (gate.conversationsCurrent(token)) setThreadsError("Conversation choices could not be checked. Any last loaded rows remain read only until a successful refresh.");
    } finally {
      window.clearTimeout(timeout);
      if (gate.conversationsCurrent(token)) { setThreadsLoading(false); threadsController.current = null; }
    }
  }, [actorId, gate, tenantId]);

  async function send(submission: CompanionSubmission) {
    if (permissionRef.current || editorRef.current.submission !== submission) return;
    const token = gate.beginWrite();
    if (!token) return;
    readController.current?.abort(); setLoading(false);
    const controller = new AbortController(); writeController.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    setSaving(true); setWriteNotice(undefined);
    try {
      const response = await fetch("/api/companion/preferences", {
        method: "PATCH", headers: { "content-type": "application/json", accept: "application/json", "idempotency-key": submission.key },
        body: submission.serializedBody, signal: controller.signal,
      });
      const body: unknown = await response.json();
      if (!gate.writeCurrent(token)) return;
      const parsed = response.ok ? parseCompanionResponse(body, submission) : undefined;
      if (parsed) {
        updateEditor((current) => applyCompanionReceipt(current, parsed, submission));
        setFresh(true); setReadError(undefined);
        setWriteNotice(parsed.mutation?.outcome === "replayed" ? "The original save is confirmed. Its receipt and the current saved revision are shown separately." : "Companion preferences saved. Any edits made while saving remain in your draft.");
      } else {
        const rejection = companionWriteRejection(response.status, body);
        const settled = companionRefusalSettlesSubmission(response.status, body, editorRef.current.submissionUncertain === true);
        updateEditor((current) => ({ ...current, ...(settled ? { submission: undefined, submissionUncertain: false } : { submissionUncertain: true }) }));
        setFresh(false);
        setWriteNotice(settled ? rejection : `${rejection ? `${rejection} The earlier attempt remains unconfirmed. ` : ""}Save not confirmed. It may have reached the server. Retry the same submission to confirm its receipt; your current draft is retained.`);
      }
    } catch {
      if (gate.writeCurrent(token)) {
        updateEditor((current) => ({ ...current, submissionUncertain: true }));
        setFresh(false);
        setWriteNotice("Save not confirmed. It may have reached the server. Retry the same submission to confirm its receipt; your current draft is retained.");
      }
    } finally {
      window.clearTimeout(timeout);
      if (gate.writeCurrent(token)) { gate.finishWrite(token); setSaving(false); writeController.current = null; }
    }
  }
  function submit(action: "save" | "reset") {
    if (blocked || !fresh || saving) return;
    const submission = freezeCompanionSubmission(editorRef.current, action, crypto.randomUUID());
    if (!submission) return;
    updateEditor((current) => ({ ...current, submission, submissionUncertain: false }));
    setConfirm(undefined);
    void send(submission);
  }
  function edit(patch: Partial<Preferences>) {
    updateEditor((current) => current.draft ? { ...current, draft: { ...current.draft, ...patch } } : current);
  }
  function closeConfirmation() {
    const trigger = confirm === "reset" ? resetTrigger : discardTrigger;
    setConfirm(undefined); trigger.current?.focus();
  }
  const { current, draft, receipt, submission } = editor;
  const dirty = companionDraftIsDirty(editor);
  const revisionChanged = Boolean(current && editor.draftRevision !== current.snapshot.revision);
  const writeBlocked = blocked || (submission ? "Confirm the unresolved submission before starting another save." : !fresh ? "Refresh the saved preferences before starting another save." : revisionChanged ? "Review your draft against the current saved revision before saving." : undefined);
  const filtered = (threads ?? []).filter((row) => `${row.title} ${row.id}`.toLocaleLowerCase().includes(search.toLocaleLowerCase().trim()));
  const home = current?.home;
  const draftThread = threads?.find((row) => row.id === draft?.preferredThreadId);

  return <section className={styles.shell} aria-labelledby="companion-preferences-title" data-testid="companion-preferences">
    <header className={styles.header}>
      <div><h2 id="companion-preferences-title">Companion preferences</h2><p>Choose presentation and your default destination for this account.</p></div>
      <button type="button" className={styles.button} disabled={Boolean(blocked) || loading || saving} onClick={() => void load()}>{loading ? "Refreshing preferences…" : current ? "Refresh preferences" : "Retry preferences"}</button>
    </header>
    <p className={styles.support} role="status">{blocked || (loading ? current ? "Refreshing the saved snapshot. Your draft is retained." : "Loading Companion preferences…" : current ? `${fresh ? "Saved snapshot" : "Last loaded snapshot"} · revision ${current.snapshot.revision}${current.snapshot.persisted ? "" : " · defaults have not been saved"}` : "Preferences have not been loaded.")}</p>
    {blocked ? <button className={styles.button} type="button" onClick={checkAccess}>Check workspace access</button> : null}
    {readError ? <p className={styles.error} role="alert">{readError}</p> : null}
    <VoiceAppearancePicker owner={{ tenantId, actorId }} disabled={Boolean(blocked)} />
    {!draft ? <p className={styles.empty}>The preference form becomes available after its saved state is confirmed.</p> : <>
      <div className={styles.layout}>
        <div className={styles.form}>
          <fieldset className={styles.fieldset} disabled={Boolean(blocked)}><legend>Companion style</legend>
            <div className={styles.options}>{COMPANION_INTENSITIES.map((value) => <label className={styles.choice} key={value}><input ref={value === "quiet" ? firstStyleInput : undefined} type="radio" name="companion-intensity" value={value} checked={draft.intensity === value} onChange={() => edit({ intensity: value })} /><span>{intensityLabels[value]}</span></label>)}</div>
            <p className={styles.support}>Quiet is direct. Balanced adds warmth. Expressive allows more personality. Agent permissions and task decisions stay governed.</p>
          </fieldset>
          <label className={styles.choice}><input type="checkbox" checked={draft.visible} disabled={Boolean(blocked)} onChange={(event) => edit({ visible: event.target.checked })} /><span>Show Companion character</span></label>
          <fieldset className={styles.fieldset} disabled={Boolean(blocked)}><legend>Visual motion</legend>
            <div className={styles.options}>{COMPANION_MOTION.map((value) => <label className={styles.choice} key={value}><input type="radio" name="companion-motion" value={value} checked={draft.motion === value} onChange={() => edit({ motion: value })} /><span>{motionLabels[value]}</span></label>)}</div>
            <p className={styles.support}>During voice conversations, Balanced and Expressive react to listening, thinking and speaking. Elsewhere, Balanced reacts to verified results; Expressive also reacts to active work. Quiet, Reduced and Off stay still. Your device’s reduced motion setting is always respected. Motion and visibility do not turn audio on.</p>
          </fieldset>
          <label className={styles.field}><span>Default destination</span><select value={draft.defaultDestination} disabled={Boolean(blocked)} onChange={(event) => edit({ defaultDestination: event.target.value as Preferences["defaultDestination"] })}>{COMPANION_DESTINATIONS.map((value) => <option key={value} value={value}>{destinationLabels[value]}</option>)}</select></label>
        </div>
        <aside className={styles.preview} aria-labelledby="companion-preview-title"><h3 id="companion-preview-title">Writing sample</h3><p className={styles.reading}>{sample[draft.intensity]}</p>
          <dl className={styles.metadata}><dt>Style</dt><dd>{intensityLabels[draft.intensity]}</dd><dt>Character preference</dt><dd>{draft.visible ? "Shown" : "Hidden"}</dd><dt>Effective motion</dt><dd>{osReducedMotion === undefined ? "Checking device preference" : motionLabels[effectiveCompanionMotion(draft.motion, osReducedMotion)]}{osReducedMotion && draft.motion === "full" ? " · device reduction applies" : ""}</dd></dl>
          <p className={styles.support}>This static sample previews your draft. It does not send a message, play audio or start work. Character rendering is separate.</p>
        </aside>
      </div>
      <section className={styles.homeSection} aria-labelledby="companion-home-title"><h3 id="companion-home-title">Preferred home conversation</h3><p className={styles.support}>Choose an existing conversation for Assistant. Opening a different default destination keeps this home choice saved.</p>
        <dl className={styles.metadata}><dt>Current saved home</dt><dd>{home?.preferredThreadId ? <code>{home.preferredThreadId}</code> : "No preferred conversation"}</dd><dt>Availability</dt><dd>{!fresh ? "Last loaded check · " : ""}{home?.state === "available" ? "Available to this account" : home?.state === "unavailable" ? "Unavailable to this account; Assistant is the fallback" : home?.state === "unconfirmed" ? "Access could not be confirmed; Assistant is the fallback" : "Assistant opens without a preferred conversation"}</dd><dt>Draft home</dt><dd>{draft.preferredThreadId ? <>{draftThread ? <span className={styles.threadTitle}>{draftThread.title}</span> : null}<code>{draft.preferredThreadId}</code></> : "No preferred conversation"}</dd></dl>
        {draft.preferredThreadId && threads && !draftThread ? <p className={styles.support}>This draft identity is not present in the loaded selection window. It is retained; omission does not establish deletion.</p> : null}
        <div className={styles.actions}><button ref={pickerTrigger} type="button" className={styles.button} aria-expanded={pickerOpen} aria-controls="companion-conversation-picker" disabled={Boolean(blocked)} onClick={() => { setPickerOpen(!pickerOpen); if (!pickerOpen && !threads && !threadsLoading) void loadThreads(); }}>Choose conversation</button><button type="button" className={styles.button} disabled={Boolean(blocked) || draft.preferredThreadId === null} onClick={() => edit({ preferredThreadId: null })}>Clear home choice</button></div>
        {pickerOpen ? <div className={styles.picker} id="companion-conversation-picker">
          <div className={styles.header}><h4>Owned conversations</h4><div className={styles.actions}><button className={styles.button} type="button" disabled={Boolean(blocked) || threadsLoading} onClick={() => void loadThreads()}>Refresh conversations</button><button className={styles.button} type="button" onClick={() => { setPickerOpen(false); pickerTrigger.current?.focus(); }}>Close picker</button></div></div>
          <p className={styles.support}>Selection is limited to the at most 100 conversations returned for your account. Choosing one changes this draft only.</p>
          <div className={styles.search}><label className={styles.field}><span>Find a conversation in this list</span><input type="search" value={search} onChange={(event) => { setSearch(event.target.value); setShown(20); }} /></label><button className={styles.button} type="button" disabled={!search} onClick={() => { setSearch(""); setShown(20); }}>Clear search</button></div>
          <p className={styles.support} role="status">{threadsLoading ? "Loading conversation choices…" : threadsError ? "Showing last loaded choices, if any." : threads ? `${threads.length} selectable conversations in this window${omitted ? ` · ${omitted} unsupported or unverified rows omitted` : ""}` : "Conversation choices have not been loaded."}</p>
          {threadsError ? <p className={styles.error} role="alert">{threadsError}</p> : null}
          {threads && !threadsLoading && !threadsError && !filtered.length ? <p className={styles.empty}>{threads.length ? "No loaded conversations match this search." : omitted ? "No supported, verified choices are available in this response." : "No conversations were returned in this bounded window."}</p> : null}
          <fieldset className={styles.threadList} disabled={Boolean(blocked) || threadsLoading || Boolean(threadsError)}><legend className={styles.support}>Conversation choices</legend>{filtered.slice(0, shown).map((thread) => <label className={styles.threadChoice} key={thread.id}><input type="radio" name="companion-home" checked={draft.preferredThreadId === thread.id} onChange={() => edit({ preferredThreadId: thread.id })} /><span><strong>{thread.title}</strong><code>{thread.id}</code><span className={styles.support}>{thread.mode} · updated {thread.updatedAt}</span></span></label>)}</fieldset>
          {filtered.length > shown ? <button className={styles.button} type="button" onClick={() => setShown((count) => count + 20)}>Show more loaded conversations</button> : null}
        </div> : null}
      </section>
      <div className={styles.saveArea}>
        <p className={styles.support} role="status">{dirty ? "Unsaved draft" : "Draft matches the saved snapshot"} · draft base revision {editor.draftRevision}. Drafts remain while you switch Settings sections.</p>
        {revisionChanged ? <div className={styles.notice}><p>The saved revision advanced. Review the saved values below before applying this draft to revision {current?.snapshot.revision}.</p><button className={styles.button} type="button" disabled={!fresh || Boolean(submission) || Boolean(blocked)} onClick={() => updateEditor((value) => ({ ...value, draftRevision: value.current?.snapshot.revision }))}>Keep draft against current revision</button></div> : null}
        {writeBlocked ? <p className={styles.support} id="companion-save-help">{writeBlocked}</p> : null}
        <div className={styles.actions}><button type="button" className={`${styles.button} ${styles.primaryButton}`} disabled={Boolean(writeBlocked) || !dirty || saving} aria-describedby={writeBlocked ? "companion-save-help" : undefined} onClick={() => submit("save")}>{saving ? "Saving preferences…" : "Save preferences"}</button><button ref={discardTrigger} className={styles.button} type="button" disabled={!dirty || Boolean(submission) || Boolean(blocked)} onClick={() => setConfirm("discard")}>Use saved preferences</button><button ref={resetTrigger} className={styles.button} type="button" disabled={Boolean(writeBlocked) || saving} onClick={() => setConfirm("reset")}>Reset preferences</button></div>
        {confirm ? <div className={styles.confirmation} role="group" aria-labelledby="companion-confirm-title"><h4 id="companion-confirm-title">{confirm === "reset" ? "Reset all Companion preferences?" : "Replace this draft with saved preferences?"}</h4><p>{confirm === "reset" ? "This saves Balanced, shown character, Full motion, Assistant, and no preferred home. Device reduced motion still applies." : "Your unsaved local edits will be replaced by the current loaded snapshot."}</p><div className={styles.actions}><button className={styles.button} type="button" disabled={confirm === "reset" && Boolean(writeBlocked)} onClick={() => { if (confirm === "reset") { submit("reset"); firstStyleInput.current?.focus(); } else { updateEditor((value) => value.current ? { ...value, draft: { ...value.current.snapshot.preferences }, draftRevision: value.current.snapshot.revision } : value); setConfirm(undefined); firstStyleInput.current?.focus(); } }}>{confirm === "reset" ? "Confirm reset" : "Replace draft"}</button><button className={styles.button} type="button" onClick={closeConfirmation}>Keep editing</button></div></div> : null}
        {writeNotice ? <p className={submission ? styles.notice : styles.support} role="status">{writeNotice}</p> : null}
        {submission ? <div className={styles.pending}><h4>{saving ? "Submission in progress" : "Unconfirmed submission"}</h4><p className={styles.support}>The saved request stays unchanged while you edit. Aborting a browser request does not establish that the server canceled it.</p><dl className={styles.metadata}><dt>Request identity</dt><dd><code>{submission.key}</code></dd><dt>Expected revision</dt><dd>{submission.body.expectedRevision}</dd><dt>Requested change</dt><dd><code>{submission.serializedBody}</code></dd></dl><button className={styles.button} type="button" disabled={saving || Boolean(blocked)} onClick={() => void send(submission)}>Retry same submission</button></div> : null}
      </div>
      {current ? <details className={styles.details}><summary>Current saved values · revision {current.snapshot.revision}</summary><PreferenceDetails preferences={current.snapshot.preferences} /><p className={styles.support}>{current.snapshot.updatedAt ? `Saved at ${current.snapshot.updatedAt}` : "Defaults have not been persisted."}</p></details> : null}
      {receipt ? <details className={styles.details} open><summary>Confirmed save receipt · revision {receipt.revision}</summary><p className={styles.support}>{receipt.outcome === "replayed" ? "Original submission replay confirmed" : "Save confirmed"} · {receipt.savedAt}</p><code>{receipt.receiptId}</code><PreferenceDetails preferences={receipt.preferences} />{current && receipt.revision < current.snapshot.revision ? <p className={styles.support}>This receipt precedes the current saved revision {current.snapshot.revision}; it does not replace that newer snapshot.</p> : null}</details> : null}
    </>}
  </section>;
}

function PreferenceDetails({ preferences }: { preferences: Preferences }) {
  return <dl className={styles.metadata}><dt>Style</dt><dd>{intensityLabels[preferences.intensity]}</dd><dt>Character</dt><dd>{preferences.visible ? "Shown" : "Hidden"}</dd><dt>Motion</dt><dd>{motionLabels[preferences.motion]}</dd><dt>Default destination</dt><dd>{destinationLabels[preferences.defaultDestination]}</dd><dt>Preferred home</dt><dd>{preferences.preferredThreadId ? <code>{preferences.preferredThreadId}</code> : "None"}</dd></dl>;
}
