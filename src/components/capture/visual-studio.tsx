"use client";

import Image from "next/image";
import {
  CheckCircle2,
  Clapperboard,
  Download,
  Film,
  ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
  WandSparkles,
} from "lucide-react";
import { useMemo, useState } from "react";
import { clsx } from "clsx";

type CaptureJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: Record<string, unknown>;
  lastError?: string;
};

export type MediaSourceAsset = {
  id: string;
  filename: string;
  mediaType: string;
  byteCount: number;
  contentAvailable?: boolean;
};

type MediaRoute = {
  configured?: boolean;
  provider?: string;
  model?: string;
};

type MediaResult = {
  kind: "image" | "video";
  contentUrl: string;
  model: string;
  prompt: string;
  operation: "generate" | "edit" | "clip";
  asset: {
    id: string;
    filename: string;
    byteCount: number;
    storageKind: string;
  };
};

type Props = {
  assets: MediaSourceAsset[];
  imageRoute?: MediaRoute;
  videoRoute?: MediaRoute;
  disabledReason?: string;
  onJob: (job: CaptureJob) => void;
  onAssetsChanged: () => Promise<void> | void;
};

type StudioMode = "image" | "video" | "clip";

export function VisualStudio({
  assets,
  imageRoute,
  videoRoute,
  disabledReason,
  onJob,
  onAssetsChanged,
}: Props) {
  const [mode, setMode] = useState<StudioMode>("image");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<"1:1" | "16:9" | "9:16" | "4:3" | "3:4">("16:9");
  const [resolution, setResolution] = useState<"360p" | "720p">("360p");
  const [sourceAssetId, setSourceAssetId] = useState("");
  const [videoOperation, setVideoOperation] = useState<"generate" | "edit">("generate");
  const [clipStart, setClipStart] = useState("0");
  const [clipEnd, setClipEnd] = useState("10");
  const [working, setWorking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<MediaResult>();
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();

  const imageSources = useMemo(
    () => assets.filter((asset) => asset.contentAvailable && asset.mediaType.startsWith("image/")),
    [assets],
  );
  const videoSources = useMemo(
    () => assets.filter((asset) => asset.contentAvailable && asset.mediaType.startsWith("video/")),
    [assets],
  );
  const eligibleSources = mode === "image"
    ? imageSources
    : mode === "clip" || videoOperation === "edit"
      ? videoSources
      : imageSources;
  const route = mode === "image" ? imageRoute : videoRoute;
  const operation = mode === "clip"
    ? "clip"
    : mode === "image"
      ? sourceAssetId ? "edit" : "generate"
      : videoOperation;
  const unavailable = Boolean(disabledReason) || (mode !== "clip" && route?.configured === false);
  const requiresSource = mode === "clip" || (mode === "video" && videoOperation === "edit");
  const canRun = !working && !unavailable && (!requiresSource || Boolean(sourceAssetId)) && (mode === "clip" || prompt.trim().length >= 3);

  function switchMode(nextMode: StudioMode) {
    setMode(nextMode);
    setSourceAssetId("");
    setMessage(undefined);
    setSaved(false);
  }

  async function runMediaRequest() {
    if (!canRun) return;
    setWorking(true);
    setMessage(undefined);
    setSaved(false);
    try {
      if (mode === "clip") await createClip();
      else await createGeneratedMedia();
      await onAssetsChanged();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "The media request failed." });
    } finally {
      setWorking(false);
    }
  }

  async function createGeneratedMedia() {
    const sourceIds = sourceAssetId ? [sourceAssetId] : [];
    const response = await fetch(`/api/media/${mode}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.trim(),
        operation,
        sourceAssetIds: sourceIds,
        aspectRatio: mode === "image" ? ratio : ratio === "9:16" ? "9:16" : "16:9",
        ...(mode === "video" ? { resolution } : {}),
      }),
    });
    const payload = await response.json().catch(() => ({})) as {
      image?: string;
      video?: string;
      model?: string;
      asset?: MediaResult["asset"];
      error?: string;
      failure?: { category?: string; suggestion?: string };
    };
    const contentUrl = mode === "image" ? payload.image : payload.video;
    if (!response.ok || !contentUrl || !payload.asset?.id) {
      throw new Error(mediaFailureMessage(payload.error, payload.failure?.category, payload.failure?.suggestion));
    }
    setResult({
      kind: mode === "image" ? "image" : "video",
      contentUrl,
      model: payload.model || route?.model || "Assigned media model",
      prompt: prompt.trim(),
      operation: operation as "generate" | "edit",
      asset: payload.asset,
    });
    setMessage({
      tone: "success",
      text: `${mode === "image" ? "Image" : "Video"} ${operation === "edit" ? "edited" : "created"} and stored privately. The original source was not changed.`,
    });
  }

  async function createClip() {
    const source = videoSources.find((asset) => asset.id === sourceAssetId);
    if (!source) throw new Error("Choose a source video to clip.");
    const startSeconds = Number(clipStart);
    const endSeconds = Number(clipEnd);
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds - startSeconds > 600) {
      throw new Error("Choose a valid start and end time, up to 10 minutes apart.");
    }
    const response = await fetch("/api/media/video/clip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sourceAssetId: source.id, startSeconds, endSeconds }),
    });
    const payload = await response.json().catch(() => ({})) as {
      video?: string;
      asset?: MediaResult["asset"];
      error?: string;
    };
    if (!response.ok || !payload.video || !payload.asset?.id) {
      throw new Error(payload.error || "The encoded clip could not be stored.");
    }
    setResult({
      kind: "video",
      contentUrl: payload.video,
      model: "Deterministic FFmpeg clip",
      prompt: `${source.filename} · ${formatSeconds(startSeconds)}–${formatSeconds(endSeconds)}`,
      operation: "clip",
      asset: payload.asset,
    });
    setMessage({ tone: "success", text: "Clip created and stored privately. The source video was not changed." });
  }

  async function saveToKnowledge() {
    if (!result) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/capture/assets/${encodeURIComponent(result.asset.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          title: result.prompt.slice(0, 120) || `${result.kind} ${result.operation}`,
          tags: ["media-studio", result.kind, result.operation],
          note: result.prompt,
        }),
      });
      const payload = await response.json().catch(() => ({})) as { job?: CaptureJob; error?: string };
      if (!response.ok || !payload.job) throw new Error(payload.error || "The media could not be queued for indexing.");
      setSaved(true);
      setMessage({ tone: "success", text: "Media queued for knowledge indexing and linked memory." });
      onJob(payload.job);
      await onAssetsChanged();
    } catch (error) {
      setMessage({ tone: "error", text: error instanceof Error ? error.message : "The media could not be saved to knowledge." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border-t border-line pt-7" aria-labelledby="media-studio-title">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-end xl:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Media studio</p>
          <h2 id="media-studio-title" className="mt-2 text-2xl font-semibold tracking-tight">Create, edit, animate, and clip.</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">Give Asael a prompt, optionally choose one of your private source assets, and keep every result as a new version with source lineage.</p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs text-muted">
          <RouteStatus label="Images" route={imageRoute} />
          <RouteStatus label="Video" route={videoRoute} />
        </div>
      </div>

      <div className="mt-5 overflow-hidden rounded-xl border border-line bg-surface">
        <div className="flex flex-wrap gap-1 border-b border-line bg-surface-raised p-2" role="tablist" aria-label="Media operation">
          <ModeButton active={mode === "image"} onClick={() => switchMode("image")} icon={ImageIcon} label="Image" />
          <ModeButton active={mode === "video"} onClick={() => switchMode("video")} icon={Film} label="Video" />
          <ModeButton active={mode === "clip"} onClick={() => switchMode("clip")} icon={Clapperboard} label="Clip" />
        </div>

        <div className="grid xl:grid-cols-[minmax(22rem,.72fr)_minmax(0,1.28fr)]">
          <div className="border-b border-line p-5 xl:border-b-0 xl:border-r xl:p-6">
            {mode === "video" ? (
              <div className="mb-4 grid grid-cols-2 gap-2 rounded-lg bg-background p-1">
                {(["generate", "edit"] as const).map((value) => (
                  <button key={value} type="button" onClick={() => { setVideoOperation(value); setSourceAssetId(""); }} className={clsx("min-h-10 rounded-md px-3 text-sm font-semibold capitalize", videoOperation === value ? "bg-surface text-foreground shadow-sm" : "text-muted")}>{value}</button>
                ))}
              </div>
            ) : null}

            <label className="block text-xs font-semibold text-muted">
              {mode === "clip" ? "Source video" : operation === "edit" ? `Source ${mode}` : mode === "video" ? "Reference image (optional)" : "Source image (optional)"}
              <select value={sourceAssetId} onChange={(event) => setSourceAssetId(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-line bg-background px-3 text-sm text-foreground">
                <option value="">{requiresSource ? "Choose a source…" : "Start without a source"}</option>
                {eligibleSources.map((asset) => <option key={asset.id} value={asset.id}>{asset.filename} · {formatBytes(asset.byteCount)}</option>)}
              </select>
            </label>
            {!eligibleSources.length ? <p className="mt-2 text-xs leading-5 text-muted">Upload a compatible {mode === "image" || (mode === "video" && videoOperation === "generate") ? "image" : "video"} in Capture to use it here.</p> : null}

            {mode === "clip" ? (
              <div className="mt-4 grid grid-cols-2 gap-3">
                <TimeField label="Start (seconds)" value={clipStart} onChange={setClipStart} />
                <TimeField label="End (seconds)" value={clipEnd} onChange={setClipEnd} />
              </div>
            ) : (
              <label className="mt-4 block text-xs font-semibold text-muted">
                {operation === "edit" ? "Describe only what should change" : `Describe the ${mode}`}
                <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4_000} rows={7} placeholder={promptPlaceholder(mode, operation)} className="mt-2 w-full resize-y rounded-lg border border-line bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none focus:border-primary" />
              </label>
            )}

            <div className="mt-4 flex flex-wrap items-end gap-3">
              {mode !== "clip" ? (
                <label className="text-xs font-semibold text-muted">Canvas<select value={ratio} onChange={(event) => setRatio(event.target.value as typeof ratio)} className="mt-2 block min-h-11 rounded-md border border-line bg-background px-3 text-sm text-foreground"><option value="16:9">Landscape · 16:9</option><option value="1:1" disabled={mode === "video"}>Square · 1:1</option><option value="9:16">Portrait · 9:16</option><option value="4:3" disabled={mode === "video"}>Classic · 4:3</option><option value="3:4" disabled={mode === "video"}>Tall · 3:4</option></select></label>
              ) : null}
              {mode === "video" ? <label className="text-xs font-semibold text-muted">Quality<select value={resolution} onChange={(event) => setResolution(event.target.value as typeof resolution)} className="mt-2 block min-h-11 rounded-md border border-line bg-background px-3 text-sm text-foreground"><option value="360p">360p · compact</option><option value="720p">720p · larger</option></select></label> : null}
              <button type="button" onClick={() => void runMediaRequest()} disabled={!canRun} title={disabledReason || (route?.configured === false ? `Assign a ${mode} model in Settings.` : undefined)} className="primary-button min-h-11">
                {working ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : result ? <RefreshCw size={16} aria-hidden="true" /> : mode === "clip" ? <Clapperboard size={16} aria-hidden="true" /> : <WandSparkles size={16} aria-hidden="true" />}
                {working ? mode === "clip" ? "Clipping in real time…" : "Creating…" : actionLabel(mode, operation, Boolean(result))}
              </button>
            </div>
            {mode !== "clip" && route?.configured === false ? <p className="mt-4 border-l-2 border-warning pl-3 text-sm leading-6 text-warning">Assign and validate a compatible {mode} model in Settings before using this operation.</p> : null}
            {mode === "clip" ? <p className="mt-4 text-xs leading-5 text-muted">Clipping is deterministic, preserves the original video and available audio, and stores only the selected segment as a new asset.</p> : null}
            {message ? <p role={message.tone === "error" ? "alert" : "status"} className={clsx("mt-4 text-sm leading-6", message.tone === "error" ? "text-danger" : "text-success")}>{message.text}</p> : null}
          </div>

          <div className="relative grid min-h-[28rem] place-items-center bg-background p-4 sm:p-6">
            {result ? (
              <>
                {result.kind === "image" ? <Image src={result.contentUrl} alt={`${result.operation} result: ${result.prompt}`} width={1536} height={1024} unoptimized className="max-h-[40rem] w-auto max-w-full rounded-lg object-contain" /> : <video src={result.contentUrl} controls playsInline className="max-h-[40rem] w-full rounded-lg object-contain" aria-label={`${result.operation} video result`} />}
                <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2 rounded-lg border border-line bg-background/95 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0"><p className="truncate text-xs font-semibold">{result.asset.filename}</p><p className="mt-0.5 truncate text-xs text-muted">{result.model} · {formatBytes(result.asset.byteCount)} · {result.operation} · private</p></div>
                  <div className="flex flex-wrap gap-2"><a href={`${result.contentUrl}&download=1`} className="action-button"><Download size={14} aria-hidden="true" />Download</a><button type="button" onClick={() => void saveToKnowledge()} disabled={saving || saved} className="primary-button">{saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : saved ? <CheckCircle2 size={14} aria-hidden="true" /> : <Sparkles size={14} aria-hidden="true" />}{saving ? "Queuing…" : saved ? "Added to knowledge" : "Save to knowledge"}</button></div>
                </div>
              </>
            ) : (
              <div className="max-w-md text-center"><span className="mx-auto grid size-16 place-items-center rounded-2xl bg-surface-raised text-primary"><WandSparkles size={30} aria-hidden="true" /></span><p className="mt-4 text-lg font-semibold">Your private media workspace</p><p className="mt-2 text-sm leading-6 text-muted">Generate from a prompt, edit a source without overwriting it, animate an image, transform a video, or cut an exact segment.</p></div>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function RouteStatus({ label, route }: { label: string; route?: MediaRoute }) {
  const ready = route?.configured;
  return <span className="inline-flex min-h-9 items-center gap-2 rounded-full border border-line bg-surface px-3"><span className={clsx("size-2 rounded-full", ready === false ? "bg-danger" : ready ? "bg-success" : "bg-warning")} aria-hidden="true" />{label}: {ready === false ? "needs setup" : ready ? `${route.provider} · ${route.model}` : "checking"}</span>;
}

function ModeButton({ active, onClick, icon: Icon, label }: { active: boolean; onClick: () => void; icon: typeof ImageIcon; label: string }) {
  return <button type="button" role="tab" aria-selected={active} onClick={onClick} className={clsx("inline-flex min-h-10 items-center gap-2 rounded-md px-4 text-sm font-semibold transition", active ? "bg-background text-foreground shadow-sm" : "text-muted hover:text-foreground")}><Icon size={16} aria-hidden="true" />{label}</button>;
}

function TimeField({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return <label className="text-xs font-semibold text-muted">{label}<input type="number" min="0" step="0.1" value={value} onChange={(event) => onChange(event.target.value)} className="mt-2 min-h-11 w-full rounded-md border border-line bg-background px-3 text-sm text-foreground" /></label>;
}

function promptPlaceholder(mode: StudioMode, operation: string) {
  if (mode === "image" && operation === "edit") return "Make this a polished professional passport portrait with a neutral background. Preserve identity and natural facial features…";
  if (mode === "video" && operation === "edit") return "Change the lighting to be more cinematic. Keep everything else the same…";
  if (mode === "video") return "A single continuous shot with precise subject motion, camera movement, lighting, mood, and natural audio…";
  return "A crisp editorial illustration with clear composition, lighting, material, color, mood, and intended use…";
}

function actionLabel(mode: StudioMode, operation: string, again: boolean) {
  if (again) return "Create another";
  if (mode === "clip") return "Create clip";
  return operation === "edit" ? `Edit ${mode}` : `Create ${mode}`;
}

function mediaFailureMessage(message?: string, category?: string, suggestion?: string) {
  if (category === "configuration") return "Assign and validate a compatible media model in Settings.";
  if (category === "permission") return "The selected credential cannot use this model. Check access and billing in Settings.";
  if (category === "quota") return "Media capacity is temporarily unavailable. Try again after the quota resets.";
  return suggestion || message || "The assigned media model could not complete this request.";
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) return "unknown";
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
