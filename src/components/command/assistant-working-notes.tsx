"use client";

import { useState } from "react";
import { Check, ChevronDown, ChevronRight, Circle, CircleAlert, Clock3 } from "lucide-react";
import { workingNotes, type WorkingNote } from "@/lib/command/working-summary";
import styles from "@/components/agent-runs-workspace.module.css";

/** Public work updates, separate from both the response and the source-quality advisory. */
export function AssistantWorkingNotes({ terminal, status, summary, events, onOpen }: {
  terminal: boolean;
  status: string;
  summary: string;
  events: readonly unknown[];
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState<boolean>();
  const open = expanded ?? !terminal;
  const notes = workingNotes(events);
  return <section className={styles.workingNotes} aria-label="Working notes">
    <button type="button" className={styles.workingToggle} aria-expanded={open}
      onClick={() => setExpanded(!open)}>
      <span className={styles.workingLabel}>Working notes</span>
      <span className={styles.workingSummary} role="status">{status}</span>
      <ChevronDown size={14} className={styles.disclosureChevron} data-open={open} aria-hidden="true" />
    </button>
    {open ? <div className={styles.workingBody}>
      {notes.length ? <ol>{notes.map((note, index) => <li key={index} data-state={note.state}>
        <NoteMarker state={note.state} />
        <div><span className={styles.workingNoteTitle}>{note.title}</span>
          {note.detail ? <p>{note.detail}</p> : null}</div>
      </li>)}</ol> : <p>{summary || "Waiting for the first progress update."}</p>}
      <button type="button" onClick={onOpen} className={styles.modeAction} aria-haspopup="dialog">
        All activity and results <ChevronRight size={13} aria-hidden="true" />
      </button>
    </div> : null}
  </section>;
}

function NoteMarker({ state }: { state: WorkingNote["state"] }) {
  const Icon = state === "done" ? Check : state === "waiting" ? Clock3 : state === "failed" ? CircleAlert : Circle;
  return <Icon size={13} className={styles.workingNoteMarker} aria-hidden="true" />;
}
