"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Phone, RefreshCw, ChevronRight } from "lucide-react";
import type { CaptureMediaOutput } from "@/lib/capture/media-contracts";
import styles from "./conversation-notes.module.css";

type Conversation = { id: string; title: string; sourceKind: "call" | "listen"; recordedAt: string;
  status: "recording" | "processing" | "ready" | "failed"; summary: string; category: string; durationMs: number;
  actionCount: number; error: string | null; transcript?: string; media?: CaptureMediaOutput | null;
  clientContext?: { status: string; message: string } };

export function ConversationNotes({ enabled }: { enabled: boolean }) {
  const [items, setItems] = useState<Conversation[]>([]);
  const [selected, setSelected] = useState<Conversation>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const abort = useRef<AbortController | undefined>(undefined);
  const load = useCallback(async () => {
    if (!enabled || document.hidden) return;
    const epoch = generation.current;
    setBusy(true);
    try {
      const response = await fetch("/api/mobile/listen/conversations", { cache: "no-store" });
      if (!response.ok) throw new Error("Conversation notes could not be loaded. Try refreshing.");
      const body = await response.json() as { conversations: Conversation[] };
      if (epoch !== generation.current || document.hidden) return;
      if (!Array.isArray(body.conversations)) throw new Error("Conversation notes are temporarily unavailable.");
      setItems(body.conversations); setError("");
    } catch (reason) {
      if (epoch === generation.current && !document.hidden) setError(reason instanceof Error ? reason.message : "Conversation notes could not be loaded.");
    } finally { if (epoch === generation.current) setBusy(false); }
  }, [enabled]);
  useEffect(() => {
    const refresh = () => {
      if (document.hidden) { generation.current++; abort.current?.abort(); setSelected(undefined); setItems([]); }
      else void load();
    };
    const timer = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => void load(), 30_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { generation.current++; abort.current?.abort(); window.clearTimeout(timer); window.clearInterval(interval); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  async function open(item: Conversation) {
    abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
    const epoch = generation.current;
    setSelected(item);
    try {
      const response = await fetch(`/api/mobile/listen/conversations/${encodeURIComponent(item.id)}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("This conversation could not be opened. Refresh and try again.");
      const body = await response.json() as { conversation: Conversation };
      if (!controller.signal.aborted && epoch === generation.current && !document.hidden) { setSelected(body.conversation); setError(""); }
    } catch (reason) {
      if (!controller.signal.aborted && epoch === generation.current) setError(reason instanceof Error ? reason.message : "This conversation could not be opened.");
    }
  }
  if (!enabled) return null;
  return <section className={styles.shell} aria-label="Conversation notes">
    <header className={styles.header}>
      <div><h2><AudioLines size={20} aria-hidden="true" /> Conversation notes</h2><p>Listen on your phone. Find the context, people and follow-ups here.</p></div>
      <button type="button" onClick={() => void load()} disabled={busy} aria-label="Refresh conversation notes"><RefreshCw size={16} aria-hidden="true" /> Refresh</button>
    </header>
    {error ? <p role="alert">{error}</p> : null}
    {!items.length && !error ? <p className={styles.empty}>{busy ? "Loading conversations…" : "Your phone recordings and nightly call notes will appear here. Set up Listen in the mobile app’s Capture tab."}</p> : null}
    {items.length ? <div className={styles.layout}>
      <div className={styles.list} aria-label="Recent conversations">{items.map((item) => <button className={styles.item} type="button" key={item.id} aria-pressed={selected?.id === item.id} onClick={() => void open(item)}>
        {item.sourceKind === "call" ? <Phone size={18} aria-hidden="true" /> : <AudioLines size={18} aria-hidden="true" />}
        <span><strong>{item.title}</strong><small>{new Date(item.recordedAt).toLocaleString(undefined, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · {statusLabel(item.status)}</small></span><ChevronRight size={16} aria-hidden="true" />
      </button>)}</div>
      <article className={styles.detail} aria-live="polite">
        {selected ? <>
          <div className={styles.eyebrow}>{selected.sourceKind === "call" ? "Call notes" : "Conversation"} · {selected.category === "unfiled" ? "Choose context later" : selected.category === "work" ? "Work" : "Personal"}</div>
          <h3>{selected.title}</h3>
          {selected.error ? <p role="alert">{selected.error}</p> : null}
          {selected.clientContext?.message ? <p className={styles.footnote}>{selected.clientContext.message}</p> : null}
          <p className={styles.summary}>{selected.media?.summary.text || selected.summary || "The recording is being turned into conversation notes."}</p>
          {selected.media?.conversation ? <>
            <div className={styles.tags}>{selected.media.conversation.categories.map((tag) => <span key={tag}>{tag}</span>)}</div>
            <Notes title="Worth remembering" items={selected.media.conversation.keyFacts} />
            <Notes title="People and relationships" items={selected.media.conversation.relationships} />
            <Notes title="Open questions" items={selected.media.conversation.openQuestions} />
          </> : null}
          {selected.media?.actionItems.length ? <section><h4>Follow-ups</h4><ul>{selected.media.actionItems.map((item) => <li key={item.actionItemId}><p>{item.text}</p><small>{item.ownerParticipantId ? "Owner identified in the conversation" : "Confirm who owns this"}{item.dueAt ? ` · ${new Date(item.dueAt).toLocaleDateString()}` : ""} · {stamp(item.citations[0]?.startMilliseconds || 0)}</small></li>)}</ul></section> : null}
          {selected.media?.decisions.length ? <Notes title="Decisions" items={selected.media.decisions} /> : null}
          {selected.media && selected.media.chapters.length > 1 ? <details><summary>Conversation sections</summary>{selected.media.chapters.map((chapter) => <section key={chapter.chapterId}><h4>{chapter.title} · {stamp(chapter.startMilliseconds)}</h4><p className={styles.summary}>{chapter.text}</p></section>)}</details> : null}
          {selected.transcript ? <details><summary>Read transcript</summary><p className={styles.transcript}>{selected.transcript}</p></details> : null}
          {selected.media ? <p className={styles.footnote}>Automatic notes from the recording. Speaker identities and stated relationships may need confirmation. Original call files remain on your phone.</p> : null}
        </> : <div className={styles.empty}><AudioLines size={28} aria-hidden="true" /><p>Choose a conversation to see what mattered and what comes next.</p></div>}
      </article>
    </div> : null}
  </section>;
}

function Notes({ title, items }: { title: string; items: { text: string; citations: { startMilliseconds: number }[] }[] }) {
  if (!items.length) return null;
  return <section><h4>{title}</h4><ul>{items.map((item, index) => <li key={index}><p>{item.text}</p><small>From {stamp(item.citations[0]?.startMilliseconds || 0)}</small></li>)}</ul></section>;
}
function stamp(ms: number) { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`; }
function statusLabel(status: Conversation["status"]) { return ({ recording: "Saving", processing: "Preparing notes", ready: "Ready", failed: "Needs attention" })[status]; }
