"use client";

import {
  CheckCircle2,
  ChevronRight,
  CirclePause,
  CirclePlay,
  Copy,
  Headphones,
  Loader2,
  Mic,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { clsx } from "clsx";
import type {
  CaptureRecordingStatus,
  RequestCaptureRecordingMetadataDetail,
  RequestCaptureRecordingSummary,
} from "@/lib/capture/types";
import styles from "./long-recording-studio.module.css";
import { createRecordingSelectionGate, createRecordingVisibilityEpoch, readRecordingMetadata, readRecordingPrivateDetail } from "./recording-selection";
import {
  createCaptureRecordingStartAttempt,
  startCaptureRecording,
  type CaptureRecordingStartAttempt,
} from "./long-recording-start";

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

export type LongRecordingDraft = {
  title: string;
  tags: string;
  deleteRawAudioAfterProcessing: boolean;
};

type RecordingDraftProps = {
  draft: LongRecordingDraft;
  onDraftChange: Dispatch<SetStateAction<LongRecordingDraft>>;
} | {
  draft?: undefined;
  onDraftChange?: undefined;
};

type Props = RecordingDraftProps & {
  requestedRecordingId?: string | null;
  readEnabled?: boolean;
  requestOwner?: { tenantId: string; actorId: string };
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

export function captureRawAudioRetentionPreference(deleteAfterProcessing: boolean) {
  return {
    mode: deleteAfterProcessing
      ? "delete_after_processing" as const
      : "retain" as const,
  };
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

export function LongRecordingStudio({ disabledReason, onJob, onIndexed, draft, onDraftChange, requestedRecordingId, readEnabled = true, requestOwner }: Props) {
  const [phase, setPhase] = useState<RecordingPhase>("idle");
  const [recordingId, setRecordingId] = useState<string>();
  const [localDraft, setLocalDraft] = useState<LongRecordingDraft>({
    title: "",
    tags: "",
    deleteRawAudioAfterProcessing: false,
  });
  const { title, tags, deleteRawAudioAfterProcessing } = draft ?? localDraft;
  const setRecordingDraft = onDraftChange ?? setLocalDraft;
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [uploadedSegments, setUploadedSegments] = useState(0);
  const [pendingSegments, setPendingSegments] = useState(0);
  const [liveTranscript, setLiveTranscript] = useState("");
  const [error, setError] = useState<string>();
  const [cleanupWarning, setCleanupWarning] = useState<string>();
  const [recordings, setRecordings] = useState<RecordingSummary[]>([]);
  const [recordingsError, setRecordingsError] = useState<string>();
  const [loadingRecordings, setLoadingRecordings] = useState(true);
  const [recordingsLoaded, setRecordingsLoaded] = useState(false);
  const [viewingRecording, setViewingRecording] = useState<RecordingDetail>();
  const [viewingMetadataRecording, setViewingMetadataRecording] =
    useState<RecordingMetadataDetail>();
  const [loadingDetailId, setLoadingDetailId] = useState<string>();
  const [visibleSegments, setVisibleSegments] = useState(8);
  const [transcriptFeedback, setTranscriptFeedback] = useState<{
    message: string;
    failed: boolean;
  }>();
  const studioId = useId();

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
  const startAttemptRef = useRef<CaptureRecordingStartAttempt | null>(null);
  const mountedRef = useRef(true);

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
    if (!readEnabled) { setLoadingRecordings(false); return "failure"; }
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
      setRecordingsLoaded(true);
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
  }, [readEnabled, replaceRecordings]);

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

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      startAttemptRef.current?.cancel();
      startAttemptRef.current = null;
      stopLocalMedia();
    };
  }, [stopLocalMedia]);

  async function startRecording() {
    setError(undefined);
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setError("This browser cannot record audio. Try a current version of Chrome, Safari, or Edge.");
      return;
    }

    startAttemptRef.current?.cancel();
    stopLocalMedia();
    const attempt = createCaptureRecordingStartAttempt();
    startAttemptRef.current = attempt;
    setPhase("requesting");
    try {
      await startCaptureRecording({
        attempt,
        requestMicrophone: () => navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        }),
        createRecording: () => fetch("/api/capture/recordings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: title.trim() || `Conversation · ${new Date().toLocaleDateString()}`,
            language: "en-US",
            tags: splitTags(tags),
            metadata: { captureMode: "long_conversation" },
          }),
        }),
        discardRecording: async (id) => {
          const response = await fetch(`/api/capture/recordings/${encodeURIComponent(id)}`, {
            method: "DELETE",
            headers: { "idempotency-key": crypto.randomUUID() },
          });
          if (!response.ok) throw new Error("Recording cleanup could not be confirmed.");
        },
        onCleanupIssue: (message) => {
          if (mountedRef.current) setCleanupWarning(message);
        },
        activateRecorder: (stream, createdId) => {
          streamRef.current = stream;
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
          startedAtRef.current = Date.now();
          segmentStartedAtRef.current = Date.now();
          totalPausedMsRef.current = 0;

          recorder.ondataavailable = attempt.guard((event: BlobEvent) => {
            if (!event.data.size || discardRef.current) return;
            const index = segmentIndexRef.current++;
            const durationMs = Math.max(1, Date.now() - segmentStartedAtRef.current);
            segmentStartedAtRef.current = Date.now();
            queueSegment(createdId, index, durationMs, event.data);
          });
          recorder.onstop = () => {
            stopResolverRef.current?.();
            stopResolverRef.current = undefined;
          };
          recorder.onerror = attempt.guard(() => {
            uploadErrorRef.current = new Error("The browser stopped the recording unexpectedly.");
            setError(uploadErrorRef.current.message);
            setPhase("error");
          });

          startMeter(stream);
          timerRef.current = window.setInterval(attempt.guard(() => {
            const paused = pausedAtRef.current ? Date.now() - pausedAtRef.current : 0;
            setElapsedMs(Date.now() - startedAtRef.current - totalPausedMsRef.current - paused);
          }), 250);
          recorder.start(segmentDurationMs);
          setPhase("recording");
        },
      });
    } catch (startError) {
      if (!mountedRef.current || startAttemptRef.current !== attempt || !attempt.isCurrent()) return;
      attempt.cancel();
      stopLocalMedia();
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
        headers: {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        },
        body: JSON.stringify({
          rawAudioRetention: captureRawAudioRetentionPreference(
            deleteRawAudioAfterProcessing,
          ),
        }),
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
      if (!response.ok) throw new Error(payload.error || "The conversation could not be queued for processing.");
      if (payload.job?.id) onJob?.({ ...payload.job, status: payload.job.status || "queued" });
      setPhase("complete");
      await loadRecordings();
      await onIndexed?.();
    } catch (completeError) {
      setError(completeError instanceof Error ? completeError.message : "The conversation could not be queued for processing.");
      setPhase("error");
    }
  }

  async function discardRecording() {
    const id = recordingId;
    discardRef.current = true;
    startAttemptRef.current?.cancel();
    startAttemptRef.current = null;
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
    if (id) {
      await fetch(`/api/capture/recordings/${encodeURIComponent(id)}`, {
        method: "DELETE",
        headers: { "idempotency-key": crypto.randomUUID() },
      });
    }
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
      { method: "DELETE", headers: { "idempotency-key": crypto.randomUUID() } },
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
    setTranscriptFeedback(undefined);
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
    try {
      await navigator.clipboard.writeText(viewingRecording.transcript);
      setTranscriptFeedback({ message: "Transcript copied.", failed: false });
    } catch {
      setTranscriptFeedback({
        message: "The transcript could not be copied. You can select the text or download it instead.",
        failed: true,
      });
    }
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
    startAttemptRef.current?.cancel();
    startAttemptRef.current = null;
    stopLocalMedia();
    setPhase("idle");
    setRecordingId(undefined);
    setElapsedMs(0);
    setUploadedSegments(0);
    setPendingSegments(0);
    setLiveTranscript("");
    if (mountedRef.current) {
      setRecordingDraft({ title: "", tags: "", deleteRawAudioAfterProcessing: false });
    }
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
    <div className={styles.studio} data-testid="long-recording-studio">
      {requestedRecordingId === null ? <p role="alert" className={styles.error}>This recording link has an invalid identity.</p> : requestedRecordingId && readEnabled && requestOwner ?
        <ExactRecordingLink key={requestedRecordingId} id={requestedRecordingId} owner={requestOwner} /> : null}
      <div className={styles.layout}>
        <section className={styles.recorder} aria-label="Record a conversation">
          <div className={styles.fields}>
            <label className={styles.field}>
              Conversation title
              <input
                value={title}
                onChange={(event) => {
                  const value = event.target.value;
                  setRecordingDraft((current) => ({ ...current, title: value }));
                }}
                disabled={active}
                maxLength={240}
                placeholder="Weekly project review"
                className={styles.input}
              />
            </label>
            <div className={styles.field}>
              <label htmlFor={`${studioId}-tags`}>Tags</label>
              <input
                id={`${studioId}-tags`}
                value={tags}
                onChange={(event) => {
                  const value = event.target.value;
                  setRecordingDraft((current) => ({ ...current, tags: value }));
                }}
                disabled={active}
                placeholder="meeting, research, project"
                aria-describedby={`${studioId}-tags-help`}
                className={styles.input}
              />
              <span id={`${studioId}-tags-help`} className={styles.supporting}>Separate tags with commas.</span>
            </div>
          </div>

          <label className={styles.retention}>
            <input
              type="checkbox"
              checked={deleteRawAudioAfterProcessing}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setRecordingDraft((current) => ({ ...current, deleteRawAudioAfterProcessing: checked }));
              }}
              disabled={active}
              aria-labelledby={`${studioId}-retention-label`}
              aria-describedby={`${studioId}-retention-help`}
              className={styles.checkbox}
            />
            <span>
              <strong id={`${studioId}-retention-label`}>Delete raw audio after processing</strong>
              <span id={`${studioId}-retention-help`} className={styles.supporting}>The timestamped transcript and cited outputs are kept. Original audio segments are deleted only after every transcript checkpoint succeeds.</span>
            </span>
          </label>
          {active ? <p className={styles.supporting}>Title, tags, and audio retention are fixed for this recording.</p> : null}

          <div className={styles.stage}>
            <div className={styles.phaseHeader}>
              <span className={clsx(styles.phaseIcon, phase === "recording" && styles.recordingIcon)}>
                {phase === "requesting" || phase === "stopping" || phase === "indexing" ? (
                  <Loader2 size={24} className={styles.spinner} aria-hidden="true" />
                ) : phase === "complete" ? (
                  <CheckCircle2 size={24} aria-hidden="true" />
                ) : (
                  <Mic size={24} aria-hidden="true" />
                )}
              </span>
              <div className={styles.phaseText}>
                <h3 className={styles.sectionTitle} aria-live="polite">{recordingPhaseTitle(phase)}</h3>
                <p className={styles.reading}>{recordingPhaseDescription(phase)}</p>
              </div>
            </div>

            {phase !== "idle" && phase !== "requesting" ? (
              <dl className={styles.counters}>
                <div><dt>Recorded time</dt><dd>{formatDuration(elapsedMs)}</dd></div>
                <div><dt>Segments uploaded</dt><dd>{uploadedSegments}</dd></div>
                <div><dt>Uploads pending</dt><dd>{pendingSegments}</dd></div>
              </dl>
            ) : null}
            {recordingId ? <p className={styles.identity}>Session ID: {recordingId}</p> : null}

            {phase === "recording" || phase === "paused" ? (
              <div className={styles.meterRow}>
                <label htmlFor={`${studioId}-level`} className={styles.supporting}>
                  {phase === "paused" ? "Recording paused" : "Microphone level"}
                </label>
                <meter
                  id={`${studioId}-level`}
                  className={styles.meter}
                  min={0}
                  max={1}
                  value={phase === "recording" ? level : 0}
                  aria-label="Microphone level"
                />
              </div>
            ) : null}

            <div className={styles.actions}>
              {!active && phase !== "complete" ? (
                <button
                  type="button"
                  onClick={() => void startRecording()}
                  className={styles.primaryButton}
                  disabled={Boolean(disabledReason)}
                  aria-describedby={`${studioId}-consent${disabledReason ? ` ${studioId}-permission` : ""}`}
                >
                  <Mic size={16} aria-hidden="true" />Start long recording
                </button>
              ) : null}
              {phase === "recording" ? (
                <button type="button" onClick={pauseRecording} className={styles.button}><CirclePause size={16} aria-hidden="true" />Pause</button>
              ) : null}
              {phase === "paused" ? (
                <button type="button" onClick={resumeRecording} className={styles.button}><CirclePlay size={16} aria-hidden="true" />Resume</button>
              ) : null}
              {phase === "recording" || phase === "paused" ? (
                <button type="button" onClick={() => void finishRecording()} className={styles.primaryButton}><Square size={16} aria-hidden="true" />Finish and process</button>
              ) : null}
              {active && phase !== "indexing" ? (
                <button type="button" onClick={() => void discardRecording()} className={clsx(styles.button, styles.dangerButton)}><Trash2 size={16} aria-hidden="true" />Discard</button>
              ) : null}
              {phase === "complete" || phase === "error" ? (
                <button type="button" onClick={resetDraft} className={styles.button}><RotateCcw size={16} aria-hidden="true" />New recording</button>
              ) : null}
            </div>
            <p id={`${studioId}-consent`} className={styles.supporting}>Starting asks for microphone permission. Record only with everyone’s consent. Keep this page open while recording and uploading.</p>
            {disabledReason ? <p id={`${studioId}-permission`} className={styles.permission}>{disabledReason}</p> : null}
          </div>

          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
          {cleanupWarning ? <p role="alert" className={styles.error}>{cleanupWarning}</p> : null}
          {liveTranscript ? (
            <section className={styles.liveTranscript} aria-label="Transcript received so far">
              <h4 className={styles.itemTitle}><Headphones size={16} aria-hidden="true" />Transcript received so far</h4>
              <p className={styles.transcript}>{liveTranscript}</p>
            </section>
          ) : null}
        </section>

        <aside className={styles.history} aria-label="Recent recordings">
          <div className={styles.sectionHeader}>
            <div>
              <h3 className={styles.sectionTitle}>Recent recordings</h3>
              <p className={styles.supporting}>Up to six recent recordings and retained history.</p>
            </div>
            <button type="button" className={styles.button} onClick={() => void loadRecordings()} disabled={loadingRecordings} aria-label="Refresh recording history">
              <RotateCcw size={16} aria-hidden="true" />Refresh
            </button>
          </div>
          <p className={styles.readStatus} role="status">
            {loadingRecordings
              ? recordingsLoaded ? "Refreshing recording history and access… Any rows below are from the last successful snapshot." : "Loading recording history…"
              : recordingsError
                ? recordingsLoaded ? "History could not be refreshed. Any rows below are from the last successful snapshot." : "Recording history is unavailable."
                : "Recording history snapshot. Refresh to check the latest status."}
          </p>
          {recordingsError ? (
            <p role="alert" className={styles.error}>
              {recordingsError} Recording details and actions are unavailable until history is verified.
            </p>
          ) : null}
          {loadingDetailId ? <p className={styles.readStatus} role="status">Opening recording details…</p> : null}
          <div className={styles.recordingList} aria-busy={loadingRecordings}>
            {recordings.map((recording) => (
              <article key={recording.id} className={styles.recordingRow} data-recording-id={recording.id}>
                <div className={styles.rowHeader}>
                  <h4 className={styles.itemTitle}>{recording.title}</h4>
                  <div className={styles.rowActions}>
                    {captureRecordingOpenMode(recording) ? (
                      <button type="button" onClick={() => void openRecording(recording.id)} className={styles.iconButton} aria-label={`Open ${recording.title}`}>
                        {loadingDetailId === recording.id ? <Loader2 size={16} className={styles.spinner} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
                      </button>
                    ) : null}
                    {captureRecordingCanDelete(recording, disabledReason) ? (
                      <button type="button" onClick={() => void deleteRecording(recording.id)} className={clsx(styles.iconButton, styles.dangerButton)} aria-label={`Delete ${recording.title}`}>
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                </div>
                <p className={styles.identity}>Session ID: {recording.id}</p>
                <p className={styles.supporting}>{formatDuration(recording.durationMs)} · {recording.segmentCount} segments</p>
                <p className={clsx(styles.status, recording.status === "failed" ? styles.dangerText : recording.status === "ready" ? styles.successText : styles.supporting)}>{recordingStatusLabel(recording.status)}</p>
                <p className={styles.supporting}>Updated {formatDateTime(recording.updatedAt)}</p>
                {loadingRecordings ? (
                  <p className={styles.supporting}>Refreshing recording access… Details and actions are unavailable during this check.</p>
                ) : recordingsError ? (
                  <p className={styles.supporting}>Recording access is not currently verified.</p>
                ) : recording.metadataDetailAvailable === true && recording.detailAvailable !== true ? (
                  <p className={styles.supporting}>Retained history · recording and segment metadata are available read only. Transcript, audio, and actions remain with the stored owner.</p>
                ) : recording.detailAvailable !== true ? (
                  <p className={styles.supporting}>Retained history · transcript, audio, and actions remain with the stored owner.</p>
                ) : recording.manageable !== true ? (
                  <p className={styles.supporting}>This recording can be read but cannot be deleted by this session.</p>
                ) : disabledReason ? (
                  <p className={styles.supporting}>Delete is unavailable: {disabledReason}</p>
                ) : null}
              </article>
            ))}
            {!recordings.length && recordingsLoaded && !loadingRecordings && !recordingsError ? (
              <p className={styles.empty}>No recordings are available in this history yet. Saved conversations will appear here with their processing status.</p>
            ) : null}
          </div>
        </aside>
      </div>

      {viewingRecording ? (
        <RecordingDialog labelledBy={`${studioId}-detail-title`} onClose={() => setViewingRecording(undefined)}>
          <header className={styles.dialogHeader}>
            <div>
              <p className={styles.supporting}>Recorded conversation</p>
              <h3 id={`${studioId}-detail-title`} className={styles.dialogTitle}>{viewingRecording.title}</h3>
              <p className={styles.identity}>Session ID: {viewingRecording.id}</p>
              <p className={styles.supporting}>{formatDuration(viewingRecording.durationMs)} · {viewingRecording.segmentCount} audio segments · {recordingStatusLabel(viewingRecording.status)}</p>
              <p className={styles.supporting}>Updated {formatDateTime(viewingRecording.updatedAt)}</p>
            </div>
            <button type="button" onClick={() => setViewingRecording(undefined)} className={styles.iconButton} aria-label="Close recording"><X size={18} aria-hidden="true" /></button>
          </header>
          <div className={styles.dialogContent}>
            <section className={styles.transcriptSection} aria-label="Full transcript">
              <div className={styles.sectionHeader}>
                <h4 className={styles.itemTitle}>Full transcript</h4>
                <div className={styles.rowActions}>
                  <button type="button" onClick={() => void copyTranscript()} className={styles.button} disabled={!viewingRecording.transcript}><Copy size={16} aria-hidden="true" />Copy</button>
                  <button type="button" onClick={downloadTranscript} className={styles.button} disabled={!viewingRecording.transcript}><Headphones size={16} aria-hidden="true" />Download text</button>
                </div>
              </div>
              {transcriptFeedback ? <p role={transcriptFeedback.failed ? "alert" : "status"} className={transcriptFeedback.failed ? styles.error : styles.readStatus}>{transcriptFeedback.message}</p> : null}
              {viewingRecording.transcript ? (
                <p className={styles.transcript}>{viewingRecording.transcript}</p>
              ) : (
                <p className={styles.empty}>No completed transcript is available yet. Copy and text download become available when transcript text is returned.</p>
              )}
            </section>
            <section className={styles.segmentSection} aria-label="Audio segments">
              <h4 className={styles.itemTitle}>Audio segments</h4>
              <p className={styles.supporting}>Playback is available while the original audio is retained and this session can access it.</p>
              {viewingRecording.segments.length ? (
                <div className={styles.segmentList}>
                  {viewingRecording.segments.slice(0, visibleSegments).map((segment) => (
                    <RecordingAudioSegment key={segment.id} recordingId={viewingRecording.id} segment={segment} />
                  ))}
                </div>
              ) : <p className={styles.empty}>No audio segments were returned for this recording.</p>}
              {visibleSegments < viewingRecording.segments.length ? (
                <button type="button" onClick={() => setVisibleSegments((current) => current + 8)} className={styles.button}>Show more segments</button>
              ) : null}
            </section>
          </div>
        </RecordingDialog>
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

function subscribeRecordingVisibility(listener: () => void) {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}
function ExactRecordingLink({ id, owner }: { id: string; owner: { tenantId: string; actorId: string } }) {
  const [gate] = useState(createRecordingSelectionGate);
  const [visibilitySource] = useState(createRecordingVisibilityEpoch);
  const visibilitySnapshot = useCallback(() => visibilitySource.read(document.visibilityState !== "hidden"), [visibilitySource]);
  const visibility = useSyncExternalStore(subscribeRecordingVisibility, visibilitySnapshot, visibilitySource.server);
  const visible = visibility.visible;
  const [revision, setRevision] = useState(0);
  const [readState, setRead] = useState<{ visibilityEpoch: number; metadata?: RecordingMetadataDetail; privateDetail?: RecordingDetail; error?: string; pendingPrivate?: boolean; privateError?: string }>();
  const read = readState?.visibilityEpoch === visibility.epoch ? readState : undefined;
  const [closed, setClosed] = useState(false);
  const [visibleSegments, setVisibleSegments] = useState(8);
  const [copyFeedback, setCopyFeedback] = useState<string>();
  const openRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  useLayoutEffect(() => () => gate.clear(), [gate, id, owner.tenantId, owner.actorId]);
  useEffect(() => {
    if (!visible) { gate.clear(); return; }
    const token = gate.begin(id);
    const timer = window.setTimeout(async () => {
      setRead(undefined); setCopyFeedback(undefined); setVisibleSegments(8);
      try {
        const response = await fetch(`/api/capture/recordings/${encodeURIComponent(id)}?ownerScope=readable`, { cache: "no-store", signal: token.controller.signal });
        const value: unknown = await response.json();
        if (!gate.current(token) || document.visibilityState === "hidden") return;
        if (!response.ok) throw new Error(response.status === 403 || response.status === 404 ? "This exact recording is no longer readable." : "Recording metadata could not be loaded.");
        setRead({ visibilityEpoch: visibility.epoch, metadata: readRecordingMetadata(value, id) });
      } catch (error) {
        if (gate.current(token) && document.visibilityState !== "hidden") setRead({ visibilityEpoch: visibility.epoch, error: error instanceof Error ? error.message : "Recording metadata could not be loaded." });
      }
    }, 0);
    return () => { window.clearTimeout(timer); gate.clear(); };
  }, [gate, id, owner.tenantId, owner.actorId, revision, visible, visibility.epoch]);

  async function openPrivate() {
    const metadata = read?.metadata;
    if (!metadata?.transcriptAvailable || read?.pendingPrivate || !visible || closed) return;
    const token = gate.begin(id);
    setRead({ visibilityEpoch: visibility.epoch, metadata, pendingPrivate: true });
    try {
      const response = await fetch(`/api/capture/recordings/${encodeURIComponent(id)}`, { cache: "no-store", signal: token.controller.signal });
      const value = await response.json();
      if (!gate.current(token) || document.visibilityState === "hidden") return;
      if (!response.ok) throw new Error("The owner-authorized recording content is unavailable. Metadata remains a separate read.");
      setRead({ visibilityEpoch: visibility.epoch, metadata, privateDetail: readRecordingPrivateDetail(value, metadata, owner) });
    } catch (error) {
      if (gate.current(token) && document.visibilityState !== "hidden") setRead({ visibilityEpoch: visibility.epoch, metadata, privateError: error instanceof Error ? error.message : "Private recording content is unavailable." });
    }
  }
  function close() {
    gate.clear(); setClosed(true); setRead((current) => current?.metadata ? { visibilityEpoch: current.visibilityEpoch, metadata: current.metadata } : current);
    window.requestAnimationFrame(() => { if (document.activeElement === document.body) openRef.current?.focus({ preventScroll: true }); });
  }
  async function copyTranscript() {
    const detail = read?.privateDetail;
    if (!detail?.transcript) return;
    const token = gate.begin(id);
    try { await navigator.clipboard.writeText(detail.transcript); if (gate.current(token)) setCopyFeedback("Transcript copied."); }
    catch { if (gate.current(token)) setCopyFeedback("Transcript could not be copied. Select the full text below."); }
  }
  const metadata = visible ? read?.metadata : undefined;
  const detail = read?.privateDetail;
  return <section className={styles.linkedRecording} aria-label="Linked recording">
    <div className={styles.sectionHeader}><div><h3 className={styles.sectionTitle}>Linked recording</h3><p className={styles.identity}>{id}</p></div>
      <button ref={openRef} type="button" className={styles.button} onClick={() => { setClosed(false); setRevision((current) => current + 1); }}>{read?.error ? "Retry exact recording" : closed ? "Open linked recording metadata" : "Refresh exact recording"}</button></div>
    <p className={styles.supporting}>This exact source opens independently of the six most recent recordings.</p>
    {!read && visible ? <p role="status" className={styles.readStatus}>Opening exact recording metadata…</p> : null}
    {read?.error ? <p role="alert" className={styles.error}>{read.error}</p> : null}
    {metadata && !closed ? <RecordingDialog labelledBy={headingId} onClose={close}>
      <header className={styles.dialogHeader}><div><p className={styles.supporting}>{metadata.transcriptAvailable ? "Recording metadata" : "Retained recording metadata"}</p><h3 id={headingId} className={styles.dialogTitle}>{metadata.metadataAvailable ? metadata.title : "Recording metadata unavailable"}</h3><p className={styles.identity}>Session ID: {metadata.id}</p></div><button type="button" className={styles.iconButton} aria-label="Close linked recording" onClick={close}><X size={18} aria-hidden="true" /></button></header>
      <div className={styles.metadataContent}>
        <p className={styles.reading}>{metadata.transcriptAvailable ? "Private transcript and audio require a separate current owner-authorized read." : "Read-only retained history. Transcript, audio and management remain with the stored owner."}</p>
        {metadata.metadataAvailable ? <dl className={styles.metadata}><MetadataValue label="Status" value={recordingStatusLabel(metadata.status)} /><MetadataValue label="Updated" value={metadata.updatedAt} /><MetadataValue label="Started" value={metadata.startedAt} /><MetadataValue label="Duration" value={formatDuration(metadata.durationMs)} /><MetadataValue label="Stored bytes" value={String(metadata.byteCount)} /><MetadataValue label="Segments" value={String(metadata.segmentCount)} /></dl> : <p className={styles.empty}>Recording metadata and counts are unavailable to this request actor.</p>}
        {metadata.transcriptAvailable && !detail ? <button type="button" className={styles.button} disabled={read?.pendingPrivate} onClick={() => void openPrivate()}>{read?.pendingPrivate ? "Reading private recording…" : "Read private transcript and audio"}</button> : null}
        {read?.privateError ? <p role="alert" className={styles.error}>{read.privateError}</p> : null}
        {detail ? <section aria-label="Linked recording transcript"><div className={styles.sectionHeader}><h4 className={styles.itemTitle}>Full transcript</h4><button type="button" className={styles.button} disabled={!detail.transcript} onClick={() => void copyTranscript()}>Copy linked transcript</button></div>{copyFeedback ? <p role="status">{copyFeedback}</p> : null}<p className={styles.transcript}>{detail.transcript || "No completed transcript was returned."}</p></section> : null}
        <section className={styles.retainedSegments} aria-label="Linked recording segments"><h4 className={styles.itemTitle}>{detail ? "Owner recording segments" : "Segment metadata"}</h4>
          {!metadata.segmentMetadataAvailable ? <p className={styles.empty}>Segment metadata is unavailable.</p> : metadata.segments.length === 0 ? <p className={styles.empty}>No segments were returned for this recording.</p> : <div className={styles.segmentList}>{detail ? detail.segments.slice(0, visibleSegments).map((segment) => <RecordingAudioSegment key={segment.id} recordingId={id} segment={segment} />) : metadata.segments.slice(0, visibleSegments).map((segment) => <article key={segment.id} className={styles.segment}><h5 className={styles.rowTitle}>Segment {segment.segmentIndex + 1}</h5><p className={styles.identity}>{segment.id}</p><p>{formatDuration(segment.durationMs)} · {formatByteCount(segment.byteCount)} · {recordingTranscriptionStatusLabel(segment.transcriptionStatus)}</p></article>)}</div>}
          {visibleSegments < (detail?.segments.length ?? metadata.segments.length) ? <button type="button" className={styles.button} onClick={() => setVisibleSegments((current) => current + 8)}>Show more linked segments</button> : null}
        </section>
      </div>
    </RecordingDialog> : null}
  </section>;
}

function RecordingDialog({ labelledBy, onClose, children }: {
  labelledBy: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
      document.body.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className={styles.dialog}
      aria-labelledby={labelledBy}
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
      }}
    >
      {children}
    </dialog>
  );
}

function RecordingAudioSegment({ recordingId, segment }: { recordingId: string; segment: RecordingSegment }) {
  const [audioUnavailable, setAudioUnavailable] = useState(false);
  return (
    <article className={styles.segment}>
      <div className={styles.rowHeader}>
        <h5 className={styles.rowTitle}>Segment {segment.segmentIndex + 1}</h5>
        <p className={styles.supporting}>{formatDuration(segment.durationMs)}</p>
      </div>
      <p className={styles.identity}>Segment ID: {segment.id}</p>
      <audio
        controls
        preload="none"
        className={styles.audio}
        aria-label={`Audio for segment ${segment.segmentIndex + 1}`}
        src={`/api/capture/recordings/${encodeURIComponent(recordingId)}/segments?audio=${segment.segmentIndex}`}
        onError={() => setAudioUnavailable(true)}
      />
      {audioUnavailable ? <p role="alert" className={styles.error}>Audio could not be loaded. It may have been removed or may no longer be available to this session.</p> : null}
      <p className={clsx(styles.supporting, segment.transcriptionStatus === "failed" && styles.dangerText)}>{recordingTranscriptionStatusLabel(segment.transcriptionStatus)}</p>
    </article>
  );
}

export function RetainedRecordingMetadataDialog({ recording, onClose }: {
  recording: RecordingMetadataDetail;
  onClose: () => void;
}) {
  const [visibleSegments, setVisibleSegments] = useState(8);
  const metadataAvailable = recording.metadataAvailable === true;
  const segmentMetadataAvailable = recording.segmentMetadataAvailable === true;
  const titleId = useId();

  return (
    <RecordingDialog labelledBy={titleId} onClose={onClose}>
      <header className={styles.dialogHeader}>
        <div>
          <p className={styles.supporting}>Retained recording metadata</p>
          <h3 id={titleId} className={styles.dialogTitle}>{metadataAvailable ? recording.title : "Retained recording"}</h3>
          {metadataAvailable ? (
            <>
              <p className={styles.identity}>Session ID: {recording.id}</p>
              <p className={styles.supporting}>{formatDuration(recording.durationMs)} · {recording.segmentCount} segment summaries · {recordingStatusLabel(recording.status)}</p>
            </>
          ) : null}
        </div>
        <button type="button" onClick={onClose} className={styles.iconButton} aria-label="Close retained recording metadata"><X size={18} aria-hidden="true" /></button>
      </header>

      <div className={styles.metadataContent}>
        <div className={styles.retainedNotice}>
          <p className={styles.itemTitle}>Read-only retained history</p>
          <p className={styles.reading}>This session can inspect recording and segment metadata only. Transcript content, audio playback, and recording actions remain with the stored owner.</p>
        </div>
        {metadataAvailable ? (
          <dl className={styles.metadata}>
            <MetadataValue label="Started" value={formatDateTime(recording.startedAt)} />
            <MetadataValue label="Completed" value={recording.completedAt ? formatDateTime(recording.completedAt) : "Not completed"} />
            <MetadataValue label="Duration" value={formatDuration(recording.durationMs)} />
            <MetadataValue label="Stored size" value={formatByteCount(recording.byteCount)} />
            <MetadataValue label="Language" value={recording.language || "Not specified"} />
            <MetadataValue label="Tags" value={recording.tags.length ? recording.tags.join(" · ") : "None"} />
            <MetadataValue label="Updated" value={formatDateTime(recording.updatedAt)} />
          </dl>
        ) : (
          <p className={styles.empty}>Recording metadata is not available to this request actor.</p>
        )}

        <section className={styles.retainedSegments} aria-label="Segment summaries">
          <h4 className={styles.itemTitle}>Segment summaries</h4>
          <p className={styles.supporting}>Status, duration, size, and media type are shown without audio or transcript content.</p>
          {segmentMetadataAvailable ? (
            recording.segments.length ? (
              <>
                <div className={styles.segmentList}>
                  {recording.segments.slice(0, visibleSegments).map((segment) => (
                    <article key={segment.id} className={styles.segment}>
                      <div className={styles.rowHeader}>
                        <h5 className={styles.rowTitle}>Segment {segment.segmentIndex + 1}</h5>
                        <p className={styles.supporting}>{formatDuration(segment.durationMs)} · {formatByteCount(segment.byteCount)}</p>
                      </div>
                      <p className={styles.identity}>Segment ID: {segment.id}</p>
                      <p className={styles.supporting}>{segment.mimeType}</p>
                      <p className={clsx(styles.supporting, segment.transcriptionStatus === "failed" && styles.dangerText)}>{recordingTranscriptionStatusLabel(segment.transcriptionStatus)}</p>
                      <p className={styles.supporting}>Updated {formatDateTime(segment.updatedAt)}</p>
                    </article>
                  ))}
                </div>
                {visibleSegments < recording.segments.length ? (
                  <button type="button" onClick={() => setVisibleSegments((current) => current + 8)} className={styles.button}>Show more segment summaries</button>
                ) : null}
              </>
            ) : <p className={styles.empty}>No segment summaries are stored.</p>
          ) : <p className={styles.empty}>Segment metadata is not available to this request actor.</p>}
        </section>
      </div>
    </RecordingDialog>
  );
}

function MetadataValue({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
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
  if (phase === "requesting") return "Requesting microphone access…";
  if (phase === "recording") return "Recording conversation";
  if (phase === "paused") return "Recording paused";
  if (phase === "stopping") return "Saving the final segment…";
  if (phase === "indexing") return "Submitting recording for processing…";
  if (phase === "complete") return "Recording submitted";
  if (phase === "error") return "Recording needs attention";
  return "Record a long conversation";
}

function recordingPhaseDescription(phase: RecordingPhase) {
  if (phase === "requesting") return "Check your browser’s microphone prompt. Recording begins after permission is granted and the session is created.";
  if (phase === "recording") return "Your microphone is recording. Audio is uploaded in one-minute segments; transcription is a separate processing step.";
  if (phase === "paused") return "Recording is paused. Pending segments can still upload. Resume to continue, or finish to process the saved audio.";
  if (phase === "stopping") return "The microphone is stopping and pending audio segments are being uploaded. Keep this page open until the upload finishes.";
  if (phase === "indexing") return "Audio uploads have finished. Waiting for the server to accept the processing request.";
  if (phase === "complete") return "The server accepted the recording for processing. Check recording history and the processing summary for the latest status.";
  if (phase === "error") return "Review the error below. Uploaded segments and transcript availability can be checked in recording history.";
  return "Audio is saved in one-minute segments. Finish the recording to request transcription and indexing.";
}

function recordingStatusLabel(status: RecordingStatus) {
  if (status === "ready") return "Processing complete";
  if (status === "processing") return "Processing";
  if (status === "failed") return "Processing needs attention";
  return "Recording session open";
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
