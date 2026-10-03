"use client";

import { CheckCircle2, Clapperboard, Download, Film, ImageIcon, Loader2, RefreshCw, Sparkles, WandSparkles } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { clsx } from "clsx";
import {
  PrivateMediaPreview,
  type PrivateMediaReadiness,
  privateCaptureAssetContentUrl,
} from "@/components/media/private-media-preview";
import { createVisualStudioRequestGate, readVisualStudioAssetReceipt, readVisualStudioIndexReceipt, type VisualStudioRequestToken, type VisualStudioResultIdentity } from "./visual-studio-request";
import styles from "./visual-studio.module.css";

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

type MediaRoute = { configured?: boolean; provider?: string; model?: string };
type ReadState = { loaded: boolean; error?: string };
type StudioMode = "image" | "video" | "clip";
type MediaOperation = "generate" | "edit" | "clip";
type AspectRatio = "1:1" | "16:9" | "9:16" | "4:3" | "3:4";
type Submission = Readonly<{
  mode: StudioMode;
  operation: MediaOperation;
  prompt: string;
  sourceAssetId: string;
  sourceFilename?: string;
  aspectRatio?: AspectRatio;
  resolution?: "360p" | "720p";
  startSeconds?: number;
  endSeconds?: number;
  model?: string;
  provider?: string;
}>;
type ResultAsset = { id: string; filename: string; byteCount: number; storageKind: string };
type MediaResult = {
  identity: VisualStudioResultIdentity;
  submission: Submission;
  kind: "image" | "video";
  model: string;
  provider?: string;
  prompt: string;
  operation: MediaOperation;
  asset: ResultAsset;
};
type Notice = { tone: "success" | "error" | "warning"; text: string };
type Pending = { token: VisualStudioRequestToken; submission?: Submission };

type Props = {
  assets: MediaSourceAsset[];
  imageRoute?: MediaRoute;
  videoRoute?: MediaRoute;
  assetsRead?: ReadState;
  capabilitiesRead?: ReadState;
  loading?: boolean;
  disabledReason?: string;
  saveDisabledReason?: string;
  onJob: (job: CaptureJob) => void;
  onAssetsChanged: () => Promise<void> | void;
};

