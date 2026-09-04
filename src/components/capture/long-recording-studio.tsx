"use client";

import {
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Clock3,
  Copy,
  Headphones,
  Loader2,
  Mic,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { clsx } from "clsx";

type RecordingStatus = "recording" | "processing" | "ready" | "failed";

type RecordingSummary = {
  id: string;
  title: string;
  status: RecordingStatus;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  segmentCount: number;
  updatedAt: string;
  detailAvailable: boolean;
  manageable: boolean;
};

type RecordingSegment = {
  id: string;
  segmentIndex: number;
  durationMs: number;
  transcript: string;
  transcriptionStatus: "pending" | "completed" | "failed";
};

type RecordingDetail = Omit<
  RecordingSummary,
  "detailAvailable" | "manageable"
> & {
  byteCount: number;
  transcript: string;
  segments: RecordingSegment[];
};

type RecordingPhase =
  | "idle"
  | "requesting"
  | "recording"
  | "paused"
  | "stopping"
  | "indexing"
  | "complete"
  | "error";

type Props = {
  disabledReason?: string;
  onJob?: (job: {
    id: string;
    status: "queued" | "running" | "completed" | "failed" | "canceled";
    progress?: Record<string, unknown>;
    lastError?: string;
  }) => void;
  onIndexed?: () => Promise<void> | void;
};

const segmentDurationMs = 60_000;

export function LongRecordingStudio({ disabledReason, onJob, onIndexed }: Props) {
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [recordingId, setRecordingId] = useState<string>();
  const [title, setTitle] = useState("");
  const [tags, setTags] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [uploadedSegments, setUploadedSegments] = useState(0);
  const [pendingSegments, setPendingSegments] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [error, setError] = useState<string>();
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [viewingRecording, setViewingRecording] = useState<RecordingDetail>();
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [visibleSegments, setVisibleSegments] = useState(8);

  const recorderRef = useRef<MediaRecorder | undefined>(undefined);
  const streamRef = useRef<MediaStream | undefined>(undefined);
  const audioContextRef = useRef<AudioContext | undefined>(undefined);
  const meterFrameRef = useRef<number | undefined>(undefined);
  const timerRef = useRef<number | undefined>(undefined);
  const startedAtRef = useRef(0);
  const pausedAtRef = useRef(0);
  const totalPausedMsRef = useRef(0);
  const segmentStartedAtRef = useRef(0);
  const segmentIndexRef = useRef(0);
  const uploadQueueRef = useRef<Promise<void>>(Promise.resolve());
  const uploadErrorRef = useRef<Error | undefined>(undefined);
  const stopResolverRef = useRef<(() => void) | undefined>(undefined);
  const discardRef = useRef(false);

  const loadRecordings = useCallback(async () => {
    setLoadingRecordings(true);
    try {
      const response = await fetch(
        "/api/capture/recordings?limit=6&ownerScope=readable",
        {
        cache: "no-store",
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        recordings?: RecordingSummary[];
      };
      if (response.ok) {
        setRecordings(Array.isArray(payload.recordings) ? payload.recordings : []);
      }
    } finally {
      setLoadingRecordings(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRecordings(), 0);
    return () => window.clearTimeout(timer);
  }, [loadRecordings]);

  useEffect(() => () => {
    stopLocalMedia();
  }, []);

  useEffect(() => {
    if (!viewingRecording) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setViewingRecording(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [viewingRecording]);

  async function startRecording() {
    let createdRecordingId: string | undefined;
    setError(undefined);
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser cannot record audio. Try a current version of Chrome, Safari, or Edge.");
      return;
    }

    setPhase("requesting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;
      const response = await fetch("/api/capture/recordings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: title.trim() || `Conversation · ${new Date().toLocaleDateString()}`,
          language: "en-US",
          tags: splitTags(tags),
          metadata: { captureMode: "long_conversation" },
        }),
      });
      const payload = (await response.json().catch(() => ({}))) as {
        recording?: { id: string };
        error?: string;
      };
      const createdId = payload.recording?.id;
      if (!response.ok || !createdId) {
        throw new Error(payload.error || "The recording could not be started.");
      }
      createdRecordingId = createdId;

      const mimeType = preferredAudioMimeType();
      const recorder = new MediaRecorder(stream, {
        ...(mimeType ? { mimeType } : {}),
        audioBitsPerSecond: 64_000,
      });
      recorderRef.current = recorder;
      setRecordingId(createdId);
      setLiveTranscript("");
      setUploadedSegments(0);
      setPendingSegments(0);
      setElapsedMs(0);
      segmentIndexRef.current = 0;
      uploadQueueRef.current = Promise.resolve();
      uploadErrorRef.current = undefined;
      discardRef.current = false;
      startedAtRef.current = Date.now();
      segmentStartedAtRef.current = Date.now();
      totalPausedMsRef.current = 0;

      recorder.ondataavailable = (event) => {
        if (!event.data.size || discardRef.current) return;
        const index = segmentIndexRef.current++;
        const durationMs = Math.max(1, Date.now() - segmentStartedAtRef.current);
        segmentStartedAtRef.current = Date.now();
        queueSegment(createdId, index, durationMs, event.data);
      };
      recorder.onstop = () => {
        stopResolverRef.current?.();
        stopResolverRef.current = undefined;
      };
      recorder.onerror = () => {
        uploadErrorRef.current = new Error("The browser stopped the recording unexpectedly.");
        setError(uploadErrorRef.current.message);
        setPhase("error");
      };

      startMeter(stream);
      timerRef.current = window.setInterval(() => {
        const paused = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
        setElapsedMs(Date.now() - startedAtRef.current - totalPausedMsRef.current - paused);
      }, 250);
      recorder.start(segmentDurationMs);
      setPhase("recording");
    } catch (startError) {
      stopLocalMedia();
      if (createdRecordingId) {
        void fetch(`/api/capture/recordings/${encodeURIComponent(createdRecordingId)}`, { method: "DELETE" }).catch(() => undefined);
      }
      setError(startError instanceof Error ? startError.message : "Microphone access was not granted.");
      setPhase("error");
    }
  }

  function queueSegment(id: string, index: number, durationMs: number, blob: Blob) {
    setPendingSegments((current) => current + 1);
    uploadQueueRef.current = uploadQueueRef.current
      .then(async () => {
        const result = await uploadSegment(id, index, durationMs, blob);
        setUploadedSegments((current) => current + 1);
        if (result.transcript) {
          setLiveTranscript((current) =>
            current ? `${current}\n\n${result.transcript}` : result.transcript,
          );
        }
      })
      .catch((segmentError) => {
        uploadErrorRef.current = segmentError instanceof Error
          ? segmentError
          : new Error("A recording segment could not be stored.");
        setError(uploadErrorRef.current.message);
      })
      .finally(() => setPendingSegments((current) => Math.max(0, current - 1)));
  }

  function pauseRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    recorder.requestData();
    recorder.pause();
    pausedAtRef.current = Date.now();
    setPhase("paused");
  }

  function resumeRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "paused") return;
    totalPausedMsRef.current += Date.now() - pausedAtRef.current;
    pausedAtRef.current = 0;
    segmentStartedAtRef.current = Date.now();
    recorder.resume();
    setPhase("recording");
  }

  async function finishRecording() {
    const recorder = recorderRef.current;
    const id = recordingId;
    if (!recorder || !id || !["recording", "paused"].includes(recorder.state)) return;
    setPhase("stopping");
    setError(undefined);
    if (recorder.state === "paused") {
      totalPausedMsRef.current += Date.now() - pausedAtRef.current;
      pausedAtRef.current = 0;
      recorder.resume();
    }
    const stopped = new Promise<void>((resolve) => {
      stopResolverRef.current = resolve;
    });
    recorder.stop();
    await stopped;
    stopLocalMedia();
    await uploadQueueRef.current;
    if (uploadErrorRef.current) {
      setPhase("error");
      return;
    }

    setPhase("indexing");
    try {
      const response = await fetch(`/api/capture/recordings/${encodeURIComponent(id)}/complete`, {
        method: "POST",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
      const payload = (await response.json().catch(() => ({}))) as {
        job?: {
          id: string;
          status?: "queued" | "running" | "completed" | "failed" | "canceled";
          progress?: Record<string, unknown>;
          lastError?: string;
        };
        error?: string;
      };
      if (!response.ok) throw new Error(payload.error || "The conversation could not be prepared for indexing.");
      if (payload.job?.id) onJob?.({ ...payload.job, status: payload.job.status || "queued" });
      setPhase("complete");
      await loadRecordings();
      await onIndexed?.();
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : "The conversation could not be indexed.");
      setPhase("error");
    }
  }

  async function discardRecording() {
    const id = recordingId;
    discardRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      const stopped = new Promise<void>((resolve) => {
        stopResolverRef.current = resolve;
      });
      recorder.stop();
      await stopped;
    }
    stopLocalMedia();
    await uploadQueueRef.current;
    if (id) await fetch(`/api/capture/recordings/${encodeURIComponent(id)}`, { method: "DELETE" });
    resetDraft();
    await loadRecordings();
  }

  async function deleteRecording(id: string) {
    const response = await fetch(`/api/capture/recordings/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    if (response.ok) await loadRecordings();
  }

  async function openRecording(id: string) {
    setLoadingDetail(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/capture/recordings/${encodeURIComponent(id)}`, { cache: "no-store" });
      const payload = (await response.json().catch(() => ({}))) as { recording?: RecordingDetail; error?: string };
      if (!response.ok || !payload.recording) throw new Error(payload.error || "The recording could not be opened.");
      setVisibleSegments(8);
      setViewingRecording(payload.recording);
    } catch (detailError) {
      setError(detailError instanceof Error ? detailError.message : "The recording could not be opened.");
    } finally {
      setLoadingDetail(false);
    }
  }

  async function copyTranscript() {
    if (!viewingRecording?.transcript) return;
    await navigator.clipboard.writeText(viewingRecording.transcript);
  }

  function downloadTranscript() {
    if (!viewingRecording?.transcript) return;
    const url = URL.createObjectURL(new Blob([viewingRecording.transcript], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${safeDownloadName(viewingRecording.title)}.txt`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  function resetDraft() {
    stopLocalMedia();
    setPhase("idle");
    setRecordingId(undefined);
    setElapsedMs(0);
    setUploadedSegments(0);
    setPendingSegments(0);
    setLiveTranscript("");
    setTitle("");
    setTags("");
    setError(undefined);
  }

  function startMeter(stream: MediaStream) {
    const AudioContextConstructor = window.AudioContext;
    if (!AudioContextConstructor) return;
    const context = new AudioContextConstructor();
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    context.createMediaStreamSource(stream).connect(analyser);
    audioContextRef.current = context;
    const samples = new Uint8Array(analyser.frequencyBinCount);
    const draw = () => {
      analyser.getByteFrequencyData(samples);
      const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
      setLevel(Math.min(1, average / 92));
      meterFrameRef.current = window.requestAnimationFrame(draw);
    };
    draw();
  }

  function stopLocalMedia() {
    if (timerRef.current) window.clearInterval(timerRef.current);
    if (meterFrameRef.current) window.cancelAnimationFrame(meterFrameRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    void audioContextRef.current?.close().catch(() => undefined);
    timerRef.current = undefined;
    meterFrameRef.current = undefined;
    streamRef.current = undefined;
    audioContextRef.current = undefined;
    recorderRef.current = undefined;
    setLevel(0);
  }

  const active = ["requesting", "recording", "paused", "stopping", "indexing"].includes(phase);

  return (
    <div className="grid gap-6 2xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="min-w-0 border-t border-line pt-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-end">
          <label className="min-w-0 flex-1 text-xs font-semibold text-muted">
            Conversation title
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              disabled={active}
              maxLength={240}
              placeholder="Weekly project review"
              className="mt-2 w-full rounded-md border border-line bg-background px-3 py-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
            />
          </label>
          <label className="min-w-0 flex-1 text-xs font-semibold text-muted">
            Tags
            <input
              value={tags}
              onChange={(event) => setTags(event.target.value)}
              disabled={active}
              placeholder="meeting, research, project"
              className="mt-2 w-full rounded-md border border-line bg-background px-3 py-3 text-sm text-foreground outline-none focus:border-primary disabled:opacity-60"
            />
          </label>
        </div>

        <div className="mt-5 overflow-hidden rounded-xl border border-line bg-background">
          <div className="flex min-h-48 flex-col items-center justify-center px-5 py-7 text-center">
            <div className={clsx(
              "relative grid size-20 place-items-center rounded-full border transition-colors",
              phase === "recording" ? "border-danger/50 bg-danger/10 text-danger" : "border-line bg-surface-raised text-primary",
            )}>
              {phase === "requesting" || phase === "stopping" || phase === "indexing" ? (
                <Loader2 size={30} className="animate-spin" aria-hidden="true" />
              ) : phase === "complete" ? (
                <CheckCircle2 size={31} aria-hidden="true" />
              ) : (
                <Mic size={31} aria-hidden="true" />
              )}
              {phase === "recording" ? <span className="absolute inset-[-9px] rounded-full border border-danger/25" aria-hidden="true" /> : null}
            </div>
            <p className="mt-4 text-xl font-semibold tracking-tight">
              {recordingPhaseTitle(phase)}
            </p>
            <p className="mt-1 max-w-xl text-sm leading-6 text-muted">
              {phase === "idle" || phase === "error"
                ? "Record for up to 24 hours. Audio is saved in private one-minute segments, transcribed as you speak, then indexed as searchable context."
                : phase === "complete"
                  ? "The transcript is queued for RAG indexing and linked memory."
                  : `${formatDuration(elapsedMs)} · ${uploadedSegments} stored${pendingSegments ? ` · ${pendingSegments} uploading` : ""}`}
            </p>
            {phase === "recording" || phase === "paused" ? (
              <div className="mt-4 flex h-8 w-full max-w-sm items-end justify-center gap-1" aria-label="Microphone level">
                {Array.from({ length: 24 }, (_, index) => {
                  const threshold = index / 28;
                  return <span key={index} className={clsx("w-1 rounded-full transition-all", level > threshold && phase === "recording" ? "bg-primary" : "bg-line")} style={{ height: `${8 + ((index * 11) % 22)}px` }} />;
                })}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 border-t border-line bg-surface px-4 py-3">
            {!active && phase !== "complete" ? (
              <button type="button" onClick={() => void startRecording()} className="primary-button" disabled={Boolean(disabledReason)} title={disabledReason}>
                <Mic size={16} aria-hidden="true" />Start long recording
              </button>
            ) : null}
            {phase === "recording" ? (
              <button type="button" onClick={pauseRecording} className="action-button"><CirclePause size={16} aria-hidden="true" />Pause</button>
            ) : null}
            {phase === "paused" ? (
              <button type="button" onClick={resumeRecording} className="action-button"><CirclePlay size={16} aria-hidden="true" />Resume</button>
            ) : null}
            {phase === "recording" || phase === "paused" ? (
              <button type="button" onClick={() => void finishRecording()} className="primary-button"><Square size={14} aria-hidden="true" />Finish and index</button>
            ) : null}
            {active && phase !== "indexing" ? (
              <button type="button" onClick={() => void discardRecording()} className="action-button text-danger"><Trash2 size={15} aria-hidden="true" />Discard</button>
            ) : null}
            {phase === "complete" || phase === "error" ? (
              <button type="button" onClick={resetDraft} className="action-button"><RotateCcw size={15} aria-hidden="true" />New recording</button>
            ) : null}
          </div>
        </div>

        {error ? <p role="alert" className="mt-3 text-sm text-danger">{error}</p> : null}
        {liveTranscript ? (
          <div className="mt-5 border-l-2 border-primary pl-4">
            <div className="flex items-center gap-2 text-xs font-semibold text-muted"><Headphones size={14} aria-hidden="true" />Live transcript</div>
            <p className="mt-2 whitespace-pre-wrap text-sm leading-7 text-foreground">{liveTranscript}</p>
          </div>
        ) : null}
      </div>

      <aside className="border-t border-line pt-5 2xl:border-l 2xl:border-t-0 2xl:pl-6 2xl:pt-0" aria-label="Recent recordings">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-sm font-semibold">Recent recordings</p>
            <p className="mt-1 text-xs text-muted">Your recordings and retained history.</p>
          </div>
          {loadingRecordings ? <Loader2 size={16} className="animate-spin text-muted" aria-label="Loading recordings" /> : null}
        </div>
        <div className="mt-3 divide-y divide-line">
          {recordings.length ? recordings.map((recording) => (
            <div key={recording.id} className="group py-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{recording.title}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
                    <Clock3 size={12} aria-hidden="true" />
                    {formatDuration(recording.durationMs)} · {recording.segmentCount} segments
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  {recording.detailAvailable === true ? (
                    <button type="button" onClick={() => void openRecording(recording.id)} className="grid size-9 place-items-center rounded-md text-muted hover:bg-background hover:text-foreground" aria-label={`Open ${recording.title}`}>
                      {loadingDetail ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                    </button>
                  ) : null}
                  {recording.manageable === true && !disabledReason ? (
                    <button type="button" onClick={() => void deleteRecording(recording.id)} className="grid size-9 place-items-center rounded-md text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus:opacity-100" aria-label={`Delete ${recording.title}`}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
              <p className={clsx("mt-2 text-xs font-semibold", recording.status === "failed" ? "text-danger" : recording.status === "ready" ? "text-success" : "text-warning")}>{recordingStatusLabel(recording.status)}</p>
              {recording.detailAvailable !== true ? <p className="mt-1 text-xs text-muted">Retained history · transcript, audio, and actions remain with its stored owner</p> : null}
            </div>
          )) : <p className="py-5 text-sm leading-6 text-muted">Finished conversations will appear here with their indexing status.</p>}
        </div>
      </aside>

      {viewingRecording ? (
        <div className="fixed inset-0 z-50 grid place-items-center bg-background/75 p-3 backdrop-blur-sm sm:p-6" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setViewingRecording(undefined); }}>
          <section role="dialog" aria-modal="true" aria-labelledby="recording-detail-title" className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
            <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
              <div className="min-w-0"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Recorded conversation</p><h3 id="recording-detail-title" className="mt-1 truncate text-xl font-semibold">{viewingRecording.title}</h3><p className="mt-1 text-xs text-muted">{formatDuration(viewingRecording.durationMs)} · {viewingRecording.segmentCount} audio segments · {recordingStatusLabel(viewingRecording.status)}</p></div>
              <button type="button" onClick={() => setViewingRecording(undefined)} className="grid size-10 shrink-0 place-items-center rounded-md hover:bg-surface-raised" aria-label="Close recording"><X size={17} /></button>
            </header>
            <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1.3fr)_minmax(16rem,.7fr)]">
              <div className="p-5 sm:p-6">
                <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-semibold">Full transcript</h4><div className="flex gap-2"><button type="button" onClick={() => void copyTranscript()} className="action-button"><Copy size={14} />Copy</button><button type="button" onClick={downloadTranscript} className="action-button"><Headphones size={14} />Download text</button></div></div>
                <div className="mt-4 max-h-[58vh] overflow-y-auto whitespace-pre-wrap rounded-lg bg-background p-4 text-sm leading-7">{viewingRecording.transcript || "No completed transcript is available yet. Stored audio remains available by segment."}</div>
              </div>
              <aside className="border-t border-line p-5 lg:border-l lg:border-t-0 sm:p-6">
                <h4 className="font-semibold">Stored audio</h4>
                <p className="mt-1 text-xs leading-5 text-muted">Each segment is private and playable from your database-backed recording.</p>
                <div className="mt-4 space-y-3">
                  {viewingRecording.segments.slice(0, visibleSegments).map((segment) => (
                    <div key={segment.id} className="rounded-lg border border-line bg-background p-3"><div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold">Segment {segment.segmentIndex + 1}</span><span className="text-xs text-muted">{formatDuration(segment.durationMs)}</span></div><audio controls preload="none" className="mt-2 h-9 w-full" src={`/api/capture/recordings/${encodeURIComponent(viewingRecording.id)}/segments?audio=${segment.segmentIndex}`} /><p className={clsx("mt-2 text-xs", segment.transcriptionStatus === "failed" ? "text-danger" : "text-muted")}>{segment.transcriptionStatus === "completed" ? "Transcribed" : segment.transcriptionStatus === "failed" ? "Audio stored · transcription failed" : "Transcription pending"}</p></div>
                  ))}
                </div>
                {visibleSegments < viewingRecording.segments.length ? <button type="button" onClick={() => setVisibleSegments((current) => current + 8)} className="mt-4 action-button w-full justify-center">Show more segments</button> : null}
              </aside>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

async function uploadSegment(recordingId: string, index: number, durationMs: number, blob: Blob) {
  const form = new FormData();
  const extension = blob.type.includes("ogg") ? "ogg" : blob.type.includes("mp4") ? "m4a" : "webm";
  form.set("audio", new File([blob], `segment-${index}.${extension}`, { type: blob.type || "audio/webm" }));
  form.set("segmentIndex", String(index));
  form.set("durationMs", String(durationMs));
  const response = await fetch(`/api/capture/recordings/${encodeURIComponent(recordingId)}/segments`, {
    method: "POST",
    body: form,
    headers: { "idempotency-key": `${recordingId}:${index}` },
  });
  const payload = (await response.json().catch(() => ({}))) as {
    segment?: { transcript?: string };
    warning?: string;
    error?: string;
  };
  if (!response.ok) throw new Error(payload.error || `Audio segment ${index + 1} could not be stored.`);
  return { transcript: payload.segment?.transcript?.trim() || "", warning: payload.warning };
}

function preferredAudioMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type));
}

function splitTags(value: string) {
  return [...new Set(value.split(",").map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
}

function formatDuration(value: number) {
  const totalSeconds = Math.max(0, Math.floor(value / 1_000));
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function recordingPhaseTitle(phase: RecordingPhase) {
  if (phase === "requesting") return "Opening your microphone…";
  if (phase === "recording") return "Recording conversation";
  if (phase === "paused") return "Recording paused";
  if (phase === "stopping") return "Saving the final segment…";
  if (phase === "indexing") return "Preparing searchable context…";
  if (phase === "complete") return "Conversation saved";
  if (phase === "error") return "Recording needs attention";
  return "Record a long conversation";
}

function recordingStatusLabel(status: RecordingStatus) {
  if (status === "ready") return "Searchable in Command";
  if (status === "processing") return "Indexing";
  if (status === "failed") return "Needs attention";
  return "Recording in progress";
}

function safeDownloadName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "recording-transcript";
}
