"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AudioLines, Loader2, Mic, RotateCcw, Square, X } from "lucide-react";
import { clsx } from "clsx";

type VoicePhase =
  | "idle"
  | "requesting"
  | "recording"
  | "finishing"
  | "transcribing"
  | "starting"
  | "error";

const restingMeter = [0.18, 0.28, 0.42, 0.24, 0.52, 0.34, 0.62, 0.3, 0.48, 0.24, 0.16];

export function VoiceMode({
  disabled,
  disabledReason,
  onTranscript,
}: {
  disabled?: boolean;
  disabledReason?: string;
  onTranscript: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("idle");
  const [error, setError] = useState("");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [meterLevels, setMeterLevels] = useState(restingMeter);
  const [transcriptPreview, setTranscriptPreview] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const transcriptionControllerRef = useRef<AbortController | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const recordingStartedAtRef = useRef(0);
  const sessionTokenRef = useRef(0);
  const canceledRef = useRef(false);
  const mountedRef = useRef(true);

  const stopMedia = useCallback(() => {
    if (meterFrameRef.current !== null) {
      window.cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close().catch(() => undefined);
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  }, []);

  const cancelVoice = useCallback(() => {
    sessionTokenRef.current += 1;
    canceledRef.current = true;
    transcriptionControllerRef.current?.abort();
    transcriptionControllerRef.current = null;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
    stopMedia();
    chunksRef.current = [];
    setOpen(false);
    setPhase("idle");
    setError("");
    setTranscriptPreview("");
    setMeterLevels(restingMeter);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [stopMedia]);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
      sessionTokenRef.current += 1;
      canceledRef.current = true;
      transcriptionControllerRef.current?.abort();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }
      stopMedia();
      chunksRef.current = [];
    };
  }, [stopMedia]);

  useEffect(() => {
    if (phase !== "recording") return;
    const updateElapsed = () => {
      setElapsedSeconds(Math.max(0, Math.floor((Date.now() - recordingStartedAtRef.current) / 1_000)));
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => primaryActionRef.current?.focus(), 0);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        cancelVoice();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      );
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    };
  }, [cancelVoice, open]);

  function startMeter(stream: MediaStream) {
    try {
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.78;
      context.createMediaStreamSource(stream).connect(analyser);
      audioContextRef.current = context;
      const frequencies = new Uint8Array(analyser.frequencyBinCount);
      const draw = () => {
        analyser.getByteFrequencyData(frequencies);
        const levels = restingMeter.map((resting, index) => {
          const from = Math.floor((index / restingMeter.length) * frequencies.length);
          const to = Math.max(from + 1, Math.floor(((index + 1) / restingMeter.length) * frequencies.length));
          let total = 0;
          for (let position = from; position < to; position += 1) total += frequencies[position];
          return Math.max(resting, Math.min(1, total / (to - from) / 118));
        });
        if (mountedRef.current) setMeterLevels(levels);
        meterFrameRef.current = window.requestAnimationFrame(draw);
      };
      draw();
    } catch {
      setMeterLevels(restingMeter);
    }
  }

  function failVoice(message: string, token: number) {
    if (!mountedRef.current || token !== sessionTokenRef.current) return;
    canceledRef.current = true;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    stopMedia();
    chunksRef.current = [];
    setPhase("error");
    setError(message);
    setMeterLevels(restingMeter);
  }

  async function transcribeAudio(blob: Blob, token: number) {
    if (!blob.size) {
      failVoice("No audio was captured. Check your microphone and try again.", token);
      return;
    }
    const controller = new AbortController();
    transcriptionControllerRef.current = controller;
    setPhase("transcribing");
    const form = new FormData();
    const type = blob.type || "audio/webm";
    form.set("audio", new File([blob], `voice-message.${audioExtension(type)}`, { type }));
    try {
      const response = await fetch("/api/capture/transcribe", {
        method: "POST",
        body: form,
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(String(body.error || "Your voice message could not be transcribed."));
      }
      const transcript = String(body.text || "").trim();
      if (!transcript) {
        throw new Error("No speech was recognized. Nothing was sent.");
      }
      if (!mountedRef.current || token !== sessionTokenRef.current || canceledRef.current) return;
      setTranscriptPreview(transcript);
      setPhase("starting");
      onTranscript(transcript);
      window.setTimeout(() => {
        if (!mountedRef.current || token !== sessionTokenRef.current) return;
        setOpen(false);
        setPhase("idle");
        setTranscriptPreview("");
        window.requestAnimationFrame(() => triggerRef.current?.focus());
      }, 650);
    } catch (transcriptionError) {
      if (controller.signal.aborted || token !== sessionTokenRef.current) return;
      failVoice(
        transcriptionError instanceof Error
          ? transcriptionError.message
          : "Your voice message could not be transcribed.",
        token,
      );
    } finally {
      if (transcriptionControllerRef.current === controller) {
        transcriptionControllerRef.current = null;
      }
    }
  }

  async function startRecording() {
    if (disabled) return;
    const token = sessionTokenRef.current + 1;
    sessionTokenRef.current = token;
    canceledRef.current = false;
    setOpen(true);
    setPhase("requesting");
    setError("");
    setTranscriptPreview("");
    setElapsedSeconds(0);
    setMeterLevels(restingMeter);
    chunksRef.current = [];

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      failVoice("Voice mode is not supported by this browser.", token);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      if (!mountedRef.current || token !== sessionTokenRef.current || canceledRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      const mimeType = preferredRecordingType();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data);
      };
      recorder.onerror = () => failVoice("Recording was interrupted. Nothing was sent.", token);
      recorder.onstop = () => {
        const shouldDiscard = canceledRef.current || token !== sessionTokenRef.current;
        const chunks = chunksRef.current;
        chunksRef.current = [];
        const recordedType = recorder.mimeType || mimeType || "audio/webm";
        stopMedia();
        if (mountedRef.current) setMeterLevels(restingMeter);
        if (shouldDiscard) return;
        void transcribeAudio(new Blob(chunks, { type: recordedType }), token);
      };
      startMeter(stream);
      recorder.start(500);
      recordingStartedAtRef.current = Date.now();
      setPhase("recording");
    } catch (recordingError) {
      failVoice(microphoneErrorMessage(recordingError), token);
    }
  }

  function finishRecording() {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    setPhase("finishing");
    recorder.stop();
  }

  const status = voiceStatus(phase, elapsedSeconds, error);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => void startRecording()}
        disabled={disabled}
        title={disabledReason || (disabled ? "Voice mode is unavailable while work is active." : "Start voice mode")}
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        aria-label="Start voice mode"
        aria-haspopup="dialog"
      >
        <AudioLines size={17} aria-hidden="true" />
      </button>

      {open ? (
        <div className="fixed inset-0 z-[130] grid place-items-end bg-foreground/45 p-0 backdrop-blur-md sm:place-items-center sm:p-6">
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="voice-mode-title"
            aria-describedby="voice-mode-status voice-mode-detail"
            className="relative flex min-h-[31rem] w-full max-w-lg flex-col overflow-hidden rounded-t-[2rem] border border-line/80 bg-background shadow-2xl outline-none sm:min-h-[34rem] sm:rounded-[2rem]"
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_50%_-15%,color-mix(in_oklab,var(--color-primary)_24%,transparent),transparent_68%)]" />
            <header className="relative flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
                <Mic size={14} className="text-primary" aria-hidden="true" />
                <span id="voice-mode-title">Voice mode</span>
              </div>
              <button
                type="button"
                onClick={cancelVoice}
                className="grid size-10 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground"
                aria-label={phase === "starting" ? "Return to conversation" : "Cancel voice mode"}
              >
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className="relative flex flex-1 flex-col items-center justify-center px-6 pb-4 text-center">
              <div
                className={clsx(
                  "relative grid size-44 place-items-center rounded-full border transition-all duration-500 sm:size-48",
                  phase === "recording"
                    ? "border-primary/35 bg-primary/10 shadow-[0_0_70px_color-mix(in_oklab,var(--color-primary)_26%,transparent)]"
                    : "border-line bg-surface",
                )}
                aria-hidden="true"
              >
                <div className="flex h-24 items-center gap-1.5">
                  {meterLevels.map((level, index) => (
                    <span
                      key={index}
                      className={clsx(
                        "w-1.5 rounded-full transition-[height,opacity] duration-100",
                        phase === "recording" ? "bg-primary opacity-90" : "bg-muted/45 opacity-55",
                      )}
                      style={{ height: `${Math.round(12 + level * 66)}px` }}
                    />
                  ))}
                </div>
                {phase === "recording" ? <span className="absolute inset-2 animate-ping rounded-full border border-primary/20" /> : null}
                {["requesting", "finishing", "transcribing"].includes(phase) ? (
                  <span className="absolute inset-0 grid place-items-center rounded-full bg-background/72 backdrop-blur-sm">
                    <Loader2 size={30} className="animate-spin text-primary" />
                  </span>
                ) : null}
                {phase === "error" ? (
                  <span className="absolute inset-0 grid place-items-center rounded-full bg-background/80">
                    <Mic size={30} className="text-danger" />
                  </span>
                ) : null}
              </div>

              <p id="voice-mode-status" className="mt-8 text-lg font-semibold tracking-tight">
                {status.title}
              </p>
              <p id="voice-mode-detail" className={clsx("mt-2 max-w-sm text-sm leading-6", phase === "error" ? "text-danger" : "text-muted")}>{status.detail}</p>
              <p role="status" aria-live="polite" className="sr-only">{voiceAnnouncement(phase, error)}</p>
              {transcriptPreview ? (
                <p className="mt-4 line-clamp-3 max-w-sm rounded-xl bg-surface px-4 py-3 text-left text-sm leading-6 text-foreground">
                  “{transcriptPreview}”
                </p>
              ) : null}
            </div>

            <footer className="relative flex min-h-24 items-center justify-center gap-3 border-t border-line/70 bg-surface/65 px-5 py-4">
              {phase === "recording" ? (
                <>
                  <button type="button" onClick={cancelVoice} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">
                    Cancel
                  </button>
                  <button
                    ref={primaryActionRef}
                    type="button"
                    onClick={finishRecording}
                    className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90"
                  >
                    <Square size={14} fill="currentColor" aria-hidden="true" />
                    Finish &amp; send
                  </button>
                </>
              ) : phase === "error" ? (
                <>
                  <button type="button" onClick={cancelVoice} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">
                    Close
                  </button>
                  <button
                    ref={primaryActionRef}
                    type="button"
                    onClick={() => void startRecording()}
                    className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90"
                  >
                    <RotateCcw size={15} aria-hidden="true" />
                    Try again
                  </button>
                </>
              ) : (
                <button
                  ref={primaryActionRef}
                  type="button"
                  onClick={cancelVoice}
                  className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground"
                >
                  {phase === "starting" ? "Return to conversation" : "Cancel"}
                </button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

function preferredRecordingType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
}

function audioExtension(type: string) {
  if (type.includes("mp4")) return "m4a";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("mpeg")) return "mp3";
  if (type.includes("wav")) return "wav";
  return "webm";
}

function microphoneErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return "Microphone access is blocked. Allow it in your browser settings, then try again.";
    }
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") {
      return "No available microphone was found.";
    }
    if (error.name === "NotReadableError" || error.name === "AbortError") {
      return "Your microphone is busy or could not be started.";
    }
  }
  return "The microphone could not be started. Nothing was sent.";
}

function voiceStatus(phase: VoicePhase, elapsedSeconds: number, error: string) {
  if (phase === "requesting") return { title: "Allow microphone access", detail: "Voice stays on this device until you finish recording." };
  if (phase === "recording") return { title: formatDuration(elapsedSeconds), detail: "Listening now. Finish when your message is complete." };
  if (phase === "finishing") return { title: "Finishing recording", detail: "Securing the last words before transcription." };
  if (phase === "transcribing") return { title: "Transcribing", detail: "Turning your voice into a message. It has not been sent yet." };
  if (phase === "starting") return { title: "Message understood", detail: "Fresh context is being prepared and your task is starting." };
  if (phase === "error") return { title: "Voice mode needs attention", detail: error || "Nothing was sent." };
  return { title: "Voice mode", detail: "Speak naturally, then finish to send." };
}

function voiceAnnouncement(phase: VoicePhase, error: string) {
  if (phase === "requesting") return "Waiting for microphone permission.";
  if (phase === "recording") return "Recording started.";
  if (phase === "finishing") return "Recording stopped.";
  if (phase === "transcribing") return "Transcription in progress. Nothing has been sent yet.";
  if (phase === "starting") return "Transcription complete. The task is starting with fresh context.";
  if (phase === "error") return error || "Voice mode encountered an error. Nothing was sent.";
  return "Voice mode ready.";
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}
