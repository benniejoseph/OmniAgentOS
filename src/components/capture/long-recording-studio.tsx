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
import type {
  CaptureRecordingStatus,
  RequestCaptureRecordingMetadataDetail,
  RequestCaptureRecordingSummary,
} from "@/lib/capture/types";

type RecordingStatus = CaptureRecordingStatus;
type RecordingSummary = RequestCaptureRecordingSummary;
type RecordingMetadataDetail = RequestCaptureRecordingMetadataDetail;

type RecordingSegment = {
  id: string;
  segmentIndex: number;
  durationMs: number;
  transcript: string;
  transcriptionStatus: "pending" | "completed" | "failed";
};

type RecordingDetail = {
  id: string;
  title: string;
  status: RecordingStatus;
  startedAt: string;
  completedAt?: string;
  durationMs: number;
  segmentCount: number;
  updatedAt: string;
  byteCount: number;
  transcript: string;
  segments: RecordingSegment[];
};

type RecordingCollectionLoadResult = "success" | "failure" | "superseded";
export type RecordingOpenMode = "full" | "metadata";

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

export function captureRecordingOpenMode(
  recording: Pick<
    RecordingSummary,
    "detailAvailable" | "metadataDetailAvailable"
  > | undefined,
): RecordingOpenMode | undefined {
  if (recording?.detailAvailable === true) return "full";
  if (recording?.metadataDetailAvailable === true) return "metadata";
  return undefined;
}

export function captureRecordingCanDelete(
  recording: Pick<RecordingSummary, "manageable"> | undefined,
  disabledReason?: string,
) {
  return recording?.manageable === true && !disabledReason;
}

export function captureRecordingCollectionIsReadable(contract: unknown) {
  return contract === "readable_v1";
}

export function disableCaptureRecordingCapabilities(
  recordings: RecordingSummary[],
) {
  return recordings.map((recording) => ({
    ...recording,
    metadataDetailAvailable: false,
    detailAvailable: false,
    manageable: false,
  }));
}

export function captureRecordingRequestIsCurrent(
  currentController: AbortController | null,
  requestController: AbortController,
) {
  return currentController === requestController &&
    !requestController.signal.aborted;
}

