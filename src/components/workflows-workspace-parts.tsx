"use client";

import { type ReactNode } from "react";
import { exactJson, text, type WorkflowRead } from "./workflows-workspace-state";
import styles from "./workflows-workspace.module.css";

export function WorkflowEvidence({ title, value, open = false }: { title: string; value: unknown; open?: boolean }) {
  return <details className={styles.evidence} open={open}><summary>{title}</summary><pre>{exactJson(value)}</pre></details>;
}
export function WorkflowFields({ values }: { values: Array<[string, unknown]> }) {
  return <dl className={styles.fields}>{values.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{typeof value === "number" ? value.toLocaleString() : typeof value === "boolean" ? value ? "Yes" : "No" : text(value)}</dd></div>)}</dl>;
}
export function WorkflowReadNotice({ label, read, onRefresh, disabled }: { label: string; read: WorkflowRead; onRefresh: () => void; disabled?: boolean }) {
  return <div className={styles.readNotice}>
    <p role="status">{read.status === "ready" ? `${label} loaded.` : read.data ? `${read.status === "loading" ? "Refreshing" : "Refresh unavailable for"} ${label.toLowerCase()}. Last-loaded records and counts remain visible.` : read.status === "loading" ? `Loading ${label.toLowerCase()}…` : `${label} unavailable. Counts and empty state could not be checked.`}</p>
    {read.status === "error" && read.error ? <p className={styles.error}>{read.error}</p> : null}
    <button type="button" onClick={onRefresh} disabled={disabled}>{read.status === "loading" ? `Restart ${label.toLowerCase()} read` : `Refresh ${label.toLowerCase()}`}</button>
  </div>;
}
export function WorkflowSection({ title, children, description }: { title: string; children: ReactNode; description?: string }) {
  return <section className={styles.section} aria-label={title}><header className={styles.sectionHeading}><h2>{title}</h2>{description ? <p>{description}</p> : null}</header>{children}</section>;
}
