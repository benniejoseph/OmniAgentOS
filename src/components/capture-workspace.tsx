"use client";

import {
  AudioLines,
  CheckCircle2,
  CircleAlert,
  Clock3,
  Database,
  Download,
  FileStack,
  FileText,
  HardDrive,
  Library,
  Loader2,
  NotebookPen,
  Paperclip,
  ScanLine,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import { ConnectedSources, type OAuthGrantItem, type OAuthProviderItem } from "@/components/capture/connected-sources";
import { LongRecordingStudio } from "@/components/capture/long-recording-studio";
import { VisualStudio } from "@/components/capture/visual-studio";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { listOfflineCaptures, queueOfflineCapture, removeOfflineCapture, type OfflineCapture } from "@/lib/capture/offline";

type DocumentItem = {
  id: string;
  title: string;
  source: string;
  sourceType: string;
  updatedAt: string;
  chunkCount: number;
  totalCharacters?: number;
};

type KnowledgeStats = { documents: number; chunks: number; characters: number; embedded: number };

type CaptureAsset = {
  id: string;
  filename: string;
  mediaType: string;
  extension: string;
  byteCount: number;
  storageKind: "database" | "filesystem";
  status: "stored" | "queued" | "indexed" | "unsupported" | "failed";
  extractionStatus: "pending" | "completed" | "unsupported" | "failed";
  error?: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
};

type CaptureJob = {
  id: string;
  type?: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: Record<string, unknown>;
  result?: Record<string, unknown>;
  attempt?: number;
  maxAttempts?: number;
  lastError?: string;
  updatedAt?: string;
};

type CaptureMode = "note" | "record" | "upload";
type Notice = { tone: "success" | "warning" | "error"; text: string };

export function CaptureWorkspace() {
  const { session, status } = useWorkspaceSession();
  const [mode, setMode] = useState<CaptureMode>("note");
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [captureNotice, setCaptureNotice] = useState<Notice>();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [assets, setAssets] = useState<CaptureAsset[]>([]);
  const [knowledgeStats, setKnowledgeStats] = useState<KnowledgeStats>();
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderItem[]>([]);
  const [oauthGrants, setOAuthGrants] = useState<OAuthGrantItem[]>([]);
  const [loadingWorkspace, setLoadingWorkspace] = useState(false);
  const [loadError, setLoadError] = useState<string>();
  const [offlinePending, setOfflinePending] = useState(0);
  const [activeJob, setActiveJob] = useState<CaptureJob>();
  const [geminiConfigured, setGeminiConfigured] = useState<boolean>();
  const [geminiImageModel, setGeminiImageModel] = useState<string>();
  const [libraryQuery, setLibraryQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [deletingAsset, setDeletingAsset] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const completedJobRef = useRef<string | undefined>(undefined);
  const captureBlocked = permissionMessage(session, status, "write.memory");
  const visualBlocked = permissionMessage(session, status, "run.agent");

  const loadWorkspace = useCallback(async () => {
    if (status !== "ready" || !session) return;
    setLoadingWorkspace(true);
    setLoadError(undefined);
    const results = await Promise.allSettled([
      fetch("/api/knowledge?limit=30", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Knowledge library could not be loaded.");
        const payload = await response.json() as { documents?: DocumentItem[]; stats?: KnowledgeStats };
        setDocuments(Array.isArray(payload.documents) ? payload.documents : []);
        setKnowledgeStats(payload.stats);
      }),
      fetch("/api/capture?limit=30", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Original files could not be loaded.");
        const payload = await response.json() as { assets?: CaptureAsset[] };
        setAssets(Array.isArray(payload.assets) ? payload.assets : []);
      }),
      fetch("/api/oauth", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Connected sources could not be loaded.");
        const payload = await response.json() as { providers?: OAuthProviderItem[]; grants?: OAuthGrantItem[] };
        setOAuthProviders(Array.isArray(payload.providers) ? payload.providers : []);
        setOAuthGrants(Array.isArray(payload.grants) ? payload.grants : []);
      }),
      fetch("/api/capabilities?view=settings", { cache: "no-store" }).then(async (response) => {
        if (!response.ok) throw new Error("Media capabilities could not be loaded.");
        const payload = await response.json() as { geminiConfigured?: boolean; googleModels?: { image?: string } };
        setGeminiConfigured(Boolean(payload.geminiConfigured));
        setGeminiImageModel(payload.googleModels?.image);
      }),
    ]);
    if (results.every((result) => result.status === "rejected")) {
      setLoadError("Capture data is temporarily unavailable. Your unsaved draft has not been changed.");
    }
    setLoadingWorkspace(false);
  }, [session, status]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadWorkspace(), 0);
    return () => window.clearTimeout(timer);
  }, [loadWorkspace]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const sharedTitle = params.get("title")?.trim();
      const sharedText = [params.get("text"), params.get("url")].filter(Boolean).join("\n\n").trim();
      if (sharedTitle) setTitle((current) => current || sharedTitle);
      if (sharedText) setContent((current) => current || sharedText);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let active = true;
    const refreshCount = async () => {
      const captures = await listOfflineCaptures().catch(() => []);
      if (active) setOfflinePending(captures.length);
    };
    const flush = () => { void flushOfflineCaptures().then(refreshCount); };
    void refreshCount();
    window.addEventListener("online", flush);
    if (navigator.onLine) flush();
    return () => { active = false; window.removeEventListener("online", flush); };
  }, []);

  useEffect(() => {
    if (!activeJob || !["queued", "running"].includes(activeJob.status)) return;
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/operations/jobs/${encodeURIComponent(activeJob.id)}`, { cache: "no-store" });
        const payload = (await response.json().catch(() => ({}))) as { job?: CaptureJob };
        if (response.ok && payload.job) setActiveJob(payload.job);
      } catch {
        // The queued work remains durable; a later poll can recover.
      }
    }, 2_000);
    return () => window.clearTimeout(timer);
  }, [activeJob]);

  useEffect(() => {
    if (!activeJob || !["completed", "failed", "canceled"].includes(activeJob.status) || completedJobRef.current === activeJob.id) return;
    completedJobRef.current = activeJob.id;
    if (activeJob.status === "completed") {
      setCaptureNotice({ tone: "success", text: "Capture indexed. It is now available as context in Command conversations." });
    } else {
      setCaptureNotice({ tone: "error", text: activeJob.lastError || "Indexing did not complete. The original file is still stored in your Capture library." });
    }
    void loadWorkspace();
  }, [activeJob, loadWorkspace]);

  const filteredDocuments = useMemo(() => documents.filter((document) => {
    const query = libraryQuery.trim().toLowerCase();
    if (query && !`${document.title} ${document.source}`.toLowerCase().includes(query)) return false;
    return sourceFilter === "all" || documentSource(document.source) === sourceFilter;
  }), [documents, libraryQuery, sourceFilter]);

  function chooseFile(next?: File) {
    setCaptureNotice(undefined);
    setFile(next);
    if (next) {
      setMode("upload");
      if (!title) setTitle(next.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
    }
  }

  async function submitCapture(event: React.FormEvent) {
    event.preventDefault();
    if (captureBlocked) return setCaptureNotice({ tone: "error", text: captureBlocked });
    if (!file && !content.trim()) return setCaptureNotice({ tone: "error", text: "Write a note or choose a file to preserve." });
    setSubmitting(true);
    setCaptureNotice(undefined);
    if (!navigator.onLine) {
      await queueCurrentCapture();
      setSubmitting(false);
      return;
    }
    const form = captureForm({ title: title.trim(), content: content.trim(), tags: tags.trim(), file });
    try {
      const response = await fetch("/api/capture", { method: "POST", body: form, headers: { "idempotency-key": crypto.randomUUID() } });
      const payload = (await response.json().catch(() => ({}))) as {
        job?: CaptureJob;
        asset?: CaptureAsset;
        capture?: { title?: string };
        ingestion?: { status?: string; reason?: string };
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "Capture failed.");
      resetCaptureDraft();
      if (payload.job) {
        completedJobRef.current = undefined;
        setActiveJob(payload.job);
        setCaptureNotice({ tone: "success", text: `“${payload.capture?.title || payload.asset?.filename || "Capture"}” is stored and queued for indexing.` });
      } else if (payload.asset) {
        setCaptureNotice({ tone: "warning", text: `Original file stored, but it was not indexed${payload.ingestion?.reason ? `: ${payload.ingestion.reason}` : "."}` });
      }
      await loadWorkspace();
    } catch (submitError) {
      if (!navigator.onLine || submitError instanceof TypeError) await queueCurrentCapture();
      else setCaptureNotice({ tone: "error", text: submitError instanceof Error ? submitError.message : "Capture failed." });
    } finally {
      setSubmitting(false);
    }
  }

  async function queueCurrentCapture() {
    await queueOfflineCapture({ title: title.trim(), content: content.trim(), tags: tags.trim(), file });
    resetCaptureDraft();
    const pending = await listOfflineCaptures();
    setOfflinePending(pending.length);
    setCaptureNotice({ tone: "success", text: "Saved privately on this device. Asael will store and index it when you are back online." });
  }

  function resetCaptureDraft() {
    setTitle("");
    setContent("");
    setTags("");
    setFile(undefined);
    if (inputRef.current) inputRef.current.value = "";
  }

  async function deleteAsset(id: string) {
    setDeletingAsset(id);
    try {
      const response = await fetch(`/api/capture/assets/${encodeURIComponent(id)}`, { method: "DELETE" });
      const payload = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) throw new Error(payload.error || "The file could not be deleted.");
      setCaptureNotice({ tone: "success", text: "Original file, indexed knowledge, and linked memory were removed." });
      await loadWorkspace();
    } catch (deleteError) {
      setCaptureNotice({ tone: "error", text: deleteError instanceof Error ? deleteError.message : "The file could not be deleted." });
    } finally {
      setDeletingAsset(undefined);
    }
  }

  const googleGrant = oauthGrants.find((grant) => grant.provider === "google" && grant.status !== "revoked");
  const activeSourceCount = googleGrant
    ? 3 + (googleGrant.scopes.some((scope) => scope.endsWith("/auth/photospicker.mediaitems.readonly")) ? 1 : 0)
    : 0;

  return (
    <div className="mx-auto w-full max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8 lg:py-8 2xl:px-10">
      <header className="flex flex-col gap-5 border-b border-line pb-6 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Capture</p>
          <h1 className="mt-2 text-3xl font-semibold tracking-tight">Turn anything worth keeping into usable context.</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Record conversations, preserve original files, connect Google, and index everything with provenance. Saved knowledge becomes selectable context in Command.</p>
        </div>
        <div className="grid grid-cols-3 divide-x divide-line rounded-lg border border-line bg-surface">
          <Metric value={knowledgeStats?.documents} label="Documents" />
          <Metric value={knowledgeStats?.chunks} label="RAG chunks" />
          <Metric value={activeSourceCount} label="Sources active" />
        </div>
      </header>

      {loadError ? <p role="alert" className="mt-4 border-l-2 border-danger bg-danger/5 px-3 py-2 text-sm text-danger">{loadError}</p> : null}
      {offlinePending ? <p className="mt-4 inline-flex items-center gap-2 rounded-full bg-warning/10 px-3 py-1.5 text-xs font-semibold text-warning"><HardDrive size={13} aria-hidden="true" />{offlinePending} offline capture{offlinePending === 1 ? "" : "s"} waiting to sync</p> : null}

      <section className="grid gap-6 py-7 xl:grid-cols-[minmax(0,1.45fr)_minmax(20rem,.55fr)]" aria-labelledby="capture-composer-title">
        <form onSubmit={mode === "record" ? (event) => event.preventDefault() : submitCapture} className="min-w-0">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
            <div><h2 id="capture-composer-title" className="text-xl font-semibold tracking-tight">Capture something</h2><p className="mt-1 text-sm text-muted">Choose the shape of what you are saving. One clear workspace expands for each mode.</p></div>
            <div className="inline-flex w-fit rounded-lg border border-line bg-surface p-1" role="tablist" aria-label="Capture type">
              <ModeButton active={mode === "note"} onClick={() => { setFile(undefined); setMode("note"); }} icon={NotebookPen} label="Note" />
              <ModeButton active={mode === "record"} onClick={() => setMode("record")} icon={AudioLines} label="Record" />
              <ModeButton active={mode === "upload"} onClick={() => setMode("upload")} icon={Upload} label="Upload" />
            </div>
          </div>

          {mode === "record" ? (
            <LongRecordingStudio disabledReason={captureBlocked} onJob={(job) => { completedJobRef.current = undefined; setActiveJob(job); }} onIndexed={loadWorkspace} />
          ) : (
            <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
              {mode === "note" ? (
                <div className="p-5 sm:p-6">
                  <label htmlFor="capture-content" className="text-xs font-semibold text-muted">Note</label>
                  <textarea id="capture-content" value={content} onChange={(event) => setContent(event.target.value)} disabled={submitting} rows={10} placeholder="Write a thought, paste meeting notes, record a decision, or describe something you want Asael to remember…" className="mt-3 w-full resize-y bg-transparent text-lg leading-8 text-foreground outline-none placeholder:text-muted/60 disabled:opacity-60" />
                  <button type="button" onClick={() => inputRef.current?.click()} className="mt-3 action-button"><Paperclip size={15} aria-hidden="true" />Attach a file instead</button>
                </div>
              ) : (
                <div className="p-5 sm:p-6">
                  <div onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }} onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }} className={clsx("flex min-h-52 flex-col items-center justify-center rounded-lg border border-dashed px-5 py-8 text-center transition-colors", dragging ? "border-primary bg-primary/5" : "border-line bg-background")}>
                    {file ? (
                      <><span className="grid size-12 place-items-center rounded-lg bg-primary/10 text-primary"><FileText size={23} aria-hidden="true" /></span><p className="mt-3 max-w-full truncate font-semibold">{file.name}</p><p className="mt-1 text-xs text-muted">{formatBytes(file.size)} · ready to store</p><button type="button" onClick={() => chooseFile(undefined)} className="mt-3 action-button"><X size={15} aria-hidden="true" />Remove</button></>
                    ) : (
                      <><span className="grid size-12 place-items-center rounded-lg bg-surface-raised text-primary"><Upload size={23} aria-hidden="true" /></span><p className="mt-3 font-semibold">Drop any file here</p><p className="mt-1 max-w-lg text-sm leading-6 text-muted">Every original up to 5 MB is preserved. Documents, email, calendar files, images, office formats and common code or text files are indexed; unsupported formats stay available in your library.</p><div className="mt-4 flex flex-wrap justify-center gap-2"><button type="button" onClick={() => inputRef.current?.click()} className="primary-button"><Paperclip size={15} aria-hidden="true" />Choose file</button><button type="button" onClick={() => cameraInputRef.current?.click()} className="action-button"><ScanLine size={15} aria-hidden="true" />Scan with camera</button></div></>
                    )}
                  </div>
                  <label className="mt-4 block text-xs font-semibold text-muted">Capture note <span className="font-normal">(optional)</span><textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={20_000} rows={3} placeholder="Why this matters, what to remember, or how Asael should use it…" className="mt-2 w-full resize-y rounded-lg border border-line bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none focus:border-primary" /></label>
                </div>
              )}

              <div className="grid gap-3 border-t border-line bg-background px-5 py-4 sm:grid-cols-2 sm:px-6">
                <label className="text-xs font-semibold text-muted">Title<input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} placeholder="Optional — created automatically when blank" className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-3 text-sm text-foreground outline-none focus:border-primary" /></label>
                <label className="text-xs font-semibold text-muted">Tags<input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="project, meeting, decision" className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-3 text-sm text-foreground outline-none focus:border-primary" /></label>
              </div>
              <div className="flex flex-col gap-3 border-t border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
                <p className="text-xs leading-5 text-muted">Stored privately · redacted before indexing · selectable in Command context</p>
                <button type="submit" disabled={submitting || Boolean(captureBlocked)} title={captureBlocked} className="primary-button min-w-40">{submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}{submitting ? "Storing…" : "Store and index"}</button>
              </div>
            </div>
          )}

          <input ref={inputRef} data-testid="capture-file-input" type="file" className="sr-only" aria-label="Choose a file to capture" onChange={(event) => chooseFile(event.target.files?.[0])} />
          <input ref={cameraInputRef} type="file" className="sr-only" aria-label="Scan an image with the camera" accept="image/*" capture="environment" onChange={(event) => chooseFile(event.target.files?.[0])} />
          {captureNotice ? <p role={captureNotice.tone === "error" ? "alert" : "status"} className={clsx("mt-3 text-sm leading-6", captureNotice.tone === "error" ? "text-danger" : captureNotice.tone === "warning" ? "text-warning" : "text-success")}>{captureNotice.text}</p> : null}
        </form>

        <aside className="border-t border-line pt-5 xl:border-l xl:border-t-0 xl:pl-6 xl:pt-0" aria-label="Capture processing status">
          <div className="flex items-center justify-between gap-3"><div><p className="text-sm font-semibold">Processing</p><p className="mt-1 text-xs text-muted">What happens after you save</p></div>{loadingWorkspace ? <Loader2 size={16} className="animate-spin text-muted" aria-label="Refreshing capture data" /> : null}</div>
          <ol className="mt-4 space-y-4">
            <FlowStep number="1" title="Preserve original" detail="The source file or segmented audio is stored first." active={!activeJob || activeJob.status === "queued"} />
            <FlowStep number="2" title="Extract and understand" detail="Text, OCR, metadata and transcription are normalized." active={activeJob?.status === "running"} />
            <FlowStep number="3" title="Index and link" detail="RAG chunks, provenance, memory and graph links are created." active={activeJob?.status === "completed"} />
          </ol>
          {activeJob ? (
            <div className={clsx("mt-5 border-l-2 px-4 py-3", activeJob.status === "failed" ? "border-danger bg-danger/5" : activeJob.status === "completed" ? "border-success bg-success/5" : "border-primary bg-primary/5")}><p className="flex items-center gap-2 text-sm font-semibold">{activeJob.status === "failed" ? <CircleAlert size={15} /> : activeJob.status === "completed" ? <CheckCircle2 size={15} /> : <Loader2 size={15} className="animate-spin" />}{jobLabel(activeJob.status)}</p><p className="mt-1 text-xs leading-5 text-muted">{activeJob.lastError || jobDetail(activeJob)}</p>{activeJob.status === "running" ? <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-line"><div className="h-full w-2/3 animate-pulse rounded-full bg-primary" /></div> : null}</div>
          ) : <p className="mt-5 border-l-2 border-line pl-4 text-sm leading-6 text-muted">No active capture. Your latest job will appear here with honest queued, running, ready, or failed status.</p>}
          <div className="mt-6 grid grid-cols-2 gap-x-4 gap-y-3 border-t border-line pt-5 text-xs">
            <StatusFact icon={Database} label={`${knowledgeStats?.embedded || 0} embedded chunks`} />
            <StatusFact icon={FileStack} label={`${assets.length} originals retained`} />
            <StatusFact icon={Library} label="Command context ready" />
            <StatusFact icon={Clock3} label="Background indexing" />
          </div>
        </aside>
      </section>

      <ConnectedSources providers={oauthProviders} grants={oauthGrants} loading={loadingWorkspace} onRefresh={loadWorkspace} onJob={(job) => { completedJobRef.current = undefined; setActiveJob(job); }} />

      <VisualStudio configured={geminiConfigured} model={geminiImageModel} disabledReason={visualBlocked} onJob={(job) => { completedJobRef.current = undefined; setActiveJob(job); }} onAssetsChanged={loadWorkspace} />

      <section className="border-t border-line pt-7" aria-labelledby="capture-library-title">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Capture library</p><h2 id="capture-library-title" className="mt-2 text-xl font-semibold tracking-tight">Originals and searchable knowledge.</h2><p className="mt-2 text-sm leading-6 text-muted">Open or download preserved files. Indexed documents are available to the context selector in Command conversations.</p></div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <label className="relative min-w-56"><span className="sr-only">Search captured knowledge</span><Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden="true" /><input value={libraryQuery} onChange={(event) => setLibraryQuery(event.target.value)} placeholder="Search this list" className="min-h-11 w-full rounded-md border border-line bg-surface pl-9 pr-3 text-sm outline-none focus:border-primary" /></label>
            <label><span className="sr-only">Filter by source</span><select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} className="min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-foreground"><option value="all">All sources</option><option value="capture">Capture</option><option value="mail">Email</option><option value="drive">Drive</option><option value="calendar">Calendar</option><option value="photos">Photos</option></select></label>
          </div>
        </div>

        <div className="mt-5 grid gap-6 2xl:grid-cols-[minmax(22rem,.72fr)_minmax(0,1.28fr)]">
          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-raised px-4 py-3"><div><p className="text-sm font-semibold">Original files</p><p className="mt-0.5 text-xs text-muted">Private, retrievable, and deletable</p></div><span className="text-xs text-muted">{assets.length}</span></div>
            <div className="max-h-[32rem] divide-y divide-line overflow-y-auto">
              {assets.length ? assets.map((asset) => (
                <div key={asset.id} className="group px-4 py-3"><div className="flex items-start gap-3"><span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-background text-primary"><FileText size={16} aria-hidden="true" /></span><div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{asset.filename}</p><p className="mt-1 truncate text-xs text-muted">{formatBytes(asset.byteCount)} · {asset.storageKind} · {formatTime(asset.updatedAt)}</p><p className={clsx("mt-1 text-xs font-semibold", asset.status === "failed" || asset.status === "unsupported" ? "text-warning" : asset.status === "indexed" ? "text-success" : "text-muted")}>{assetStatusLabel(asset)}</p>{asset.error ? <p className="mt-1 line-clamp-2 text-xs text-danger">{asset.error}</p> : null}</div><div className="flex shrink-0 gap-1"><a href={`/api/capture/assets/${encodeURIComponent(asset.id)}?content=1&download=1`} className="grid size-9 place-items-center rounded-md text-muted hover:bg-background hover:text-foreground" aria-label={`Download ${asset.filename}`}><Download size={14} /></a><button type="button" onClick={() => void deleteAsset(asset.id)} disabled={deletingAsset === asset.id} className="grid size-9 place-items-center rounded-md text-muted hover:bg-danger/10 hover:text-danger" aria-label={`Delete ${asset.filename}`}>{deletingAsset === asset.id ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}</button></div></div></div>
              )) : <p className="px-4 py-8 text-center text-sm text-muted">Uploaded and generated originals will appear here.</p>}
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-line bg-surface">
            <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-line bg-surface-raised px-4 py-3 text-xs font-semibold text-muted sm:grid-cols-[minmax(0,1.2fr)_minmax(10rem,.8fr)_auto]"><span>Knowledge</span><span className="hidden sm:block">Source</span><span>Index</span></div>
            <div className="max-h-[32rem] divide-y divide-line overflow-y-auto">
              {filteredDocuments.length ? filteredDocuments.map((document) => (
                <div key={document.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1.2fr)_minmax(10rem,.8fr)_auto] sm:items-center"><div className="min-w-0"><p className="truncate text-sm font-medium">{document.title}</p><p className="mt-1 text-xs text-muted">Updated {formatTime(document.updatedAt)}</p></div><div className="hidden min-w-0 sm:block"><p className="truncate text-xs text-muted">{sourceLabel(document.source)}</p><p className="mt-1 text-xs text-muted">{documentSource(document.source)}</p></div><p className="whitespace-nowrap text-xs font-semibold text-success">{document.chunkCount} chunks</p></div>
              )) : <p className="px-4 py-8 text-center text-sm text-muted">{documents.length ? "No documents match this filter." : "Captured knowledge will appear here after indexing."}</p>}
            </div>
          </div>
        </div>
      </section>

      <div className="h-10" aria-hidden="true" />
    </div>
  );
}

function Metric({ value, label }: { value?: number; label: string }) {
  return <div className="min-w-24 px-3 py-2.5 text-center"><p className="text-lg font-semibold tabular-nums">{value ?? "—"}</p><p className="text-[11px] font-medium text-muted">{label}</p></div>;
}

function ModeButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof NotebookPen; label: string }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={clsx("inline-flex min-h-10 items-center gap-2 rounded-md px-3 text-sm font-semibold transition", active ? "bg-background text-foreground shadow-sm" : "text-muted hover:text-foreground")}><Icon size={15} aria-hidden="true" />{label}</button>;
}

function FlowStep({ number, title, detail, active }: { number: string; title: string; detail: string; active?: boolean }) {
  return <li className="flex gap-3"><span className={clsx("grid size-7 shrink-0 place-items-center rounded-full border text-xs font-semibold", active ? "border-primary bg-primary text-primary-ink" : "border-line bg-surface text-muted")}>{number}</span><div><p className="text-sm font-semibold">{title}</p><p className="mt-0.5 text-xs leading-5 text-muted">{detail}</p></div></li>;
}

function StatusFact({ icon: Icon, label }: { icon: typeof Database; label: string }) {
  return <span className="flex items-center gap-2 text-muted"><Icon size={14} className="shrink-0 text-primary" aria-hidden="true" />{label}</span>;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "recently" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(date);
}

function jobLabel(status: CaptureJob["status"]) {
  if (status === "completed") return "Ready for Command";
  if (status === "failed") return "Indexing needs attention";
  if (status === "canceled") return "Indexing canceled";
  if (status === "running") return "Extracting and indexing";
  return "Waiting for indexer";
}

function jobDetail(job: CaptureJob) {
  if (job.status === "completed") return "RAG chunks and linked memories are ready.";
  if (job.status === "running") return `Background worker is processing this capture${job.attempt ? ` · attempt ${job.attempt}` : ""}.`;
  if (job.status === "queued") return "The original is safe. Processing will begin in the background.";
  return "The original remains safely stored.";
}

function assetStatusLabel(asset: CaptureAsset) {
  if (asset.status === "indexed") return "Indexed and searchable";
  if (asset.status === "queued") return "Stored · indexing queued";
  if (asset.status === "unsupported") return "Stored · not indexed";
  if (asset.status === "failed") return "Stored · processing failed";
  return asset.extractionStatus === "pending" ? "Stored · waiting for extraction" : "Stored privately";
}

function documentSource(source: string) {
  if (source.startsWith("google:mail:")) return "mail";
  if (source.startsWith("google:drive:")) return "drive";
  if (source.startsWith("google:calendar:")) return "calendar";
  if (source.startsWith("google:photos:")) return "photos";
  return "capture";
}

function sourceLabel(source: string) {
  const category = documentSource(source);
  if (category === "mail") return "Google Email";
  if (category === "drive") return "Google Drive";
  if (category === "calendar") return "Google Calendar";
  if (category === "photos") return "Google Photos";
  if (source.startsWith("capture:recording:")) return "Recorded conversation";
  if (source.startsWith("capture:asset:")) return "Captured file";
  return source.replace(/^\w+:\/\//, "").slice(0, 100) || "Manual capture";
}

function captureForm(capture: Pick<OfflineCapture, "title" | "content" | "tags" | "file">) {
  const form = new FormData();
  form.set("title", capture.title);
  form.set("content", capture.content);
  form.set("tags", capture.tags);
  if (capture.file) form.set("file", capture.file);
  return form;
}

async function flushOfflineCaptures() {
  if (!navigator.onLine) return;
  const captures = await listOfflineCaptures();
  for (const capture of captures) {
    try {
      const response = await fetch("/api/capture", { method: "POST", body: captureForm(capture), headers: { "idempotency-key": capture.id } });
      if (!response.ok) break;
      await removeOfflineCapture(capture.id);
    } catch {
      break;
    }
  }
}
