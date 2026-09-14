"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Code2,
  ExternalLink,
  FileCode2,
  Files,
  GitBranch,
  Loader2,
  MonitorPlay,
  RotateCcw,
  Play,
  RefreshCw,
  Rocket,
  Save,
  Send,
  ShieldCheck,
  SquareTerminal,
  WandSparkles,
} from "lucide-react";
import styles from "./app-builder-studio.module.css";

type BuildProject = Readonly<{ id: string; title: string; objective: string; status: string }>;
type BuilderSession = Readonly<{ id: string; projectId: string; status: "provisioning" | "ready" | "running" | "failed" | "stopped"; revision: number; currentCheckpointId?: string; templateId: string; lastErrorCode?: string; updatedAt: string }>;
type BuilderActivity = Readonly<{ id: string; eventType: string; detail: Record<string, unknown>; occurredAt: string }>;
type BuilderCheckpoint = Readonly<{ id: string; sessionId: string; workspaceSha256: string; fileCount: number; snapshotBytes: number; reason: "manual" | "before_forge" | "after_forge" | "before_sentinel" | "before_restore"; label: string; sourceRunId?: string; sessionRevision: number; createdAt: string; expiresAt?: string }>;
type BuilderVerification = Readonly<{ id: string; sessionId: string; checkpointId: string; workspaceSha256: string; status: "passed" | "failed" | "incomplete"; checks: ReadonlyArray<{ command: "lint" | "typecheck"; status: "passed" | "failed"; exitCode: number; durationMs: number; outputSha256: string }>; browserEvidence: { status: "captured" | "unavailable" | "failed"; captures: ReadonlyArray<{ viewport: "desktop" | "mobile"; width: number; height: number; screenshotSha256: string; mimeType: string; byteLength: number }>; errorCode?: string }; createdAt: string }>;
type TreeEntry = Readonly<{ path: string; kind: "file" | "directory"; size?: number }>;
type BuilderFile = Readonly<{ path: string; content: string; sha256: string; size: number }>;
type SessionPayload = Readonly<{ session: BuilderSession | null; activity: BuilderActivity[]; checkpoints: BuilderCheckpoint[]; verifications: BuilderVerification[]; previewUrl: string | null }>;
type AgentEvent = { type?: string; runId?: string; text?: string; response?: string; message?: string; label?: string; detail?: string; toolName?: string; status?: string };

const commands = ["lint", "typecheck", "test", "build"] as const;

