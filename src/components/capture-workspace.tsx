"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, CheckCircle2, Download, FileText, ImageIcon, Loader2, Mic, Paperclip, RefreshCw, Sparkles, Square, Upload, X } from "lucide-react";
import { clsx } from "clsx";
import { permissionMessage, useWorkspaceSession } from "@/components/app-shell/session-context";
import { listOfflineCaptures, queueOfflineCapture, removeOfflineCapture, type OfflineCapture } from "@/lib/capture/offline";

type DocumentItem = { id: string; title: string; source: string; sourceType: string; updatedAt: string; chunkCount: number };
type OAuthProviderItem = { id: string; label: string; configured: boolean; authorizeUrl: string; scopes: string[] };
type OAuthGrantItem = { id: string; provider: string; scopes: string[]; updatedAt: string; syncStatus?: "idle" | "syncing" | "healthy" | "error"; syncError?: string; lastSyncedAt?: string; syncedItems?: number };

export function CaptureWorkspace() {
  const { session, status } = useWorkspaceSession();
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState("");
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const [documents, setDocuments] = useState<DocumentItem[]>([]);
  const [oauthProviders, setOAuthProviders] = useState<OAuthProviderItem[]>([]);
  const [oauthGrants, setOAuthGrants] = useState<OAuthGrantItem[]>([]);
  const [syncingProvider, setSyncingProvider] = useState<string>();
  const [offlinePending, setOfflinePending] = useState(0);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imageRatio, setImageRatio] = useState<"1:1" | "16:9" | "9:16" | "4:3" | "3:4">("1:1");
  const [generatingImage, setGeneratingImage] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<{ dataUrl: string; model: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const audioChunksRef = useRef<Blob[]>([]);
  const blocked = permissionMessage(session, status, "write.memory");

  const loadRecent = useCallback(async () => {
    if (status !== "ready" || !session) return;
    const [knowledgeResponse, oauthResponse] = await Promise.all([
      fetch("/api/knowledge?limit=8", { cache: "no-store" }),
      fetch("/api/oauth", { cache: "no-store" }),
    ]);
    if (knowledgeResponse.ok) { const body = await knowledgeResponse.json(); setDocuments(Array.isArray(body.documents) ? body.documents : []); }
    if (oauthResponse.ok) { const body = await oauthResponse.json(); setOAuthProviders(Array.isArray(body.providers) ? body.providers : []); setOAuthGrants(Array.isArray(body.grants) ? body.grants : []); }
  }, [session, status]);

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
    const timer = window.setTimeout(() => void loadRecent(), 0);
    return () => window.clearTimeout(timer);
  }, [loadRecent]);

  useEffect(() => {
    let active = true;
    const refreshCount = async () => { const captures = await listOfflineCaptures().catch(() => []); if (active) setOfflinePending(captures.length); };
    const flush = () => { void flushOfflineCaptures().then(refreshCount); };
    void refreshCount();
    window.addEventListener("online", flush);
    if (navigator.onLine) flush();
    return () => { active = false; window.removeEventListener("online", flush); };
  }, []);

  function chooseFile(next?: File) {
    setMessage(undefined);
    setFile(next);
    if (next && !title) setTitle(next.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "));
  }

  async function toggleRecording() {
    if (recording) return recorderRef.current?.stop();
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      return setMessage({ tone: "error", text: "Audio recording is not supported by this browser." });
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) audioChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        setRecording(false);
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        void transcribeAudio(blob);
      };
      recorderRef.current = recorder;
      recorder.start();
      setRecording(true);
      setMessage(undefined);
    } catch {
      setMessage({ tone: "error", text: "Microphone access was not granted." });
    }
  }

  async function transcribeAudio(blob: Blob) {
    setTranscribing(true);
    setMessage(undefined);
    const form = new FormData();
    const extension = blob.type.includes("mp4") ? "m4a" : blob.type.includes("ogg") ? "ogg" : "webm";
    form.set("audio", new File([blob], `voice-note.${extension}`, { type: blob.type || "audio/webm" }));
    try {
      const response = await fetch("/api/capture/transcribe", { method: "POST", body: form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || "Transcription failed."));
      setContent((current) => current ? `${current}\n\n${body.text}` : String(body.text));
      setMessage({ tone: "success", text: "Voice note transcribed. Review it, then save when ready." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Transcription failed." });
    } finally {
      setTranscribing(false);
    }
  }

  async function syncProvider(provider: string) {
    setSyncingProvider(provider); setMessage(undefined);
    try {
      const response = await fetch(`/api/oauth/${encodeURIComponent(provider)}/sync`, { method: "POST" });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Connected source sync failed.");
      setMessage({ tone: "success", text: `Google synced ${Number(payload.imported || 0)} new or changed items${payload.removed ? ` and removed ${payload.removed}` : ""}.` });
      await loadRecent();
    } catch (syncError) {
      setMessage({ tone: "error", text: syncError instanceof Error ? syncError.message : "Connected source sync failed." });
      await loadRecent();
    } finally { setSyncingProvider(undefined); }
  }

  async function createImage() {
    if (!imagePrompt.trim()) return;
    setGeneratingImage(true); setMessage(undefined);
    try {
      const response = await fetch("/api/media/image", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: imagePrompt.trim(), aspectRatio: imageRatio }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(payload.error || "Image generation failed."));
      setGeneratedImage({ dataUrl: String(payload.image), model: String(payload.model || "Gemini") });
      setMessage({ tone: "success", text: "Visual created. Download it or move it into the capture inbox." });
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "Image generation failed." });
    } finally { setGeneratingImage(false); }
  }

  async function attachGeneratedImage() {
    if (!generatedImage) return;
    const blob = await fetch(generatedImage.dataUrl).then((response) => response.blob());
    chooseFile(new File([blob], `asael-${Date.now()}.jpg`, { type: blob.type || "image/jpeg" }));
    if (!title.trim()) setTitle(imagePrompt.trim().slice(0, 120));
    setGeneratedImage(undefined);
    setMessage({ tone: "success", text: "Generated visual moved into the capture inbox. Add tags, then save it to memory." });
  }

  async function submitCapture(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return setMessage({ tone: "error", text: blocked });
    if (!file && !content.trim()) return setMessage({ tone: "error", text: "Write a note or attach a supported text file." });
    setSubmitting(true);
    setMessage(undefined);
    if (!navigator.onLine) {
      await queueCurrentCapture();
      setSubmitting(false);
      return;
    }
    const form = captureForm({ title: title.trim(), content: content.trim(), tags: tags.trim(), file });
    try {
      const response = await fetch("/api/capture", {
        method: "POST", body: form,
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(String(body.error || "Capture failed."));
      setTitle(""); setContent(""); setTags(""); setFile(undefined);
      if (inputRef.current) inputRef.current.value = "";
      setMessage({ tone: "success", text: `“${body.capture?.title || "Capture"}” is queued for indexing.` });
      window.setTimeout(() => void loadRecent(), 1800);
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) await queueCurrentCapture();
      else setMessage({ tone: "error", text: error instanceof Error ? error.message : "Capture failed." });
    } finally {
      setSubmitting(false);
    }
  }

  async function queueCurrentCapture() {
    await queueOfflineCapture({ title: title.trim(), content: content.trim(), tags: tags.trim(), file });
    setTitle(""); setContent(""); setTags(""); setFile(undefined);
    if (inputRef.current) inputRef.current.value = "";
    const pending = await listOfflineCaptures(); setOfflinePending(pending.length);
    setMessage({ tone: "success", text: "Saved privately on this device. Asael will index it when you are back online." });
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:py-10">
      <header className="border-b border-line pb-6">
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Capture inbox</p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">Save it before it disappears.</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">Notes and text files become searchable knowledge with source provenance.</p>
        {offlinePending ? <p className="mt-3 inline-flex items-center rounded-full bg-warning/10 px-2.5 py-1 text-xs font-semibold text-warning">{offlinePending} offline capture{offlinePending === 1 ? "" : "s"} waiting to sync</p> : null}
      </header>

      <form onSubmit={submitCapture} className="py-7">
        <div className="mb-4 flex items-center gap-3">
          <button type="button" onClick={() => void toggleRecording()} disabled={transcribing || Boolean(file)} className={clsx("action-button", recording && "border-danger/60 text-danger")}>
            {transcribing ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : recording ? <Square size={14} aria-hidden="true" /> : <Mic size={15} aria-hidden="true" />}
            {transcribing ? "Transcribing…" : recording ? "Stop recording" : "Record voice note"}
          </button>
          <p className="text-xs text-muted">Transcription is editable and is not saved until you choose Save to memory.</p>
        </div>
        <label htmlFor="capture-content" className="sr-only">Note content</label>
        <textarea
          id="capture-content" value={content} onChange={(event) => setContent(event.target.value)}
          disabled={Boolean(file) || submitting} rows={7}
          placeholder={file ? "Remove the attachment to write a note instead." : "Write a thought, paste meeting notes, or record a decision…"}
          className="w-full resize-y bg-transparent text-lg leading-8 outline-none placeholder:text-muted/65 disabled:cursor-not-allowed disabled:opacity-50"
        />

        <div
          onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => { if (event.currentTarget === event.target) setDragging(false); }}
          onDrop={(event) => { event.preventDefault(); setDragging(false); chooseFile(event.dataTransfer.files[0]); }}
          className={clsx("mt-4 flex min-h-20 items-center justify-between gap-3 rounded-lg border border-dashed px-4 transition-colors", dragging ? "border-primary bg-primary/5" : "border-line bg-surface")}
        >
          {file ? (
            <div className="flex min-w-0 items-center gap-3"><FileText size={18} className="shrink-0 text-primary" aria-hidden="true" /><div className="min-w-0"><p className="truncate text-sm font-medium">{file.name}</p><p className="text-xs text-muted">{formatBytes(file.size)} · ready to upload</p></div></div>
          ) : (
            <div className="flex items-center gap-3"><Upload size={18} className="text-muted" aria-hidden="true" /><div><p className="text-sm font-medium">Drop a document, email, event, or image</p><p className="text-xs text-muted">PDF, DOCX, EML, ICS, PNG, JPG, WebP, or text · 5 MB max</p></div></div>
          )}
          <div className="flex shrink-0 items-center gap-2">
            {file ? <button type="button" onClick={() => chooseFile(undefined)} className="grid size-11 place-items-center rounded-md hover:bg-surface-raised" aria-label="Remove attachment"><X size={17} /></button> : null}
            <button type="button" onClick={() => inputRef.current?.click()} className="action-button"><Paperclip size={15} aria-hidden="true" />Choose file</button>
            <button type="button" onClick={() => cameraInputRef.current?.click()} className="action-button"><Camera size={15} aria-hidden="true" />Scan</button>
            <input ref={inputRef} data-testid="capture-file-input" type="file" className="sr-only" accept=".pdf,.docx,.eml,.ics,.png,.jpg,.jpeg,.webp,.txt,.md,.markdown,.csv,.json,.html,.htm,.yaml,.yml" onChange={(event) => chooseFile(event.target.files?.[0])} />
            <input ref={cameraInputRef} type="file" className="sr-only" accept="image/*" capture="environment" onChange={(event) => chooseFile(event.target.files?.[0])} />
          </div>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-muted">Title <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} placeholder="Optional — generated when blank" className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-3 text-sm text-foreground outline-none focus:border-primary" /></label>
          <label className="text-xs font-medium text-muted">Tags <input value={tags} onChange={(event) => setTags(event.target.value)} placeholder="project, meeting, decision" className="mt-2 w-full rounded-md border border-line bg-surface px-3 py-3 text-sm text-foreground outline-none focus:border-primary" /></label>
        </div>

        <div className="mt-5 flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <div aria-live="polite" className={clsx("min-h-5 text-sm", message?.tone === "success" ? "text-success" : "text-danger")}>{message?.text}</div>
          <button type="submit" disabled={submitting || Boolean(blocked)} title={blocked} className="primary-button min-w-36">{submitting ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <CheckCircle2 size={16} aria-hidden="true" />}{submitting ? "Saving…" : "Save to memory"}</button>
        </div>
      </form>

      <section className="border-t border-line py-7" aria-labelledby="visual-studio-title">
        <div className="grid gap-6 lg:grid-cols-[0.92fr_1.08fr] lg:items-start">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Gemini visual studio</p>
            <h2 id="visual-studio-title" className="mt-2 text-xl font-semibold tracking-tight">Turn an idea into an image.</h2>
            <p className="mt-2 max-w-xl text-sm leading-6 text-muted">Create a private working visual, then download it or place it directly into your capture inbox.</p>
            <label className="mt-5 block text-xs font-medium text-muted">Describe the visual
              <textarea value={imagePrompt} onChange={(event) => setImagePrompt(event.target.value)} maxLength={4_000} rows={4} placeholder="A calm, cinematic dashboard illustration showing a network of personal AI agents…" className="mt-2 w-full resize-y rounded-lg border border-line bg-surface px-3 py-3 text-sm leading-6 text-foreground outline-none focus:border-primary" />
            </label>
            <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
              <label className="text-xs font-medium text-muted">Aspect ratio
                <select value={imageRatio} onChange={(event) => setImageRatio(event.target.value as typeof imageRatio)} className="mt-2 block min-h-11 rounded-md border border-line bg-surface px-3 text-sm text-foreground">
                  <option value="1:1">Square · 1:1</option><option value="16:9">Landscape · 16:9</option><option value="9:16">Portrait · 9:16</option><option value="4:3">Classic · 4:3</option><option value="3:4">Tall · 3:4</option>
                </select>
              </label>
              <button type="button" onClick={() => void createImage()} disabled={generatingImage || imagePrompt.trim().length < 3 || Boolean(blocked)} className="primary-button min-h-11">
                {generatingImage ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}{generatingImage ? "Creating…" : "Create visual"}
              </button>
            </div>
          </div>
          <div className="relative grid min-h-72 place-items-center overflow-hidden rounded-xl border border-line bg-[radial-gradient(circle_at_top_right,color-mix(in_oklab,var(--color-primary)_16%,transparent),transparent_52%)] p-3">
            {generatedImage ? <>
              <Image src={generatedImage.dataUrl} alt={`AI-generated visual: ${imagePrompt}`} width={1024} height={1024} unoptimized className="max-h-[32rem] w-auto rounded-lg object-contain shadow-2xl" />
              <div className="absolute inset-x-3 bottom-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-line bg-background/90 p-2 backdrop-blur">
                <span className="truncate text-xs text-muted">{generatedImage.model}</span>
                <div className="flex gap-2"><a href={generatedImage.dataUrl} download="asael-visual.jpg" className="action-button"><Download size={14} aria-hidden="true" />Download</a><button type="button" onClick={() => void attachGeneratedImage()} className="primary-button"><ImageIcon size={14} aria-hidden="true" />Use in capture</button></div>
              </div>
            </> : <div className="max-w-sm text-center"><ImageIcon size={34} className="mx-auto text-primary/70" aria-hidden="true" /><p className="mt-3 text-sm font-medium">Your generated visual appears here</p><p className="mt-1 text-xs leading-5 text-muted">Nothing is stored until you explicitly move it into capture.</p></div>}
          </div>
        </div>
      </section>

      <section className="border-t border-line py-6">
        <h2 className="text-sm font-semibold">Connected sources</h2>
        <p className="mt-1 text-xs text-muted">Read-only Gmail, Calendar, and Drive access is granted to your Google account and can be revoked at any time.</p>
        <div className="mt-4 divide-y divide-line">
          {oauthProviders.map((provider) => {
            const grant = oauthGrants.find((item) => item.provider === provider.id);
            return <div key={provider.id} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"><div><p className="text-sm font-medium">{provider.label}</p><p className={clsx("text-xs", grant?.syncStatus === "error" ? "text-danger" : "text-muted")}>{grant ? grant.syncStatus === "error" ? grant.syncError || "Sync needs attention" : grant.lastSyncedAt ? `${grant.syncedItems || 0} items synced · last ${formatTime(grant.lastSyncedAt)}` : `Connected · ${grant.scopes.length} read-only scopes` : provider.configured ? "Ready to connect" : "Deployment credentials required"}</p></div>{grant ? <div className="flex gap-2"><button type="button" className="primary-button" disabled={syncingProvider === provider.id} onClick={() => void syncProvider(provider.id)}>{syncingProvider === provider.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <RefreshCw size={14} aria-hidden="true" />} Sync now</button><button type="button" className="action-button" onClick={async () => { await fetch(`/api/oauth/${provider.id}`, { method: "DELETE" }); await loadRecent(); }}>Disconnect</button></div> : <a href={provider.authorizeUrl} aria-disabled={!provider.configured} className={clsx("action-button", !provider.configured && "pointer-events-none opacity-50")}>Connect {provider.label}</a>}</div>;
          })}
        </div>
      </section>

      <section className="border-t border-line pt-6">
        <div className="flex items-baseline justify-between gap-3"><h2 className="text-sm font-semibold">Recently indexed</h2><span className="text-xs text-muted">{documents.length} shown</span></div>
        <div className="mt-3 divide-y divide-line">
          {documents.length ? documents.map((document) => (
            <div key={document.id} className="grid gap-1 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
              <div className="min-w-0"><p className="truncate text-sm font-medium">{document.title}</p><p className="truncate text-xs text-muted">{document.source}</p></div>
              <p className="text-xs text-muted">{document.chunkCount} chunks · {formatTime(document.updatedAt)}</p>
            </div>
          )) : <p className="py-6 text-sm text-muted">Captured knowledge will appear here after indexing.</p>}
        </div>
      </section>
    </div>
  );
}

function formatBytes(bytes: number) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function formatTime(value: string) { const date = new Date(value); return Number.isNaN(date.getTime()) ? "recently" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date); }

function captureForm(capture: Pick<OfflineCapture, "title" | "content" | "tags" | "file">) {
  const form = new FormData(); form.set("title", capture.title); form.set("content", capture.content); form.set("tags", capture.tags); if (capture.file) form.set("file", capture.file); return form;
}

async function flushOfflineCaptures() {
  if (!navigator.onLine) return;
  const captures = await listOfflineCaptures();
  for (const capture of captures) {
    try {
      const response = await fetch("/api/capture", { method: "POST", body: captureForm(capture), headers: { "idempotency-key": capture.id } });
      if (!response.ok) break;
      await removeOfflineCapture(capture.id);
    } catch { break; }
  }
}
