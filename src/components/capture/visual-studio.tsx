"use client";

import Image from "next/image";
import {
  CheckCircle2,
  Download,
  ImageIcon,
  Loader2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { useState } from "react";
import { clsx } from "clsx";

type CaptureJob = {
  id: string;
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  progress?: Record<string, unknown>;
  lastError?: string;
};

type GeneratedVisual = {
  imageUrl: string;
  model: string;
  prompt: string;
  asset: {
    id: string;
    filename: string;
    byteCount: number;
    storageKind: string;
  };
};

type Props = {
  configured?: boolean;
  model?: string;
  disabledReason?: string;
  onJob: (job: CaptureJob) => void;
  onAssetsChanged: () => Promise<void> | void;
};

export function VisualStudio({ configured, model, disabledReason, onJob, onAssetsChanged }: Props) {
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<"1:1" | "16:9" | "9:16" | "4:3" | "3:4">("16:9");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [visual, setVisual] = useState<GeneratedVisual>();
  const [saved, setSaved] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();

  async function createVisual() {
    if (prompt.trim().length < 3) return;
    setGenerating(true);
    setMessage(undefined);
    setSaved(false);
    try {
      const response = await fetch("/api/media/image", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim(), aspectRatio: ratio }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        image?: string;
        imageUrl?: string;
        model?: string;
        asset?: GeneratedVisual["asset"];
        error?: string;
        failure?: { category?: string; suggestion?: string };
      };
      if (!response.ok || !payload.image || !payload.asset?.id) {
        throw new Error(generationMessage(payload.error, payload.failure?.category, payload.failure?.suggestion));
      }
      setVisual({
        imageUrl: payload.imageUrl || payload.image,
        model: payload.model || model || "Gemini image",
        prompt: prompt.trim(),
        asset: payload.asset,
      });
      setMessage({ tone: "success", text: "Visual created and stored privately. Save it to knowledge when you want Asael to use it as context." });
      await onAssetsChanged();
    } catch (generationError) {
      setMessage({ tone: "error", text: generationError instanceof Error ? generationError.message : "Visual generation failed." });
    } finally {
      setGenerating(false);
    }
  }

  async function saveToKnowledge() {
    if (!visual) return;
    setSaving(true);
    setMessage(undefined);
    try {
      const response = await fetch(`/api/capture/assets/${encodeURIComponent(visual.asset.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          title: visual.prompt.slice(0, 120) || "Gemini visual",
          tags: ["gemini-visual", "generated"],
          note: visual.prompt,
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        job?: CaptureJob;
        error?: string;
      };
      if (!response.ok || !payload.job) throw new Error(payload.error || "The visual could not be queued for indexing.");
      setSaved(true);
      setMessage({ tone: "success", text: "Visual queued for RAG indexing and linked memory." });
      onJob(payload.job);
      await onAssetsChanged();
    } catch (saveError) {
      setMessage({ tone: "error", text: saveError instanceof Error ? saveError.message : "The visual could not be saved to knowledge." });
    } finally {
      setSaving(false);
    }
  }

  const unavailable = configured === false || Boolean(disabledReason);

  return (
    <section className="border-t border-line pt-7" aria-labelledby="visual-studio-title">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Gemini visual studio</p>
          <h2 id="visual-studio-title" className="mt-2 text-xl font-semibold tracking-tight">Create, keep, and index working visuals.</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted">The image is stored privately as an original asset. Saving to knowledge attaches your prompt as searchable context and links it to memory.</p>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className={clsx("size-2 rounded-full", configured === false ? "bg-danger" : configured ? "bg-success" : "bg-warning")} aria-hidden="true" />
          {configured === false ? "Gemini needs configuration" : configured ? `${model || "Gemini image"} ready` : "Checking Gemini…"}
        </div>
      </div>

      <div className="mt-5 grid overflow-hidden rounded-xl border border-line bg-surface xl:grid-cols-[minmax(22rem,.72fr)_minmax(0,1.28fr)]">
        <div className="border-b border-line p-5 xl:border-b-0 xl:border-r xl:p-6">
          <label className="block text-xs font-semibold text-muted">
            Describe the image
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              maxLength={4_000}
              rows={8}
              placeholder="A clear editorial diagram of a product strategy workshop, calm graphite surfaces, emerald annotations, wide composition…"
              className="mt-2 w-full resize-y rounded-lg border border-line bg-background px-3 py-3 text-sm leading-6 text-foreground outline-none focus:border-primary"
            />
          </label>
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <label className="text-xs font-semibold text-muted">
              Canvas
              <select value={ratio} onChange={(event) => setRatio(event.target.value as typeof ratio)} className="mt-2 block min-h-11 rounded-md border border-line bg-background px-3 text-sm text-foreground">
                <option value="16:9">Landscape · 16:9</option>
                <option value="1:1">Square · 1:1</option>
                <option value="9:16">Portrait · 9:16</option>
                <option value="4:3">Classic · 4:3</option>
                <option value="3:4">Tall · 3:4</option>
              </select>
            </label>
            <button type="button" onClick={() => void createVisual()} disabled={generating || prompt.trim().length < 3 || unavailable} title={disabledReason || (configured === false ? "Add a Gemini API key in deployment settings." : undefined)} className="primary-button min-h-11">
              {generating ? <Loader2 size={16} className="animate-spin" aria-hidden="true" /> : visual ? <RefreshCw size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}
              {generating ? "Creating…" : visual ? "Create another" : "Create visual"}
            </button>
          </div>
          {configured === false ? <p className="mt-4 border-l-2 border-warning pl-3 text-sm leading-6 text-warning">Gemini image generation is not configured for this deployment. Add or repair the Gemini API key before creating visuals.</p> : null}
          {message ? <p role={message.tone === "error" ? "alert" : "status"} className={clsx("mt-4 text-sm leading-6", message.tone === "error" ? "text-danger" : "text-success")}>{message.text}</p> : null}
        </div>

        <div className="relative grid min-h-[26rem] place-items-center bg-background p-4 sm:p-6">
          {visual ? (
            <>
              <Image src={visual.imageUrl} alt={`Gemini-generated visual: ${visual.prompt}`} width={1536} height={1024} unoptimized className="max-h-[38rem] w-auto max-w-full rounded-lg object-contain" />
              <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2 rounded-lg border border-line bg-background/95 p-3 backdrop-blur sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0"><p className="truncate text-xs font-semibold">{visual.asset.filename}</p><p className="mt-0.5 truncate text-xs text-muted">{visual.model} · {formatBytes(visual.asset.byteCount)} · stored privately</p></div>
                <div className="flex flex-wrap gap-2">
                  <a href={`/api/capture/assets/${encodeURIComponent(visual.asset.id)}?content=1&download=1`} className="action-button"><Download size={14} aria-hidden="true" />Download</a>
                  <button type="button" onClick={() => void saveToKnowledge()} disabled={saving || saved} className="primary-button">
                    {saving ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : saved ? <CheckCircle2 size={14} aria-hidden="true" /> : <ImageIcon size={14} aria-hidden="true" />}
                    {saving ? "Queuing…" : saved ? "Added to knowledge" : "Save to knowledge"}
                  </button>
                </div>
              </div>
            </>
          ) : (
            <div className="max-w-sm text-center">
              <span className="mx-auto grid size-14 place-items-center rounded-xl bg-surface-raised text-primary"><ImageIcon size={27} aria-hidden="true" /></span>
              <p className="mt-4 font-semibold">Your visual workspace is ready</p>
              <p className="mt-2 text-sm leading-6 text-muted">Describe the content, composition, and mood. The original image will remain available in your Capture library.</p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function generationMessage(message?: string, category?: string, suggestion?: string) {
  if (category === "configuration") return "Gemini image generation is not configured for this deployment.";
  if (category === "permission") return "The Gemini key cannot use this image model. Check model access and billing.";
  if (category === "quota") return "Gemini image capacity is temporarily unavailable. Try again after the quota resets.";
  return suggestion || message || "Gemini could not create this image.";
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