export function captureRecordingMetadataDetailIsSafe(
  recording: unknown,
  expectedId: string,
  contract: unknown,
): recording is RecordingMetadataDetail {
  if (
    !captureRecordingCollectionIsReadable(contract) ||
    !isObject(recording) ||
    recording.id !== expectedId ||
    !isRecordingStatus(recording.status) ||
    typeof recording.title !== "string" ||
    typeof recording.language !== "string" ||
    !Array.isArray(recording.tags) ||
    !recording.tags.every((tag) => typeof tag === "string") ||
    typeof recording.startedAt !== "string" ||
    (recording.completedAt !== undefined &&
      typeof recording.completedAt !== "string") ||
    !isFiniteNumber(recording.durationMs) ||
    !isFiniteNumber(recording.byteCount) ||
    !isFiniteNumber(recording.segmentCount) ||
    typeof recording.createdAt !== "string" ||
    typeof recording.updatedAt !== "string" ||
    !Array.isArray(recording.segments) ||
    typeof recording.metadataAvailable !== "boolean" ||
    typeof recording.segmentMetadataAvailable !== "boolean" ||
    recording.transcriptAvailable !== false ||
    recording.audioAvailable !== false ||
    recording.manageable !== false
  ) {
    return false;
  }

  return recording.segments.every(isRecordingMetadataSegment);
}

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
  const [recordingsError, setRecordingsError] = useState<string>();
  const [loadingRecordings, setLoadingRecordings] = useState(false);
  const [viewingRecording, setViewingRecording] = useState<RecordingDetail>();
  const [viewingMetadataRecording, setViewingMetadataRecording] =
    useState<RecordingMetadataDetail>();
  const [loadingDetailId, setLoadingDetailId] = useState<string>();
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
  const recordingsRef = useRef<RecordingSummary[]>([]);
  const recordingsControllerRef = useRef<AbortController | null>(null);
  const detailControllerRef = useRef<AbortController | null>(null);

  const stopLocalMedia = useCallback(() => {
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
  }, []);

  const replaceRecordings = useCallback((nextRecordings: RecordingSummary[]) => {
    recordingsRef.current = nextRecordings;
    setRecordings(nextRecordings);
  }, []);

  const loadRecordings = useCallback(async (): Promise<RecordingCollectionLoadResult> => {
    recordingsControllerRef.current?.abort();
    const controller = new AbortController();
    recordingsControllerRef.current = controller;

    const detailController = detailControllerRef.current;
    if (detailController) {
      detailControllerRef.current = null;
      detailController.abort();
      setLoadingDetailId(undefined);
    }

    setViewingRecording(undefined);
    setViewingMetadataRecording(undefined);
    replaceRecordings(disableCaptureRecordingCapabilities(recordingsRef.current));
    setLoadingRecordings(true);
    setRecordingsError(undefined);
    try {
      const response = await fetch(
        "/api/capture/recordings?limit=6&ownerScope=readable",
        {
          cache: "no-store",
          signal: controller.signal,
        },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        recordings?: unknown;
        requestReadContracts?: { captureRecordings?: unknown };
        error?: string;
        message?: string;
      };

      if (!captureRecordingRequestIsCurrent(recordingsControllerRef.current, controller)) {
        return "superseded";
      }
      if (!response.ok) {
        throw new Error(payload.error || payload.message || "Recording history could not be refreshed.");
      }
      if (!captureRecordingCollectionIsReadable(
        payload.requestReadContracts?.captureRecordings,
      )) {
        throw new Error("Recording history ownership could not be verified.");
      }
      const nextRecordings = normalizeRecordingSummaries(payload.recordings);
      if (!nextRecordings) {
        throw new Error("Recording history returned an unsupported response.");
      }
      if (!captureRecordingRequestIsCurrent(recordingsControllerRef.current, controller)) {
        return "superseded";
      }
      replaceRecordings(nextRecordings);
      return "success";
    } catch (loadError) {
      if (!captureRecordingRequestIsCurrent(recordingsControllerRef.current, controller)) {
        return "superseded";
      }
      setRecordingsError(
        loadError instanceof Error
          ? loadError.message
          : "Recording history could not be refreshed.",
      );
      return "failure";
    } finally {
      if (recordingsControllerRef.current === controller) {
        recordingsControllerRef.current = null;
        setLoadingRecordings(false);
      }
    }
  }, [replaceRecordings]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadRecordings(), 0);
    return () => {
      window.clearTimeout(timer);
      const recordingsController = recordingsControllerRef.current;
      recordingsControllerRef.current = null;
      recordingsController?.abort();
      const detailController = detailControllerRef.current;
      detailControllerRef.current = null;
      detailController?.abort();
    };
  }, [loadRecordings]);

  useEffect(() => () => {
    stopLocalMedia();
  }, [stopLocalMedia]);

  const detailModalOpen = Boolean(viewingRecording || viewingMetadataRecording);

  useEffect(() => {
    if (!detailModalOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setViewingRecording(undefined);
        setViewingMetadataRecording(undefined);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("keydown", closeOnEscape);
      document.body.style.overflow = previousOverflow;
    };
  }, [detailModalOpen]);

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
      // This runs after a user-triggered async permission and API flow.
      // eslint-disable-next-line react-hooks/purity
      startedAtRef.current = Date.now();
      // eslint-disable-next-line react-hooks/purity
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
    const currentRecording = recordingsRef.current.find(
      (recording) => recording.id === id,
    );
    if (!captureRecordingCanDelete(currentRecording, disabledReason)) {
      setError(
        disabledReason ||
          "This recording is not currently manageable. Refresh recording history and try again.",
      );
      return;
    }

    setError(undefined);
    const response = await fetch(
      `/api/capture/recordings/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    const payload = (await response.json().catch(() => ({}))) as {
      error?: string;
      message?: string;
    };
    if (!response.ok) {
      setError(payload.error || payload.message || "The recording could not be deleted.");
      return;
    }
    await loadRecordings();
  }

  async function openRecording(id: string) {
    const requestedMode = captureRecordingOpenMode(
      recordingsRef.current.find((recording) => recording.id === id),
    );
    if (!requestedMode) {
      setError(
        "This recording detail is not currently available. Refresh recording history and try again.",
      );
      return;
    }

    detailControllerRef.current?.abort();
    const controller = new AbortController();
    detailControllerRef.current = controller;
    setLoadingDetailId(id);
    setError(undefined);
    setViewingRecording(undefined);
    setViewingMetadataRecording(undefined);
    try {
      const detailUrl = `/api/capture/recordings/${encodeURIComponent(id)}`;
      const response = await fetch(
        requestedMode === "metadata"
          ? `${detailUrl}?ownerScope=readable`
          : detailUrl,
        { cache: "no-store", signal: controller.signal },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        recording?: unknown;
        requestReadContracts?: { captureRecordingDetail?: unknown };
        error?: string;
        message?: string;
      };

      if (!captureRecordingRequestIsCurrent(detailControllerRef.current, controller)) {
        return;
      }
      if (!response.ok || !payload.recording) {
        throw new Error(
          payload.error || payload.message || "The recording could not be opened.",
        );
      }

      const currentMode = captureRecordingOpenMode(
        recordingsRef.current.find((recording) => recording.id === id),
      );
      if (currentMode !== requestedMode) return;

      if (requestedMode === "metadata") {
        if (!captureRecordingMetadataDetailIsSafe(
          payload.recording,
          id,
          payload.requestReadContracts?.captureRecordingDetail,
        )) {
          throw new Error("Retained recording metadata could not be verified.");
        }
        setViewingMetadataRecording(
          projectRecordingMetadataDetail(payload.recording),
        );
        return;
      }

      if (!isRecordingDetail(payload.recording, id)) {
        throw new Error("The recording returned an unsupported response.");
      }
      setVisibleSegments(8);
      setViewingRecording(payload.recording);
    } catch (detailError) {
      if (!captureRecordingRequestIsCurrent(detailControllerRef.current, controller)) {
        return;
      }
      setError(detailError instanceof Error ? detailError.message : "The recording could not be opened.");
    } finally {
      if (detailControllerRef.current === controller) {
        detailControllerRef.current = null;
        setLoadingDetailId(undefined);
      }
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
        {recordingsError ? (
          <p role="alert" className="mt-3 text-xs leading-5 text-danger">
            {recordingsError} Recording details and actions are unavailable until history is verified.
          </p>
        ) : null}
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
                  {captureRecordingOpenMode(recording) ? (
                    <button type="button" onClick={() => void openRecording(recording.id)} className="grid size-9 place-items-center rounded-md text-muted hover:bg-background hover:text-foreground" aria-label={`Open ${recording.title}`}>
                      {loadingDetailId === recording.id ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <ChevronRight size={15} aria-hidden="true" />}
                    </button>
                  ) : null}
                  {captureRecordingCanDelete(recording, disabledReason) ? (
                    <button type="button" onClick={() => void deleteRecording(recording.id)} className="grid size-9 place-items-center rounded-md text-muted opacity-0 transition hover:bg-danger/10 hover:text-danger group-hover:opacity-100 focus:opacity-100" aria-label={`Delete ${recording.title}`}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
              <p className={clsx("mt-2 text-xs font-semibold", recording.status === "failed" ? "text-danger" : recording.status === "ready" ? "text-success" : "text-warning")}>{recordingStatusLabel(recording.status)}</p>
              {loadingRecordings ? (
                <p className="mt-1 text-xs text-muted">Refreshing recording access…</p>
              ) : recordingsError ? (
                <p className="mt-1 text-xs text-muted">Recording access is not currently verified</p>
              ) : recording.metadataDetailAvailable === true && recording.detailAvailable !== true ? (
                <p className="mt-1 text-xs text-muted">Retained history · recording and segment metadata are available read only; transcript, audio, and actions remain with its stored owner</p>
              ) : recording.detailAvailable !== true ? (
                <p className="mt-1 text-xs text-muted">Retained history · transcript, audio, and actions remain with its stored owner</p>
              ) : null}
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
      {viewingMetadataRecording ? (
        <RetainedRecordingMetadataDialog
          recording={viewingMetadataRecording}
          onClose={() => setViewingMetadataRecording(undefined)}
        />
      ) : null}
    </div>
  );
}

export function RetainedRecordingMetadataDialog({
  recording,
  onClose,
}: {
  recording: RecordingMetadataDetail;
  onClose: () => void;
}) {
  const [visibleSegments, setVisibleSegments] = useState(8);
  const metadataAvailable = recording.metadataAvailable === true;
  const segmentMetadataAvailable =
    recording.segmentMetadataAvailable === true;

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-background/75 p-3 backdrop-blur-sm sm:p-6"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="retained-recording-detail-title"
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              Retained recording metadata
            </p>
            <h3
              id="retained-recording-detail-title"
              className="mt-1 truncate text-xl font-semibold"
            >
              {metadataAvailable ? recording.title : "Retained recording"}
            </h3>
            {metadataAvailable ? (
              <p className="mt-1 text-xs text-muted">
                {formatDuration(recording.durationMs)} · {recording.segmentCount} segment summaries · {recordingStatusLabel(recording.status)}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-10 shrink-0 place-items-center rounded-md hover:bg-surface-raised"
            aria-label="Close retained recording metadata"
          >
            <X size={17} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          <div className="rounded-lg border border-line bg-background p-4">
            <p className="text-sm font-semibold">Read-only retained history</p>
            <p className="mt-1 text-sm leading-6 text-muted">
              This session can inspect recording and segment metadata only. Transcript content, audio playback, and recording actions remain with the stored owner.
            </p>
          </div>

          {metadataAvailable ? (
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
              <MetadataValue label="Started" value={formatDateTime(recording.startedAt)} />
              <MetadataValue
                label="Completed"
                value={recording.completedAt ? formatDateTime(recording.completedAt) : "Not completed"}
              />
              <MetadataValue label="Duration" value={formatDuration(recording.durationMs)} />
              <MetadataValue label="Stored size" value={formatByteCount(recording.byteCount)} />
              <MetadataValue label="Language" value={recording.language || "Not specified"} />
              <MetadataValue
                label="Tags"
                value={recording.tags.length ? recording.tags.join(" · ") : "None"}
              />
            </dl>
          ) : (
            <p className="mt-5 text-sm text-muted">
              Recording metadata is not available to this request actor.
            </p>
          )}

          <div className="mt-6 border-t border-line pt-5">
            <h4 className="font-semibold">Segment summaries</h4>
            <p className="mt-1 text-xs leading-5 text-muted">
              Status, duration, size, and media type are shown without audio or transcript content.
            </p>
            {segmentMetadataAvailable ? (
              recording.segments.length ? (
                <div className="mt-4 space-y-3">
                  {recording.segments.slice(0, visibleSegments).map((segment) => (
                    <div
                      key={segment.id}
                      className="rounded-lg border border-line bg-background p-3"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-semibold">
                          Segment {segment.segmentIndex + 1}
                        </span>
                        <span className="text-xs text-muted">
                          {formatDuration(segment.durationMs)} · {formatByteCount(segment.byteCount)}
                        </span>
                      </div>
                      <p className="mt-2 text-xs text-muted">
                        {segment.mimeType} · {recordingTranscriptionStatusLabel(segment.transcriptionStatus)}
                      </p>
                      <p className="mt-1 text-xs text-muted">
                        Updated {formatDateTime(segment.updatedAt)}
                      </p>
                    </div>
                  ))}
                  {visibleSegments < recording.segments.length ? (
                    <button
                      type="button"
                      onClick={() => setVisibleSegments((current) => current + 8)}
                      className="action-button w-full justify-center"
                    >
                      Show more segment summaries
                    </button>
                  ) : null}
                </div>
              ) : (
                <p className="mt-4 text-sm text-muted">No segment summaries are stored.</p>
              )
            ) : (
              <p className="mt-4 text-sm text-muted">
                Segment metadata is not available to this request actor.
              </p>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function MetadataValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-semibold text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value}</dd>
    </div>
  );
}

function normalizeRecordingSummaries(
  value: unknown,
): RecordingSummary[] | undefined {
  if (!Array.isArray(value) || !value.every(isRecordingSummary)) {
    return undefined;
  }
  return value.map((recording) => ({
    id: recording.id,
    title: recording.title,
    status: recording.status,
    startedAt: recording.startedAt,
    ...(recording.completedAt ? { completedAt: recording.completedAt } : {}),
    durationMs: recording.durationMs,
    segmentCount: recording.segmentCount,
    updatedAt: recording.updatedAt,
    metadataDetailAvailable: recording.metadataDetailAvailable === true,
    detailAvailable: recording.detailAvailable === true,
    manageable: recording.manageable === true,
  }));
}

function isRecordingSummary(value: unknown): value is RecordingSummary {
  return isObject(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    isRecordingStatus(value.status) &&
    typeof value.startedAt === "string" &&
    (value.completedAt === undefined || typeof value.completedAt === "string") &&
    isFiniteNumber(value.durationMs) &&
    isFiniteNumber(value.segmentCount) &&
    typeof value.updatedAt === "string" &&
    typeof value.metadataDetailAvailable === "boolean" &&
    typeof value.detailAvailable === "boolean" &&
    typeof value.manageable === "boolean";
}

function isRecordingMetadataSegment(value: unknown) {
  return isObject(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.segmentIndex) &&
    typeof value.mimeType === "string" &&
    isFiniteNumber(value.durationMs) &&
    isFiniteNumber(value.byteCount) &&
    isTranscriptionStatus(value.transcriptionStatus) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string";
}

function projectRecordingMetadataDetail(
  recording: RecordingMetadataDetail,
): RecordingMetadataDetail {
  return {
    id: recording.id,
    title: recording.title,
    status: recording.status,
    language: recording.language,
    tags: [...recording.tags],
    startedAt: recording.startedAt,
    ...(recording.completedAt ? { completedAt: recording.completedAt } : {}),
    durationMs: recording.durationMs,
    byteCount: recording.byteCount,
    segmentCount: recording.segmentCount,
    createdAt: recording.createdAt,
    updatedAt: recording.updatedAt,
    segments: recording.segmentMetadataAvailable
      ? recording.segments.map((segment) => ({
          id: segment.id,
          segmentIndex: segment.segmentIndex,
          mimeType: segment.mimeType,
          durationMs: segment.durationMs,
          byteCount: segment.byteCount,
          transcriptionStatus: segment.transcriptionStatus,
          createdAt: segment.createdAt,
          updatedAt: segment.updatedAt,
        }))
      : [],
    metadataAvailable: recording.metadataAvailable === true,
    segmentMetadataAvailable: recording.segmentMetadataAvailable === true,
    transcriptAvailable: false,
    audioAvailable: false,
    manageable: false,
  };
}

function isRecordingDetail(
  value: unknown,
  expectedId: string,
): value is RecordingDetail {
  return isObject(value) &&
    value.id === expectedId &&
    typeof value.title === "string" &&
    isRecordingStatus(value.status) &&
    typeof value.startedAt === "string" &&
    (value.completedAt === undefined || typeof value.completedAt === "string") &&
    isFiniteNumber(value.durationMs) &&
    isFiniteNumber(value.segmentCount) &&
    typeof value.updatedAt === "string" &&
    isFiniteNumber(value.byteCount) &&
    typeof value.transcript === "string" &&
    Array.isArray(value.segments) &&
    value.segments.every(isRecordingDetailSegment);
}

function isRecordingDetailSegment(value: unknown) {
  return isObject(value) &&
    typeof value.id === "string" &&
    isFiniteNumber(value.segmentIndex) &&
    isFiniteNumber(value.durationMs) &&
    typeof value.transcript === "string" &&
    isTranscriptionStatus(value.transcriptionStatus);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isRecordingStatus(value: unknown): value is RecordingStatus {
  return value === "recording" ||
    value === "processing" ||
    value === "ready" ||
    value === "failed";
}

function isTranscriptionStatus(
  value: unknown,
): value is "pending" | "completed" | "failed" {
  return value === "pending" || value === "completed" || value === "failed";
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

function formatByteCount(value: number) {
  if (value < 1_024) return `${Math.max(0, Math.round(value))} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / 1_048_576).toFixed(1)} MB`;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
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

function recordingTranscriptionStatusLabel(
  status: "pending" | "completed" | "failed",
) {
  if (status === "completed") return "Transcription completed";
  if (status === "failed") return "Transcription failed";
  return "Transcription pending";
}

function safeDownloadName(value: string) {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "recording-transcript";
}