export function AppBuilderStudio({ project }: { project: BuildProject }) {
  const [snapshot, setSnapshot] = useState<SessionPayload>({ session: null, activity: [], checkpoints: [], verifications: [], previewUrl: null });
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [file, setFile] = useState<BuilderFile>();
  const [draft, setDraft] = useState("");
  const [view, setView] = useState<"preview" | "code">("preview");
  const [rail, setRail] = useState<"files" | "checkpoints" | "activity">("files");
  const [prompt, setPrompt] = useState("");
  const [agentOutput, setAgentOutput] = useState("");
  const [sentinelOutput, setSentinelOutput] = useState("");
  const [commandOutput, setCommandOutput] = useState("");
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState<string>();
  const session = snapshot.session;
  const ready = session?.status === "ready" || session?.status === "running";
  const dirty = Boolean(file && draft !== file.content);
  const latestVerification = snapshot.verifications[0];

  const loadSession = useCallback(async () => {
    const payload = await readJson<SessionPayload>(`/api/projects/${encodeURIComponent(project.id)}/builder`);
    setSnapshot(payload);
    return payload;
  }, [project.id]);

  const loadFile = useCallback(async (target: BuilderSession, path: string) => {
    const payload = await readJson<{ file: BuilderFile }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=file&sessionId=${encodeURIComponent(target.id)}&path=${encodeURIComponent(path)}`);
    setFile(payload.file);
    setDraft(payload.file.content);
  }, [project.id]);

  const loadTree = useCallback(async (target: BuilderSession, preferredPath?: string) => {
    const payload = await readJson<{ entries: TreeEntry[] }>(`/api/projects/${encodeURIComponent(project.id)}/builder?view=tree&sessionId=${encodeURIComponent(target.id)}`);
    setTree(payload.entries);
    const paths = payload.entries.filter((entry) => entry.kind === "file").map((entry) => entry.path);
    const nextPath = preferredPath && paths.includes(preferredPath) ? preferredPath : paths.includes("app/page.tsx") ? "app/page.tsx" : paths[0];
    if (nextPath) await loadFile(target, nextPath);
  }, [loadFile, project.id]);

  useEffect(() => {
    let active = true;
    async function initialize() {
      try {
        const payload = await readJson<SessionPayload>(`/api/projects/${encodeURIComponent(project.id)}/builder`);
        if (!active) return;
        setSnapshot(payload);
        if (payload.session && (payload.session.status === "ready" || payload.session.status === "running")) {
          await loadTree(payload.session);
        }
      } catch (loadError) {
        if (active) setError(message(loadError));
      } finally {
        if (active) setBusy("");
      }
    }
    void initialize();
    return () => { active = false; };
  }, [loadTree, project.id]);

  async function createWorkspace() {
    setBusy("create");
    setError(undefined);
    try {
      const payload = await mutate<SessionPayload & { created: boolean }>(project.id, { action: "create" }, `builder-create:${project.id}`);
      setSnapshot(payload);
      if (payload.session) await loadTree(payload.session);
    } catch (createError) {
      setError(message(createError));
    } finally {
      setBusy("");
    }
  }

  async function saveFile() {
    if (!session || !file || !dirty) return;
    setBusy("save");
    setError(undefined);
    try {
      await mutate(project.id, { action: "file.update", sessionId: session.id, path: file.path, expectedSha256: file.sha256, content: draft });
      await loadFile(session, file.path);
      await loadSession();
    } catch (saveError) {
      setError(message(saveError));
    } finally {
      setBusy("");
    }
  }

  async function createCheckpoint(
    target: BuilderSession,
    reason: "manual" | "before_forge" | "after_forge" | "before_sentinel",
    label: string,
    sourceRunId?: string,
  ) {
    const payload = await mutate<SessionPayload & { checkpoint: BuilderCheckpoint }>(project.id, {
      action: "checkpoint.create",
      sessionId: target.id,
      expectedSessionRevision: target.revision,
      reason,
      label,
      ...(sourceRunId ? { sourceRunId } : {}),
    });
    setSnapshot(payload);
    return payload;
  }

  async function saveCheckpoint() {
    if (!session || dirty) return;
    setBusy("checkpoint");
    setError(undefined);
    try {
      await createCheckpoint(session, "manual", `Saved revision ${session.revision}`);
      setRail("checkpoints");
    } catch (checkpointError) {
      setError(message(checkpointError));
    } finally {
      setBusy("");
    }
  }

  async function restoreCheckpoint(checkpoint: BuilderCheckpoint) {
    if (!session || dirty || session.currentCheckpointId === checkpoint.id) return;
    if (!window.confirm(`Restore “${checkpoint.label}”? Asael will save the current workspace first.`)) return;
    setBusy(`restore:${checkpoint.id}`);
    setError(undefined);
    try {
      const payload = await mutate<SessionPayload & { restored: boolean }>(project.id, {
        action: "checkpoint.restore",
        sessionId: session.id,
        checkpointId: checkpoint.id,
        expectedSessionRevision: session.revision,
      });
      setSnapshot(payload);
      if (payload.session) await loadTree(payload.session, file?.path);
      setView("preview");
    } catch (restoreError) {
      setError(message(restoreError));
    } finally {
      setBusy("");
    }
  }

  async function runCommand(command: typeof commands[number] | "start_preview") {
    if (!session) return;
    setBusy(command);
    setError(undefined);
    setCommandOutput("");
    try {
      const payload = await mutate<{ result: { exitCode: number; stdout: string; stderr: string; durationMs: number } }>(project.id, { action: "command.run", sessionId: session.id, command });
      setCommandOutput([payload.result.stdout, payload.result.stderr].filter(Boolean).join("\n") || `${command} completed with exit code ${payload.result.exitCode}.`);
      if (command === "start_preview") await loadSession();
      await loadSession();
    } catch (commandError) {
      setError(message(commandError));
    } finally {
      setBusy("");
    }
  }

  async function askForge(event: React.FormEvent) {
    event.preventDefault();
    const request = prompt.trim();
    if (!request || !session || dirty) return;
    setBusy("forge");
    setAgentOutput("");
    setError(undefined);
    try {
      const sealed = await createCheckpoint(session, "before_forge", `Before Forge · ${request.slice(0, 90)}`);
      if (!sealed.session) throw new Error("The recovery checkpoint did not return an active session.");
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "execute",
          projectId: project.id,
          message: `Work only in App Builder session ${session.id} for project ${project.id}. Inspect files before editing and preserve SHA-256 fences. User request: ${request}. Run focused checks and restart the preview when complete.`,
          requestId: crypto.randomUUID(),
          strategy: "direct",
          agentId: "forge",
          contextScope: "project",
          contextSelection: { evidenceIds: [] },
        }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(String(body.error || body.message || `Forge returned ${response.status}`));
      }
      let accumulated = "";
      let runId = "";
      let completed = false;
      await readSse(response.body, (agentEvent) => {
        if (agentEvent.type === "run" && agentEvent.runId) runId = agentEvent.runId;
        if (agentEvent.type === "delta" && agentEvent.text) accumulated += agentEvent.text;
        if (agentEvent.type === "done") {
          completed = true;
          if (agentEvent.response) accumulated = agentEvent.response;
        }
        if (agentEvent.type === "status" && !accumulated) accumulated = [agentEvent.label, agentEvent.detail].filter(Boolean).join(" — ");
        if (agentEvent.type === "tool") accumulated += `\n${agentEvent.toolName || "Tool"}: ${agentEvent.status || "working"}`;
        if (agentEvent.type === "waiting_approval") accumulated += `\n${agentEvent.message || "Forge is waiting for approval in Command."}`;
        if (agentEvent.type === "error") throw new Error(agentEvent.message || "Forge stopped unexpectedly.");
        setAgentOutput(accumulated.trim());
      });
      setPrompt("");
      const refreshed = await loadSession();
      let finalSnapshot = refreshed;
      if (completed && runId && refreshed.session) {
        finalSnapshot = await createCheckpoint(refreshed.session, "after_forge", `Forge result · ${request.slice(0, 88)}`, runId);
      }
      if (finalSnapshot.session) await loadTree(finalSnapshot.session, file?.path);
    } catch (agentError) {
      setError(message(agentError));
    } finally {
      setBusy("");
    }
  }

  async function verifyWithSentinel() {
    if (!session || dirty) return;
    setBusy("sentinel");
    setSentinelOutput("");
    setError(undefined);
    try {
      const sealed = await createCheckpoint(session, "before_sentinel", `Sentinel review · revision ${session.revision}`);
      if (!sealed.session) throw new Error("Sentinel could not seal the workspace revision.");
      const verificationPayload = await mutate<{ verification: BuilderVerification }>(project.id, {
        action: "verification.run",
        sessionId: sealed.session.id,
        checkpointId: sealed.checkpoint.id,
        expectedSessionRevision: sealed.session.revision,
      });
      const verification = verificationPayload.verification;
      setSnapshot((current) => ({ ...current, verifications: [verification, ...current.verifications.filter((item) => item.id !== verification.id)] }));
      const response = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          mode: "execute",
          projectId: project.id,
          message: `Independently review App Builder verification ${verification.id} at checkpoint ${verification.checkpointId} in session ${sealed.session.id}. Use the governed verification receipt and inspect the project files. Project objective: ${project.objective}. Deterministic evidence: ${JSON.stringify(verification)}. Return a concise PASS or BLOCK verdict, specific evidence, and the smallest corrective actions. Never claim to have seen screenshot pixels; only digest metadata is available.`,
          requestId: crypto.randomUUID(),
          strategy: "direct",
          agentId: "sentinel",
          contextScope: "project",
          contextSelection: { evidenceIds: [] },
        }),
      });
      if (!response.ok || !response.body) {
        const body = await response.json().catch(() => ({})) as Record<string, unknown>;
        throw new Error(String(body.error || body.message || `Sentinel returned ${response.status}`));
      }
      let accumulated = "";
      let runId = "";
      let completed = false;
      await readSse(response.body, (agentEvent) => {
        if (agentEvent.type === "run" && agentEvent.runId) runId = agentEvent.runId;
        if (agentEvent.type === "delta" && agentEvent.text) accumulated += agentEvent.text;
        if (agentEvent.type === "done") {
          completed = true;
          if (agentEvent.response) accumulated = agentEvent.response;
        }
        if (agentEvent.type === "status" && !accumulated) accumulated = [agentEvent.label, agentEvent.detail].filter(Boolean).join(" — ");
        if (agentEvent.type === "tool") accumulated += `\n${agentEvent.toolName || "Tool"}: ${agentEvent.status || "working"}`;
        if (agentEvent.type === "error") throw new Error(agentEvent.message || "Sentinel stopped unexpectedly.");
        setSentinelOutput(accumulated.trim());
      });
      if (!completed || !runId) throw new Error("Sentinel did not produce a completed review receipt.");
      await mutate(project.id, {
        action: "sentinel.record",
        sessionId: sealed.session.id,
        verificationId: verification.id,
        sourceRunId: runId,
      });
      await loadSession();
    } catch (verificationError) {
      setError(message(verificationError));
    } finally {
      setBusy("");
    }
  }

  const files = useMemo(() => tree.filter((entry) => entry.kind === "file"), [tree]);

  if (busy === "loading") return <section className={styles.loading}><Loader2 className="animate-spin" size={20} /><span>Opening the build studio…</span></section>;

  if (!session) return (
    <section className={styles.empty}>
      <div className={styles.emptyMark}><WandSparkles size={28} /></div>
      <p>Build mode</p>
      <h3>Turn this project into a working app.</h3>
      <span>Forge gets a private Next.js workspace with inspected file edits, fixed verification commands, and a live preview. The sandbox can reach the package registry only.</span>
      <div className={styles.guardrails}><span><ShieldCheck size={14} /> Project-scoped</span><span><Code2 size={14} /> TypeScript starter</span><span><MonitorPlay size={14} /> Private preview</span></div>
      <button type="button" onClick={() => void createWorkspace()} disabled={busy === "create" || project.status === "archived"}>{busy === "create" ? <Loader2 className="animate-spin" size={15} /> : <Play size={15} />} Create build workspace</button>
      {error ? <p className={styles.error} role="alert"><AlertCircle size={14} /> {error}</p> : null}
    </section>
  );

  if (!ready) return (
    <section className={styles.empty}>
      <div className={styles.emptyMark}><AlertCircle size={28} /></div>
      <p>Build workspace · {session.status}</p>
      <h3>{session.status === "failed" ? "The sandbox needs attention." : "The workspace is not running."}</h3>
      <span>{session.lastErrorCode ? `Provisioning receipt: ${session.lastErrorCode}` : "Its files and activity remain recorded."}</span>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </section>
  );

  return (
    <section className={styles.studio} aria-busy={Boolean(busy)}>
      <header className={styles.studioHeader}>
        <div><span className={styles.liveDot} /><div><strong>Build studio</strong><small>{session.templateId} · revision {session.revision}</small></div></div>
        <div className={styles.headerActions}>
          <button type="button" onClick={() => void saveCheckpoint()} disabled={Boolean(busy) || dirty} title={dirty ? "Save the open file before sealing a checkpoint" : "Save a recoverable checkpoint"}><Save size={14} /> Checkpoint</button>
          <button type="button" onClick={() => void runCommand("start_preview")} disabled={Boolean(busy)} title="Restart preview"><RefreshCw size={14} className={busy === "start_preview" ? "animate-spin" : undefined} /></button>
          {snapshot.previewUrl ? <a href={snapshot.previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={14} /> Open preview</a> : null}
          <button type="button" disabled title="GitHub publishing arrives after the build loop is verified"><GitBranch size={14} /> GitHub</button>
          <button type="button" disabled title="Deployment is intentionally held for the next release slice"><Rocket size={14} /> Deploy</button>
        </div>
      </header>

      {error ? <div className={styles.errorBanner} role="alert"><AlertCircle size={15} /><span>{error}</span><button type="button" onClick={() => setError(undefined)}>Dismiss</button></div> : null}

      <div className={styles.workspace}>
        <aside className={styles.fileRail}>
          <div className={styles.railTabs} role="tablist"><button type="button" className={rail === "files" ? styles.selected : undefined} onClick={() => setRail("files")}><Files size={14} /> Files</button><button type="button" className={rail === "checkpoints" ? styles.selected : undefined} onClick={() => setRail("checkpoints")}><RotateCcw size={14} /> Restore</button><button type="button" className={rail === "activity" ? styles.selected : undefined} onClick={() => setRail("activity")}><Activity size={14} /> Activity</button></div>
          {rail === "files" ? <div className={styles.fileList}>{files.map((entry) => <button type="button" key={entry.path} className={file?.path === entry.path ? styles.selectedFile : undefined} onClick={() => { if (dirty && !window.confirm("Discard the unsaved file change?")) return; void loadFile(session, entry.path); setView("code"); }}><FileCode2 size={13} /><span>{entry.path}</span><small>{formatBytes(entry.size || 0)}</small></button>)}</div> : rail === "checkpoints" ? <div className={styles.checkpointList}>{snapshot.checkpoints.length ? snapshot.checkpoints.map((checkpoint) => { const current = session.currentCheckpointId === checkpoint.id; return <article key={checkpoint.id} data-current={current || undefined}><div><i /><span>{current ? "Current seal" : checkpointReason(checkpoint.reason)}</span></div><strong>{checkpoint.label}</strong><small>{new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.fileCount} files</small><code>{checkpoint.workspaceSha256.slice(0, 12)}</code><button type="button" onClick={() => void restoreCheckpoint(checkpoint)} disabled={Boolean(busy) || dirty || current}>{busy === `restore:${checkpoint.id}` ? <Loader2 className="animate-spin" size={12} /> : <RotateCcw size={12} />} {current ? "Current" : "Restore"}</button></article>; }) : <p>No checkpoints yet. Save one before a risky change.</p>}</div> : <div className={styles.activityList}>{snapshot.activity.length ? snapshot.activity.map((item) => <article key={item.id}><i /><div><strong>{eventLabel(item.eventType)}</strong><small>{new Date(item.occurredAt).toLocaleString()}</small>{activityDetail(item)}</div></article>) : <p>No build activity yet.</p>}</div>}
        </aside>

        <div className={styles.canvas}>
          <div className={styles.canvasTabs} role="tablist"><button type="button" className={view === "preview" ? styles.selected : undefined} onClick={() => setView("preview")}><MonitorPlay size={14} /> Preview</button><button type="button" className={view === "code" ? styles.selected : undefined} onClick={() => setView("code")}><Code2 size={14} /> Code{dirty ? <i /> : null}</button><span>{file?.path || "No file selected"}</span></div>
          {view === "preview" ? <div className={styles.previewFrame}>{snapshot.previewUrl ? <iframe key={snapshot.previewUrl} src={snapshot.previewUrl} title={`${project.title} live preview`} sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts" /> : <div><Loader2 className="animate-spin" /><span>Preview is waking up…</span></div>}</div> : <div className={styles.editor}><div><span>{file?.path}</span><small>{file ? `${formatBytes(file.size)} · ${file.sha256.slice(0, 10)}…` : ""}</small></div><textarea aria-label={`Edit ${file?.path || "file"}`} spellCheck={false} value={draft} onChange={(event) => setDraft(event.currentTarget.value)} disabled={!file} /><footer><span>{dirty ? "Unsaved change" : "Saved at exact revision"}</span><button type="button" onClick={() => void saveFile()} disabled={!dirty || busy === "save"}>{busy === "save" ? <Loader2 className="animate-spin" size={13} /> : <Save size={13} />} Save file</button></footer></div>}
          <div className={styles.checks}><div><SquareTerminal size={14} /><span>Focused checks</span></div>{commands.map((command) => <button type="button" key={command} onClick={() => void runCommand(command)} disabled={Boolean(busy) || dirty}>{busy === command ? <Loader2 className="animate-spin" size={12} /> : <CheckCircle2 size={12} />} {command}</button>)}</div>
          {commandOutput ? <pre className={styles.output}>{commandOutput}</pre> : null}
        </div>

        <aside className={styles.forgeRail}>
          <div className={styles.forgeIdentity}><span>F</span><div><strong>Forge</strong><small>Code builder · Settings model</small></div><i className={busy === "forge" ? styles.thinking : undefined} /></div>
          <p>Describe a complete change. Forge can inspect this workspace, update SHA-fenced files, run focused checks, and refresh the preview.</p>
          {agentOutput ? <div className={styles.agentOutput}>{agentOutput}</div> : <div className={styles.suggestion}><WandSparkles size={15} /><span>Try “Turn this starter into a personal research dashboard with a responsive mobile view.”</span></div>}
          <form onSubmit={askForge}><label htmlFor={`forge-prompt-${project.id}`}>What should Forge build?</label><textarea id={`forge-prompt-${project.id}`} value={prompt} onChange={(event) => setPrompt(event.currentTarget.value)} rows={5} maxLength={4_000} placeholder="Describe the outcome, audience, and must-have behavior…" /><button type="submit" disabled={!prompt.trim() || Boolean(busy) || dirty}>{busy === "forge" ? <Loader2 className="animate-spin" size={14} /> : <Send size={14} />} {busy === "forge" ? "Forge is working" : dirty ? "Save file before Forge" : "Build with Forge"}</button></form>
          <section className={styles.sentinelCard}>
            <div><span>S</span><div><strong>Sentinel</strong><small>Independent verifier · Settings model</small></div>{latestVerification ? <i data-status={latestVerification.status}>{latestVerification.status}</i> : null}</div>
            <p>Seal this revision, run focused checks, capture private desktop and mobile evidence, then ask Sentinel for a separate verdict.</p>
            {latestVerification ? <div className={styles.evidenceStrip}><span>{latestVerification.checks.filter((check) => check.status === "passed").length}/2 checks</span><span>{latestVerification.browserEvidence.captures.length}/2 views</span><code>{latestVerification.workspaceSha256.slice(0, 9)}</code></div> : null}
            {sentinelOutput ? <div className={styles.sentinelOutput}>{sentinelOutput}</div> : null}
            <button type="button" onClick={() => void verifyWithSentinel()} disabled={Boolean(busy) || dirty}>{busy === "sentinel" ? <Loader2 className="animate-spin" size={13} /> : <ShieldCheck size={13} />} {busy === "sentinel" ? "Verifying this revision" : dirty ? "Save file before review" : "Verify with Sentinel"}</button>
          </section>
          <footer><ShieldCheck size={13} /><span>Mutations use governed tools. Consequential actions still pause for approval.</span></footer>
        </aside>
      </div>
    </section>
  );
}

async function mutate<T = Record<string, unknown>>(projectId: string, body: Record<string, unknown>, idempotencyKey = crypto.randomUUID()) {
  return readJson<T>(`/api/projects/${encodeURIComponent(projectId)}/builder`, { method: "POST", headers: { "content-type": "application/json", "idempotency-key": idempotencyKey }, body: JSON.stringify(body) });
}

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body = await response.json().catch(() => ({})) as Record<string, unknown>;
  if (!response.ok) throw new Error(String(body.error || body.message || `${path} returned ${response.status}`));
  return body as T;
}

async function readSse(stream: ReadableStream<Uint8Array>, onEvent: (event: AgentEvent) => void) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.replaceAll("\r\n", "\n").split("\n\n");
    buffer = blocks.pop() || "";
    blocks.forEach((block) => emitSse(block, onEvent));
  }
  buffer += decoder.decode();
  buffer.replaceAll("\r\n", "\n").split("\n\n").forEach((block) => emitSse(block, onEvent));
}

function emitSse(block: string, onEvent: (event: AgentEvent) => void) {
  const payload = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n").trim();
  if (payload) onEvent(JSON.parse(payload) as AgentEvent);
}

function message(error: unknown) { return error instanceof Error ? error.message : "App Builder operation failed."; }
function formatBytes(size: number) { return size < 1_024 ? `${size} B` : `${(size / 1_024).toFixed(size > 10_240 ? 0 : 1)} KB`; }
function checkpointReason(value: BuilderCheckpoint["reason"]) { return value.replaceAll("_", " "); }
function eventLabel(value: string) { return value.replace("app_builder.", "").replaceAll("_", " ").replaceAll(".", " · "); }
function activityDetail(item: BuilderActivity) {
  const detail = item.detail;
  const text = typeof detail.path === "string" ? detail.path : typeof detail.command === "string" ? `${detail.command} · exit ${String(detail.exitCode ?? "—")}` : "";
  return text ? <span>{text}</span> : null;
}
