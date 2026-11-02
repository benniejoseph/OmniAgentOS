"use client";

import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import type { BuildProject } from "@/components/app-builder/model";
import styles from "./assistant-coding-dialog.module.css";

const Builder = dynamic(() => import("@/components/app-builder-studio").then(module => module.AppBuilderStudio),
  { loading: () => <p role="status">Opening project files…</p> });

export function AssistantCodingDialog({ projectId, ownerScope, canManage, read, onClose }: {
  projectId: string;
  ownerScope: string;
  canManage: boolean;
  read: (path: string, init?: RequestInit) => Promise<unknown>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [project, setProject] = useState<BuildProject>();
  const [error, setError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const [unsaved, setUnsaved] = useState(false);
  const close = () => {
    if (!unsaved || window.confirm("Discard the unsaved file change and close this workspace?")) dialog.current?.close();
  };
  useEffect(() => { dialog.current?.showModal(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    const timeout = window.setTimeout(() => controller.abort(), 30_000);
    void read(`/api/projects/${encodeURIComponent(projectId)}`, { signal: controller.signal }).then(value => {
      if (!current) return;
      const record = value && typeof value === "object" ? (value as { project?: unknown }).project : undefined;
      if (!record || typeof record !== "object") throw new Error("Project is unavailable.");
      const p = record as Record<string, unknown>;
      if (p.id !== projectId || typeof p.title !== "string" || typeof p.objective !== "string" || typeof p.status !== "string") {
        throw new Error("Project details did not match this workspace.");
      }
      setProject({ id: projectId, title: p.title, objective: p.objective, status: p.status });
    }).catch(() => {
      if (current) setError("Project files could not be opened. Check project access and try again.");
    }).finally(() => window.clearTimeout(timeout));
    return () => { current = false; window.clearTimeout(timeout); controller.abort(); };
  }, [projectId, ownerScope, read, attempt]);
  return <dialog ref={dialog} className={styles.dialog} aria-labelledby="assistant-code-title" onClose={onClose}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className={styles.header}>
      <div><h2 id="assistant-code-title">{project?.title || "Coding workspace"}</h2>
        <p>Files, changes, checks, and preview. Your conversation stays open.</p></div>
      <button type="button" onClick={close} aria-label="Close coding workspace" autoFocus><X size={20} aria-hidden="true" /></button>
    </header>
    <div className={styles.body}>
      {error ? <div><p role="alert">{error}</p>
        <button type="button" className="action-link" onClick={() => {
          setError(undefined); setProject(undefined); setAttempt(value => value + 1);
        }}>Try again</button>
      </div> : project
        ? <Builder project={project} ownerScopeKey={ownerScope} accessReady canManage={canManage} active onUnsavedChange={setUnsaved} />
        : <p role="status">Loading your project…</p>}
    </div>
  </dialog>;
}