export function VisualStudio({
  assets, imageRoute, videoRoute, assetsRead, capabilitiesRead, loading = false,
  disabledReason, saveDisabledReason, onJob, onAssetsChanged,
}: Props) {
  const [mode, setMode] = useState<StudioMode>("image");
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState<AspectRatio>("16:9");
  const [videoRatio, setVideoRatio] = useState<"16:9" | "9:16">("16:9");
  const [resolution, setResolution] = useState<"360p" | "720p">("360p");
  const [sourceDrafts, setSourceDrafts] = useState({ image: "", videoGenerate: "", videoEdit: "", clip: "" });
  const [videoOperation, setVideoOperation] = useState<"generate" | "edit">("generate");
  const [clipStart, setClipStart] = useState("0");
  const [clipEnd, setClipEnd] = useState("10");
  const [requestGate] = useState(createVisualStudioRequestGate);
  const feedbackRevision = useRef(0);
  const mounted = useRef(true);
  const [pending, setPending] = useState<Pending>();
  const [result, setResult] = useState<MediaResult>();
  const [sourcePreview, setSourcePreview] = useState<{ identity: symbol; readiness: PrivateMediaReadiness }>();
  const [resultPreview, setResultPreview] = useState<{ identity: VisualStudioResultIdentity; readiness: PrivateMediaReadiness }>();
  const [indexReceipt, setIndexReceipt] = useState<{ identity: VisualStudioResultIdentity; job: CaptureJob }>();
  const [message, setMessage] = useState<Notice>();
  const [refreshing, setRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string>();

  useEffect(() => {
    mounted.current = true;
    requestGate.activate();
    return () => {
      mounted.current = false;
      feedbackRevision.current += 1;
      requestGate.dispose();
    };
  }, [requestGate]);

  const imageSources = useMemo(() => assets.filter((asset) => asset.contentAvailable && asset.mediaType.startsWith("image/")), [assets]);
  const videoSources = useMemo(() => assets.filter((asset) => asset.contentAvailable && asset.mediaType.startsWith("video/")), [assets]);
  const sourceKey = mode === "video" ? videoOperation === "edit" ? "videoEdit" : "videoGenerate" : mode;
  const sourceAssetId = sourceDrafts[sourceKey];
  const eligibleSources = mode === "image" || (mode === "video" && videoOperation === "generate") ? imageSources : videoSources;
  const selectedSource = eligibleSources.find((asset) => asset.id === sourceAssetId);
  const sourcePreviewIdentity = useMemo(() => selectedSource ? Symbol(selectedSource.id) : undefined, [selectedSource]);
  const selectedSourceDescription = assets.find((asset) => asset.id === sourceAssetId);
  const route = mode === "image" ? imageRoute : videoRoute;
  const operation: MediaOperation = mode === "clip" ? "clip" : mode === "image" ? sourceAssetId ? "edit" : "generate" : videoOperation;
  const effectiveRatio = mode === "video" ? videoRatio : ratio;
  const sourceState = assetsRead || { loaded: true };
  const configurationState = capabilitiesRead || { loaded: Boolean(imageRoute || videoRoute) };
  const reading = loading || refreshing;
  const busy = Boolean(pending);
  const working = pending?.token.kind === "create";
  const saving = pending?.token.kind === "save";
  const requiresSource = mode === "clip" || (mode === "video" && videoOperation === "edit");
  const sourceReadiness = sourcePreview?.identity === sourcePreviewIdentity ? sourcePreview?.readiness || "preparing" : "preparing";
  const resultReadiness = resultPreview?.identity === result?.identity ? resultPreview?.readiness || "preparing" : "preparing";
  const receipt = indexReceipt?.identity === result?.identity ? indexReceipt?.job : undefined;
  const indexingAccepted = receipt && receipt.status !== "failed" && receipt.status !== "canceled";
  const startSeconds = Number(clipStart);
  const endSeconds = Number(clipEnd);
  const validClipRange = clipStart.trim() !== "" && clipEnd.trim() !== "" && Number.isFinite(startSeconds) && Number.isFinite(endSeconds) && startSeconds >= 0 && startSeconds <= 86_400 && endSeconds > startSeconds && endSeconds <= 86_400 && endSeconds - startSeconds <= 600;
  const runDisabledReason = busy ? saving ? "Wait for this result’s indexing request to finish before creating another result." : "A media request is in progress. Your draft edits will apply to the next request."
    : disabledReason
      || (mode !== "clip" && (!configurationState.loaded || configurationState.error) ? "Model configuration is unavailable. Refresh media sources to check it." : undefined)
      || (mode !== "clip" && route?.configured !== true ? route?.configured === false ? `Assign and validate a compatible ${mode} model in Settings.` : `The ${mode} model route is unavailable. Refresh media sources to check it.` : undefined)
      || (sourceAssetId && (!sourceState.loaded || sourceState.error) ? "Source availability is unverified. Refresh media sources before using this selection." : undefined)
      || (sourceAssetId && !selectedSource ? "The selected source is unavailable in the current source list. Choose an available source or refresh." : undefined)
      || (requiresSource && !sourceAssetId ? "Choose a source video before continuing." : undefined)
      || (sourceAssetId && sourceReadiness !== "ready" ? sourceReadiness === "failed" ? "The source preview is unavailable. Retry its preview before continuing." : "Wait for the source preview to finish verification." : undefined)
      || (mode === "clip" && !validClipRange ? "Choose a valid start and end time, up to 10 minutes apart and within 24 hours." : undefined)
      || (mode !== "clip" && prompt.trim().length < 3 ? "Add a prompt with at least 3 characters." : undefined);
  const saveReason = busy ? working ? "Wait for the current media request before saving a result." : "The indexing request is in progress."
    : saveDisabledReason || (indexingAccepted ? `Indexing receipt: ${jobStatusLabel(receipt.status)}. See Capture processing for the latest job status.`
      : resultReadiness !== "ready" ? resultReadiness === "failed" ? "Retry the result preview before saving or downloading this file." : "The stored file must finish preview verification before saving or downloading." : undefined);

  const submission: Submission = {
    mode, operation, prompt: prompt.trim(), sourceAssetId, sourceFilename: selectedSource?.filename,
    ...(mode === "clip" ? { startSeconds, endSeconds } : { aspectRatio: effectiveRatio, ...(mode === "video" ? { resolution } : {}), model: route?.model, provider: route?.provider }),
  };
  const draftChanged = result ? !sameSubmittedInputs(result.submission, submission) : false;
  const resultIdentity = result?.identity;
  const handleSourceReadiness = useCallback((readiness: PrivateMediaReadiness) => {
    if (!sourcePreviewIdentity) return;
    setSourcePreview((current) => current?.identity === sourcePreviewIdentity && current.readiness === readiness ? current : { identity: sourcePreviewIdentity, readiness });
  }, [sourcePreviewIdentity]);
  const handleResultReadiness = useCallback((readiness: PrivateMediaReadiness) => {
    if (!resultIdentity || !requestGate.isCurrentResult(resultIdentity)) return;
    setResultPreview((current) => current?.identity === resultIdentity && current.readiness === readiness ? current : { identity: resultIdentity, readiness });
  }, [requestGate, resultIdentity]);

  function switchMode(nextMode: StudioMode) {
    if (busy || nextMode === mode) return;
    setMode(nextMode);
    setSourcePreview(undefined);
  }

  async function refreshSources() {
    if (reading || busy) return;
    const revision = ++feedbackRevision.current;
    setRefreshing(true);
    setRefreshError(undefined);
    try {
      await onAssetsChanged();
    } catch (error) {
      if (mounted.current && feedbackRevision.current === revision) setRefreshError(error instanceof Error ? error.message : "Media sources could not be refreshed.");
    } finally {
      if (mounted.current) setRefreshing(false);
    }
  }

  async function refreshAfterReceipt(identity: VisualStudioResultIdentity, revision: number) {
    try {
      await onAssetsChanged();
    } catch (error) {
      if (requestGate.isCurrentResult(identity) && feedbackRevision.current === revision) setRefreshError(error instanceof Error ? error.message : "The request was accepted, but media sources could not be refreshed.");
    }
  }

  async function runMediaRequest() {
    if (runDisabledReason) return;
    const token = requestGate.beginCreate();
    if (!token) return;
    const revision = ++feedbackRevision.current;
    const submitted = Object.freeze({ ...submission });
    setPending({ token, submission: submitted });
    setMessage(undefined);
    setRefreshError(undefined);
    try {
      const response = await fetch(submitted.mode === "clip" ? "/api/media/video/clip" : `/api/media/${submitted.mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(submitted.mode === "clip" ? {
          sourceAssetId: submitted.sourceAssetId, startSeconds: submitted.startSeconds, endSeconds: submitted.endSeconds,
        } : {
          prompt: submitted.prompt, operation: submitted.operation, sourceAssetIds: submitted.sourceAssetId ? [submitted.sourceAssetId] : [],
          aspectRatio: submitted.aspectRatio, ...(submitted.mode === "video" ? { resolution: submitted.resolution } : {}),
        }),
      });
      if (!requestGate.isCurrent(token)) return;
      const payload = await response.json().catch(() => ({})) as { model?: string; provider?: string; asset?: ResultAsset; error?: string; failure?: { category?: string; suggestion?: string } };
      if (!requestGate.isCurrent(token)) return;
      if (!response.ok) throw new Error(submitted.mode === "clip" ? payload.error || "The encoded clip could not be stored." : mediaFailureMessage(payload.error, payload.failure?.category, payload.failure?.suggestion));
      const stored = readVisualStudioAssetReceipt(payload, submitted);
      if (!stored) throw new Error("The media response did not match the submitted request and a valid stored asset. Refresh Capture to check stored files.");
      const identity = requestGate.acceptResult(token, stored.asset.id);
      if (!identity) return;
      const resultPrompt = submitted.mode === "clip" ? `${submitted.sourceFilename} · ${formatSeconds(submitted.startSeconds!)}–${formatSeconds(submitted.endSeconds!)}` : submitted.prompt;
      setResult({
        identity, submission: submitted, kind: submitted.mode === "image" ? "image" : "video",
        model: submitted.mode === "clip" ? "Deterministic FFmpeg clip" : stored.model!,
        provider: submitted.mode === "clip" ? "Deterministic processor" : stored.provider,
        prompt: resultPrompt, operation: submitted.operation, asset: stored.asset,
      });
      setResultPreview({ identity, readiness: "preparing" });
      setIndexReceipt(undefined);
      setMessage({ tone: "success", text: `${submitted.mode === "image" ? "Image" : submitted.mode === "clip" ? "Clip" : "Video"} stored privately. Preview verification and knowledge indexing are separate steps.` });
      if (requestGate.finish(token)) setPending(undefined);
      void refreshAfterReceipt(identity, revision);
    } catch (error) {
      if (requestGate.isCurrent(token)) setMessage({ tone: "error", text: error instanceof Error ? error.message : "The media request failed." });
    } finally {
      if (requestGate.finish(token)) setPending(undefined);
    }
  }

  async function saveToKnowledge() {
    if (!result || saveReason || resultReadiness !== "ready") return;
    const savingResult = result;
    const token = requestGate.beginSave(savingResult.identity);
    if (!token) return;
    const revision = ++feedbackRevision.current;
    setPending({ token });
    setMessage(undefined);
    setRefreshError(undefined);
    try {
      const response = await fetch(`/api/capture/assets/${encodeURIComponent(savingResult.asset.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
        body: JSON.stringify({
          title: savingResult.prompt.slice(0, 120) || `${savingResult.kind} ${savingResult.operation}`,
          tags: ["media-studio", savingResult.kind, savingResult.operation], note: savingResult.prompt,
        }),
      });
      if (!requestGate.canApplySave(token)) return;
      const payload = await response.json().catch(() => ({})) as { job?: CaptureJob; error?: string };
      if (!requestGate.canApplySave(token)) return;
      if (!response.ok) throw new Error(payload.error || "The media could not be queued for indexing.");
      const job = readVisualStudioIndexReceipt(payload, savingResult.asset.id);
      if (!job) throw new Error("The indexing response did not identify this asset and a valid job. Refresh Capture to check its status.");
      setIndexReceipt({ identity: savingResult.identity, job });
      setMessage({ tone: job.status === "failed" || job.status === "canceled" ? "warning" : "success", text: `Indexing receipt: ${jobStatusLabel(job.status)}. See Capture processing for the latest job status.` });
      try {
        onJob(job);
      } catch {
        setRefreshError("The indexing receipt was accepted, but Capture processing could not be refreshed.");
      }
      if (requestGate.finish(token)) setPending(undefined);
      void refreshAfterReceipt(savingResult.identity, revision);
    } catch (error) {
      if (requestGate.canApplySave(token)) setMessage({ tone: "error", text: error instanceof Error ? error.message : "The media could not be saved to knowledge." });
    } finally {
      if (requestGate.finish(token)) setPending(undefined);
    }
  }

  const sourceLabel = mode === "clip" || (mode === "video" && operation === "edit") ? "Source video" : mode === "video" ? "Reference image (optional)" : "Source image (optional)";
  return (
    <section className={styles.shell} aria-labelledby="media-studio-title" data-testid="visual-studio">
      <div className={styles.header}>
        <div>
          <h2 id="media-studio-title" className={styles.title}>Visual Studio</h2>
          <p className={styles.intro}>Create media or edit a private source. Each result is stored as a separate asset with its source lineage.</p>
        </div>
        <button type="button" className={styles.button} disabled={reading || busy} onClick={() => void refreshSources()}><RefreshCw size={16} aria-hidden="true" />{reading ? "Refreshing media sources…" : "Refresh media sources"}</button>
      </div>
      <div className={styles.routes} aria-label="Media model configuration">
        <RouteStatus label="Images" route={imageRoute} read={configurationState} loading={reading} />
        <RouteStatus label="Video" route={videoRoute} read={configurationState} loading={reading} />
      </div>
      <ReadStatus label="Source assets" read={sourceState} loading={reading} />
      <ReadStatus label="Model configuration" read={configurationState} loading={reading} />
      {refreshError ? <p className={clsx(styles.notice, styles.warning)} role="alert">The last confirmed result is retained. Refresh unavailable: {refreshError}</p> : null}
      <div className={styles.modes} role="group" aria-label="Media operation">
        <ModeButton active={mode === "image"} disabled={busy} onClick={() => switchMode("image")} icon={ImageIcon} label="Image" />
        <ModeButton active={mode === "video"} disabled={busy} onClick={() => switchMode("video")} icon={Film} label="Video" />
        <ModeButton active={mode === "clip"} disabled={busy} onClick={() => switchMode("clip")} icon={Clapperboard} label="Clip" />
      </div>
      <div className={styles.workspace}>
        <div className={styles.editor}>
          <div className={styles.editorHeading}><h3 className={styles.itemTitle}>{mode === "clip" ? "Clip draft" : `${mode === "image" ? "Image" : "Video"} draft`}</h3><p className={styles.supporting}>{draftChanged ? "Draft changed since the last result. Create again to apply these changes." : "Draft changes are kept here until you leave Capture."}</p></div>
          {mode === "video" ? <div className={styles.operationButtons} role="group" aria-label="Video operation">{(["generate", "edit"] as const).map((value) => <button key={value} type="button" aria-pressed={videoOperation === value} disabled={busy} onClick={() => { if (value !== videoOperation) { setVideoOperation(value); setSourcePreview(undefined); } }} className={styles.modeButton}>{value === "generate" ? "Generate" : "Edit"}</button>)}</div> : null}
          <label className={styles.field}>{sourceLabel}
            <select className={styles.select} value={sourceAssetId} disabled={busy || !sourceState.loaded} onChange={(event) => { const nextId = event.target.value; setSourceDrafts((current) => ({ ...current, [sourceKey]: nextId })); setSourcePreview(undefined); }} aria-describedby="visual-source-help">
              <option value="">{requiresSource ? "Choose a source…" : "Start without a source"}</option>
              {sourceAssetId && !selectedSource ? <option value={sourceAssetId}>Unavailable selection · {selectedSourceDescription?.filename || sourceAssetId}</option> : null}
              {eligibleSources.map((asset) => <option key={asset.id} value={asset.id}>{asset.filename} · {formatBytes(asset.byteCount)}</option>)}
            </select>
          </label>
          <p className={styles.supporting} id="visual-source-help">{!sourceState.loaded ? reading ? "Loading source availability…" : "Source availability is unavailable." : sourceState.error ? "Last-loaded sources are shown. Refresh to verify this selection before using it." : !eligibleSources.length ? `No compatible ${mode === "image" || (mode === "video" && videoOperation === "generate") ? "images" : "videos"} are available in the loaded Capture list. Upload a source in Capture to use it here.` : "Only available private media of the required type is listed."}</p>
          {sourceAssetId ? <div className={styles.sourceDetails} data-testid="visual-source-details">
            <dl className={styles.metadata}>
              <div><dt>Selected source</dt><dd>{selectedSourceDescription?.filename || "Source metadata unavailable"}</dd></div>
              <div><dt>Source ID</dt><dd><code className={styles.identity}>{sourceAssetId}</code></dd></div>
              {selectedSourceDescription ? <div><dt>Source file</dt><dd>{selectedSourceDescription.mediaType} · {formatBytes(selectedSourceDescription.byteCount)}</dd></div> : null}
            </dl>
            {selectedSource ? <PrivateMediaPreview key={`${sourceKey}:${selectedSource.id}`} assetId={selectedSource.id} kind={selectedSource.mediaType.startsWith("video/") ? "video" : "image"} alt={`Private source preview: ${selectedSource.filename}`} compact className={styles.preview} mediaClassName={styles.sourceMedia} onReadinessChange={handleSourceReadiness} /> : <p className={styles.supporting}>This selection is retained, but its source cannot currently be previewed or used.</p>}
          </div> : null}
          {mode === "clip" ? <div className={styles.fieldsRow}><TimeField label="Start (seconds)" value={clipStart} onChange={setClipStart} invalid={!validClipRange} /><TimeField label="End (seconds)" value={clipEnd} onChange={setClipEnd} invalid={!validClipRange} /></div> : <label className={styles.field}>Prompt
            <span className={styles.supporting}>{operation === "edit" ? "Describe only what should change." : `Describe the ${mode} you want to create.`}</span>
            <textarea aria-label="Prompt" className={styles.textarea} value={prompt} onChange={(event) => setPrompt(event.target.value)} maxLength={4_000} rows={7} placeholder={promptPlaceholder(mode, operation)} />
          </label>}
          {mode !== "clip" ? <div className={styles.fieldsRow}>
            <label className={styles.field}>Canvas<select className={styles.select} value={effectiveRatio} onChange={(event) => mode === "video" ? setVideoRatio(event.target.value as "16:9" | "9:16") : setRatio(event.target.value as AspectRatio)}><option value="16:9">Landscape · 16:9</option>{mode === "image" ? <option value="1:1">Square · 1:1</option> : null}<option value="9:16">Portrait · 9:16</option>{mode === "image" ? <><option value="4:3">Classic · 4:3</option><option value="3:4">Tall · 3:4</option></> : null}</select></label>
            {mode === "video" ? <label className={styles.field}>Quality<select className={styles.select} value={resolution} onChange={(event) => setResolution(event.target.value as typeof resolution)}><option value="360p">360p · compact</option><option value="720p">720p · larger</option></select></label> : null}
          </div> : null}
          <div className={styles.actions}><button type="button" className={styles.primaryButton} onClick={() => void runMediaRequest()} disabled={Boolean(runDisabledReason)} aria-describedby="visual-run-help">{working ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : result ? <RefreshCw size={16} aria-hidden="true" /> : mode === "clip" ? <Clapperboard size={16} aria-hidden="true" /> : <WandSparkles size={16} aria-hidden="true" />}{working ? pending.submission?.mode === "clip" ? "Creating clip…" : "Creating media…" : actionLabel(mode, operation, Boolean(result))}</button></div>
          <p id="visual-run-help" className={styles.supporting}>{runDisabledReason || (mode === "clip" ? "Clipping preserves the original video and available audio, and stores the selected segment as a new asset." : "This request uses the assigned media model and stores a new private asset.")}</p>
          {working && pending.submission ? <div className={styles.notice} role="status"><p>Submitted {pending.submission.mode} request in progress.</p><p className={styles.supporting}>Draft edits apply to your next request. Leaving this page does not confirm that server work has stopped.</p><SubmittedRequest submission={pending.submission} /></div> : null}
          {message ? <p role={message.tone === "error" ? "alert" : "status"} className={clsx(styles.notice, styles[message.tone === "error" ? "danger" : message.tone])}>{message.text}</p> : null}
        </div>
        <section className={styles.resultPane} aria-labelledby="media-result-title" aria-busy={working || saving}>
          <h3 id="media-result-title" className={styles.itemTitle}>Last created result</h3>
          {result ? <>
            <p className={styles.supporting}>{working ? "The previous stored result remains below while the next request runs." : "This result belongs to the submitted request below. Editing the draft does not change it."}</p>
            <PrivateMediaPreview key={result.identity.request} assetId={result.asset.id} kind={result.kind} alt={`${result.operation} result: ${result.prompt}`} className={styles.preview} mediaClassName={styles.resultMedia} onReadinessChange={handleResultReadiness} />
            <dl className={styles.metadata} data-testid="visual-result-details">
              <div><dt>File</dt><dd>{result.asset.filename}</dd></div>
              <div><dt>Asset ID</dt><dd><code className={styles.identity}>{result.asset.id}</code></dd></div>
              <div><dt>Stored file</dt><dd>{formatBytes(result.asset.byteCount)} · {result.kind} · {result.operation}</dd></div>
              <div><dt>Preview</dt><dd>{resultReadiness === "ready" ? "Ready" : resultReadiness === "failed" ? "Unavailable" : "Verifying stored file"}</dd></div>
              <div><dt>Model / processor</dt><dd><code className={styles.identity}>{result.model}</code>{result.provider ? <span className={styles.supporting}>{result.provider}</span> : null}</dd></div>
            </dl>
            <details className={styles.details} open data-testid="visual-submitted-request"><summary>Submitted request</summary><SubmittedRequest submission={result.submission} /></details>
            <div className={styles.actions}>
              {resultReadiness === "ready" && !busy ? <a href={privateCaptureAssetContentUrl(result.asset.id, { download: true })} className={styles.button}><Download size={16} aria-hidden="true" />Download</a> : <button type="button" className={styles.button} disabled aria-describedby="visual-save-help"><Download size={16} aria-hidden="true" />Download</button>}
              <button type="button" className={styles.primaryButton} disabled={Boolean(saveReason)} aria-describedby="visual-save-help" onClick={() => void saveToKnowledge()}>{saving ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : indexingAccepted ? <CheckCircle2 size={16} aria-hidden="true" /> : <Sparkles size={16} aria-hidden="true" />}{saving ? "Requesting indexing…" : indexingAccepted ? jobStatusLabel(receipt.status) : receipt ? "Retry indexing" : "Save to knowledge"}</button>
            </div>
            <p id="visual-save-help" className={styles.supporting}>{saveReason || "Save to knowledge requests indexing of this exact stored asset."}</p>
            {receipt ? <div className={styles.receipt}><p className={styles.supporting}>Indexing receipt: {jobStatusLabel(receipt.status)}</p><code className={styles.identity}>{receipt.id}</code>{receipt.lastError ? <p className={styles.dangerText}>{receipt.lastError}</p> : null}</div> : null}
          </> : <div className={styles.empty}><p className={styles.itemTitle}>{working ? "Waiting for the submitted result" : "No result created here yet"}</p><p className={styles.reading}>Create from a prompt, edit a private source, or clip a video. Your stored output and its submitted details will appear here.</p></div>}
        </section>
      </div>
    </section>
  );
}

function ReadStatus({ label, read, loading }: { label: string; read: ReadState; loading: boolean }) {
  if (!loading && read.loaded && !read.error) return null;
  return <p className={clsx(styles.readStatus, read.error && styles.dangerText)} role={read.error ? "alert" : "status"}>{label}: {loading ? read.loaded ? "refreshing; last-loaded details are shown." : "loading…" : read.loaded ? "refresh unavailable; last-loaded details are shown." : "unavailable."}{read.error ? ` ${read.error}` : ""}</p>;
}

function RouteStatus({ label, route, read, loading }: { label: string; route?: MediaRoute; read: ReadState; loading: boolean }) {
  const current = read.loaded && !read.error;
  const state = !current ? read.loaded ? "Last-loaded configuration; unverified" : loading ? "Checking configuration" : "Configuration unavailable" : route?.configured === false ? "Needs setup" : route?.configured === true ? "Configured" : "Route unavailable";
  return <div className={styles.route}><span className={styles.routeLabel}>{label}: {state}</span>{route?.provider || route?.model ? <span className={styles.identity}>{[route.provider, route.model].filter(Boolean).join(" · ")}</span> : null}</div>;
}

function ModeButton({ active, disabled, onClick, icon: Icon, label }: { active: boolean; disabled: boolean; onClick: () => void; icon: typeof ImageIcon; label: string }) {
  return <button type="button" aria-pressed={active} disabled={disabled} onClick={onClick} className={styles.modeButton}><Icon size={16} aria-hidden="true" />{label}</button>;
}

function TimeField({ label, value, onChange, invalid }: { label: string; value: string; onChange: (value: string) => void; invalid: boolean }) {
  return <label className={styles.field}>{label}<input className={styles.input} type="number" min="0" max="86400" step="0.1" value={value} onChange={(event) => onChange(event.target.value)} aria-invalid={invalid || undefined} aria-describedby={invalid ? "visual-run-help" : undefined} /></label>;
}

function SubmittedRequest({ submission }: { submission: Submission }) {
  return <dl className={styles.submitted}>
    <div><dt>Operation</dt><dd>{submission.mode} · {submission.operation}</dd></div>
    {submission.mode !== "clip" ? <div><dt>Submitted prompt</dt><dd className={styles.reading}>{submission.prompt}</dd></div> : null}
    <div><dt>Submitted source</dt><dd>{submission.sourceAssetId ? <>{submission.sourceFilename || "Source metadata unavailable"}<code className={styles.identity}>{submission.sourceAssetId}</code></> : "No source asset"}</dd></div>
    {submission.mode === "clip" ? <div><dt>Submitted range</dt><dd>{submission.startSeconds}–{submission.endSeconds} seconds</dd></div> : <div><dt>Submitted canvas</dt><dd>{submission.aspectRatio}{submission.resolution ? ` · ${submission.resolution}` : ""}</dd></div>}
  </dl>;
}

function sameSubmittedInputs(left: Submission, right: Submission) {
  return left.mode === right.mode && left.operation === right.operation && left.sourceAssetId === right.sourceAssetId && (left.mode === "clip" ? left.startSeconds === right.startSeconds && left.endSeconds === right.endSeconds : left.prompt === right.prompt && left.aspectRatio === right.aspectRatio && left.resolution === right.resolution);
}

function actionLabel(mode: StudioMode, operation: string, again: boolean) {
  if (again) return "Create another";
  return mode === "clip" ? "Create clip" : operation === "edit" ? `Edit ${mode}` : `Create ${mode}`;
}

function jobStatusLabel(status: CaptureJob["status"]) {
  return { queued: "Queued for indexing", running: "Indexing in progress", completed: "Indexing completed", failed: "Indexing failed", canceled: "Indexing canceled" }[status];
}

function promptPlaceholder(mode: StudioMode, operation: string) {
  if (operation === "edit") return "Describe the changes and what should stay the same…";
  return mode === "video" ? "Describe the subject, motion, camera, lighting, and audio…" : "Describe the subject, composition, lighting, and intended use…";
}

function mediaFailureMessage(message?: string, category?: string, suggestion?: string) {
  const guidance = category === "configuration" ? "Assign and validate a compatible media model in Settings." : category === "permission" ? "Check model access and billing in Settings." : category === "quota" ? "Try again after media capacity becomes available." : undefined;
  return [...new Set([message, suggestion, guidance].filter(Boolean))].join(" ") || "The assigned media model could not complete this request.";
}

function formatSeconds(seconds: number) {
  if (!Number.isFinite(seconds)) return "unknown";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function formatBytes(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.ceil(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
