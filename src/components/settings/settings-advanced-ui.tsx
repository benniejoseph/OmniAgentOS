"use client";

import { useId, useLayoutEffect, useRef, type ReactNode } from "react";
import styles from "./settings-advanced.module.css";

export function SettingsField({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.field}><span>{label}</span>{children}</label>;
}
export function SettingsCheck({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (value: boolean) => void }) {
  return <label className={styles.check}><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}
export function Metadata({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return <dl className={styles.metadata}>{items.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>;
}
export function SettingsDialog({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useLayoutEffect(() => {
    const dialog = ref.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog?.showModal();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, []);
  return <dialog ref={ref} aria-labelledby={heading} className={`${styles.workspace} ${styles.dialog}`} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <div className={styles.rowHeader}><h2 id={heading}>{title}</h2><button type="button" onClick={onClose} disabled={busy} aria-label={`Close ${title}`}>Close</button></div>
    {children}
    {busy ? <p className={styles.support}>A request is pending. Closing will be available after its response.</p> : null}
  </dialog>;
}
export function ReadNotice({ loaded, loading, error, label }: { loaded: boolean; loading: boolean; error?: string; label: string }) {
  return <div className={styles.notice}>
    <p role="status">{loading ? loaded ? `Refreshing ${label}. Last-loaded details and drafts are retained.` : `Loading ${label}…` : error ? loaded ? `${label}: refresh unavailable; last-loaded details are shown.` : `${label} are unavailable.` : `${label} are current as of the last successful read.`}</p>
    {error ? <p role="alert" className={styles.error}>{error}</p> : null}
  </div>;
}
