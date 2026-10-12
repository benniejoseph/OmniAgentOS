"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AlertTriangle, AudioLines, Check, Loader2, Mic, MicOff, RotateCcw, Send, ShieldCheck, Square, X } from "lucide-react";
import { clsx } from "clsx";
import { CompanionAtlasPortrait, useCompanionAtlasPlayer } from "@/components/companion-atlas-player";
import { companionPresentation, companionWork } from "@/lib/companion/presentation";
import { requestCurrentMicrophone } from "./microphone-attempt";
import { ApprovalDecisionUnconfirmedError, postApprovalDecision, type ApprovalDecisionRequest } from "@/components/approvals/approval-decision";
import {
  applyRealtimeTranscriptEvent,
  closeRealtimeTranscript,
  editRealtimeTranscript,
  EMPTY_REALTIME_TRANSCRIPT,
  ignoreRealtimeTranscriptItem,
  realtimeTranscriptConfidence,
  realtimeTranscriptPending,
  realtimeTranscriptText,
  type RealtimeTranscriptState,
} from "@/lib/voice/realtime-transcript";
import { classifyRealtimeError, RealtimeConnectionError, realtimeConnectionFailure } from "@/lib/voice/realtime-error";
import { ReplyEchoGuard } from "@/lib/voice/reply-echo";
import {
  StreamingPcmPlayer,
  streamVersionedSpeech,
} from "@/lib/voice/pcm-player";
import {
  parseVoiceApprovalEvidence,
  type VoiceApprovalEvidence,
  type VoiceCommandReply,
  type VoiceCommandReview,
} from "@/lib/voice/command-review";
import styles from "./voice-mode.module.css";

type VoicePhase =
  | "consent"
  | "requesting"
  | "connecting"
  | "listening"
  | "speaking"
  | "finishing"
  | "review"
  | "reconnecting"
  | "sending"
  | "waiting"
  | "replying"
  | "approval"
  | "deciding"
  | "resolved"
  | "error";

type VoiceSession = Readonly<{
  sessionId: string;
  conversationId: string;
  clientSecret: string;
  clientSecretExpiresAt: number;
  transportUrl: string;
  provider: "openai";
  model: string;
  language: string;
  turnDetection: "server_vad";
  audioRetention: "not_stored_by_asael";
  transcriptRetention: "command_draft_until_sent";
  reconnectAttempt: number;
}>;

type AgentMode = "orchestrate" | "research" | "execute" | "learn";
type SessionOutcome = "sent" | "canceled" | "failed";
const REALTIME_TRANSPORT_URL = "https://api.openai.com/v1/realtime/calls";
const VOICE_MICROPHONE_TIMEOUT_MS = 30_000;
const VOICE_SESSION_TIMEOUT_MS = 45_000;
const VOICE_AUDIO_CONNECT_TIMEOUT_MS = 20_000;
const VOICE_CHANNEL_READY_TIMEOUT_MS = 15_000;
const restingMeter = [0.18, 0.28, 0.42, 0.24, 0.52, 0.34, 0.62, 0.3, 0.48, 0.24, 0.16];
const languageOptions = [
  ["auto", "Auto-detect"],
  ["en", "English"],
  ["hi", "Hindi"],
  ["ta", "Tamil"],
  ["te", "Telugu"],
  ["es", "Spanish"],
  ["fr", "French"],
  ["de", "German"],
  ["pt", "Portuguese"],
] as const;

export function VoiceMode({
  disabled,
  disabledReason,
  agentName = "Asael",
  agentVoice,
  conversationId,
  mode = "orchestrate",
  onConversationBound,
  onOpen,
  onTranscript,
  isAuthorityCurrent,
  authorityScope,
  onContinueInText,
}: {
  disabled?: boolean;
  disabledReason?: string;
  agentName?: string;
  agentVoice?: string;
  conversationId?: string;
  mode?: AgentMode;
  onConversationBound: (conversationId: string) => void;
  /** Presentation/navigation observer only; grants no device or action consent. */
  onOpen?: () => void;
  /** Current mounted account/role boundary, independent of composer busy state. */
  isAuthorityCurrent: () => boolean;
  authorityScope: string;
  onContinueInText: (text: string, conversationId?: string) => boolean;
  onTranscript: (
    text: string,
    conversationId: string,
    review: VoiceCommandReview,
  ) => Promise<VoiceCommandReply | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("consent");
  const [error, setError] = useState("");
  const [connectionErrorDetail, setConnectionErrorDetail] = useState("");
  const [language, setLanguage] = useState("auto");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [meterLevels, setMeterLevels] = useState(restingMeter);
  const [transcriptState, setTranscriptState] = useState<RealtimeTranscriptState>(EMPTY_REALTIME_TRANSCRIPT);
  const [reviewAttested, setReviewAttested] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<VoiceApprovalEvidence>();
  const [approvalNote, setApprovalNote] = useState("");
  const [decisionMessage, setDecisionMessage] = useState("");
  const [announcement, setAnnouncement] = useState("Voice mode ready.");
  const [microphoneOpen, setMicrophoneOpen] = useState(false);
  const [replyAudioPlaying, setReplyAudioPlaying] = useState(false);
  const [replyText, setReplyText] = useState("");
  const microphoneObservationRef = useRef<(() => void) | undefined>(undefined);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const primaryActionRef = useRef<HTMLButtonElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const meterFrameRef = useRef<number | null>(null);
  const requestControllerRef = useRef<AbortController | null>(null);
  const speechControllerRef = useRef<AbortController | null>(null);
  const speechPlayerRef = useRef<StreamingPcmPlayer | null>(null);
  const speechActiveRef = useRef(false);
  const [echoGuard] = useState(() => new ReplyEchoGuard());
  const reconnectTimerRef = useRef<number | null>(null);
  const maxSessionTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const transcriptStateRef = useRef<RealtimeTranscriptState>(EMPTY_REALTIME_TRANSCRIPT);
  const transcriptSubmittedRef = useRef(false);
  const [transcriptSubmitted, setTranscriptSubmitted] = useState(false);
  const commitPendingRef = useRef(false);
  const providerErrorCodeRef = useRef("");
  const recordingStartedAtRef = useRef(0);
  const sessionTokenRef = useRef(0);
  const phaseRef = useRef<VoicePhase>("consent");
  const reconnectingRef = useRef(false);
  const reconnectCountRef = useRef(0);
  const reportedRef = useRef(false);
  const decidingRef = useRef(false);
  const [decisionRecovery, setDecisionRecovery] = useState<Readonly<ApprovalDecisionRequest>>();
  const reviewAttestedRef = useRef(false);
  const approvalRunIdRef = useRef("");
  const approvalAgentIdRef = useRef<string | undefined>(undefined);
  const approvalConversationIdRef = useRef("");
  const mountedRef = useRef(true);
  const currentVoice = useCallback((token: number) => mountedRef.current &&
    isAuthorityCurrent() && token === sessionTokenRef.current, [isAuthorityCurrent]);

  // The ref leads, so a review waiting on it never reads a draft React has
  // not rendered yet.
  const updateTranscript = useCallback((next: RealtimeTranscriptState) => {
    if (next === transcriptStateRef.current) return;
    transcriptStateRef.current = next;
    setTranscriptState(next);
  }, []);

  useEffect(() => {
    phaseRef.current = phase;
  }, [phase]);

  const stopPeer = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    const channel = dataChannelRef.current;
    dataChannelRef.current = null;
    const peer = peerRef.current;
    peerRef.current = null;
    channel?.close();
    peer?.close();
  }, []);

  const stopMedia = useCallback(() => {
    microphoneObservationRef.current?.();
    microphoneObservationRef.current = undefined;
    setMicrophoneOpen(false);
    if (meterFrameRef.current !== null) {
      window.cancelAnimationFrame(meterFrameRef.current);
      meterFrameRef.current = null;
    }
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setMeterLevels(restingMeter);
  }, []);

  const stopSpeech = useCallback(() => {
    setReplyAudioPlaying(false);
    speechActiveRef.current = false;
    echoGuard.replyEnded(Date.now());
    speechControllerRef.current?.abort();
    speechControllerRef.current = null;
    speechPlayerRef.current?.stop();
    speechPlayerRef.current = null;
  }, [echoGuard]);

  const stopTransport = useCallback(() => {
    requestControllerRef.current?.abort();
    requestControllerRef.current = null;
    if (maxSessionTimerRef.current !== null) {
      window.clearTimeout(maxSessionTimerRef.current);
      maxSessionTimerRef.current = null;
    }
    reconnectingRef.current = false;
    stopPeer();
    stopMedia();
  }, [stopMedia, stopPeer]);

  const reportSession = useCallback(async (outcome: SessionOutcome) => {
    const session = sessionRef.current;
    if (!isAuthorityCurrent() || !session || reportedRef.current) return;
    reportedRef.current = true;
    const transcript = realtimeTranscriptText(transcriptStateRef.current).trim();
    const confidence = realtimeTranscriptConfidence(transcriptStateRef.current);
    await fetch("/api/voice/realtime/session", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.sessionId,
        conversationId: session.conversationId,
        outcome,
        durationMilliseconds: Math.min(10 * 60 * 1_000, Math.max(0, Date.now() - recordingStartedAtRef.current)),
        turnCount: transcriptStateRef.current.turnCount,
        reconnectCount: reconnectCountRef.current,
        transcriptCharacters: transcript.length,
        confidenceBand: confidence.band,
        confidenceMean: confidence.mean,
        confidenceMinimum: confidence.minimum,
        confidenceSampleCount: confidence.sampleCount,
        reviewRequired: confidence.requiresExplicitAttestation,
        reviewAttested: reviewAttestedRef.current,
        providerErrorCode: providerErrorCodeRef.current || undefined,
      }),
      keepalive: true,
    }).catch(() => undefined);
  }, [isAuthorityCurrent]);

  const resetSession = useCallback(() => {
    sessionRef.current = null;
    transcriptStateRef.current = EMPTY_REALTIME_TRANSCRIPT;
    transcriptSubmittedRef.current = false;
    setTranscriptSubmitted(false);
    reconnectCountRef.current = 0;
    providerErrorCodeRef.current = "";
    reportedRef.current = false;
    reviewAttestedRef.current = false;
    approvalRunIdRef.current = "";
    approvalAgentIdRef.current = undefined;
    approvalConversationIdRef.current = "";
    setTranscriptState(EMPTY_REALTIME_TRANSCRIPT);
    setReplyText("");
    setReviewAttested(false);
    setPendingApproval(undefined);
    setApprovalNote("");
    setDecisionMessage("");
    setDecisionRecovery(undefined);
    setElapsedSeconds(0);
    setError("");
    setConnectionErrorDetail("");
    setAnnouncement("Voice mode ready.");
  }, []);

  const closeDialog = useCallback((outcome: SessionOutcome = "canceled") => {
    sessionTokenRef.current += 1;
    void reportSession(outcome);
    stopSpeech();
    stopTransport();
    setOpen(false);
    setPhase("consent");
    resetSession();
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, [reportSession, resetSession, stopSpeech, stopTransport]);

  useLayoutEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionTokenRef.current += 1;
      // Disposal can follow an account replacement. Only explicit actions
      // report a session; cleanup must not POST its old private coordinates.
      stopSpeech();
      stopTransport();
    };
  }, [stopSpeech, stopTransport]);

  useEffect(() => {
    if (!isActivePhase(phase)) return;
    const updateElapsed = () => setElapsedSeconds(Math.max(0, Math.floor((Date.now() - recordingStartedAtRef.current) / 1_000)));
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
        closeDialog();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'));
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
  }, [closeDialog, open]);

  function startMeter(stream: MediaStream) {
    microphoneObservationRef.current?.();
    const tracks = stream.getAudioTracks();
    const updateMicrophone = () => {
      if (mountedRef.current && streamRef.current === stream) setMicrophoneOpen(tracks.some((track) => track.readyState === "live" && track.enabled));
    };
    updateMicrophone();
    tracks.forEach((track) => track.addEventListener("ended", updateMicrophone));
    microphoneObservationRef.current = () => tracks.forEach((track) => track.removeEventListener("ended", updateMicrophone));
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

  function failVoice(message: string, token: number, detail = "") {
    if (!currentVoice(token)) return;
    // Ends the session's pending work, so a review finishing in the
    // background cannot replace the error.
    sessionTokenRef.current += 1;
    void reportSession("failed");
    stopSpeech();
    stopTransport();
    setPhase("error");
    setError(message);
    setConnectionErrorDetail(detail);
    setAnnouncement(message);
  }

  /** Keeps the draft for review when the session ends before its review. */
  function reviewAfterSessionEnded(message: string, token: number, detail = "") {
    if (!realtimeTranscriptText(transcriptStateRef.current).trim()) {
      failVoice(`${message} Nothing was sent.`, token, detail);
      return;
    }
    if (!currentVoice(token)) return;
    // Ends the session's pending work, as a failure does.
    sessionTokenRef.current += 1;
    stopSpeech();
    stopTransport();
    updateTranscript(closeRealtimeTranscript(transcriptStateRef.current));
    reviewAttestedRef.current = false;
    setReviewAttested(false);
    setPhase("review");
    setError(`${message} Review the draft before sending it.`);
    setAnnouncement(`${message} Review the draft before sending it.`);
  }

  async function issueSession(
    token: number,
    reconnectAttempt: number,
    conversationOverride?: string,
  ): Promise<VoiceSession> {
    if (!currentVoice(token)) throw new DOMException("Workspace access changed.", "AbortError");
    const existing = sessionRef.current;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    try {
      return await withVoiceStartupDeadline(controller, VOICE_SESSION_TIMEOUT_MS,
        new RealtimeConnectionError(
          "Voice setup took too long. Check your connection, then try again.",
          "Voice setup · connection timed out",
        ), async () => {
          const response = await fetch("/api/voice/realtime/session", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              ...(reconnectAttempt && existing
                ? { sessionId: existing.sessionId, conversationId: existing.conversationId }
                : conversationOverride
                  ? { conversationId: conversationOverride }
                  : conversationId
                    ? { conversationId }
                    : {}),
              mode,
              ...(language === "auto" ? {} : { language }),
              providerConsent: true,
              audioRetention: "not_stored_by_asael",
              reconnectAttempt,
            }),
            signal: controller.signal,
          });
          const body: unknown = await response.json().catch(() => ({}));
          if (!currentVoice(token)) throw new DOMException("Canceled", "AbortError");
          if (!response.ok) throw realtimeConnectionFailure("session", response.status, body);
          return parseVoiceSession(body);
        });
    } catch (sessionError) {
      if (sessionError instanceof TypeError) {
        throw new RealtimeConnectionError(
          "Asael could not reach the voice service. Check your connection, then try again.",
          "Voice setup · network request failed",
        );
      }
      throw sessionError;
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }

  async function requestAttemptMicrophone(token: number) {
    if (!currentVoice(token)) throw new DOMException("Workspace access changed.", "AbortError");
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    try {
      const stream = await withVoiceStartupDeadline(controller, VOICE_MICROPHONE_TIMEOUT_MS,
        new RealtimeConnectionError(
          "Microphone permission is still pending. Allow microphone access in your browser or site settings, then try again. If no prompt appears, open Asael in a full browser.",
          "Microphone access · permission request timed out",
        ), () => requestCurrentMicrophone(requestMicrophone, () => (
          currentVoice(token) && !controller.signal.aborted
        )));
      if (!stream) throw new DOMException("Canceled", "AbortError");
      return stream;
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }

  async function connectPeer(session: VoiceSession, stream: MediaStream, token: number) {
    if (!currentVoice(token)) throw new DOMException("Workspace access changed.", "AbortError");
    stopPeer();
    const peer = new RTCPeerConnection();
    peerRef.current = peer;
    let connected = false;
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const channel = peer.createDataChannel("oai-events");
    dataChannelRef.current = channel;
    channel.addEventListener("open", () => {
      if (!currentVoice(token) || peerRef.current !== peer) return;
      reconnectingRef.current = false;
      setPhase("listening");
      setAnnouncement("Realtime transcription connected. Listening.");
    });
    channel.addEventListener("message", (event) => {
      if (!currentVoice(token) || dataChannelRef.current !== channel || typeof event.data !== "string") return;
      let providerEvent: unknown;
      try { providerEvent = JSON.parse(event.data); } catch { return; }
      const eventType = eventTypeOf(providerEvent);
      if (eventType === "input_audio_buffer.speech_started") {
        // Speech just after the reply starts is most likely its own echo.
        if (!echoGuard.speechStarted(providerEvent, Date.now())) return;
        const interruptedReply = speechActiveRef.current;
        if (interruptedReply) stopSpeech();
        setPhase("speaking");
        setAnnouncement(interruptedReply
          ? "Reply interrupted. Listening to your new turn."
          : "Speech detected. Live transcription is updating.");
      } else if (eventType === "input_audio_buffer.speech_stopped") {
        if (!speechActiveRef.current) {
          setPhase("listening");
          setAnnouncement("Turn detected. Listening for more.");
        }
      } else if (eventType === "conversation.item.input_audio_transcription.completed") {
        const turn = echoGuard.finishedTurn(providerEvent);
        if (turn?.echo) {
          updateTranscript(ignoreRealtimeTranscriptItem(transcriptStateRef.current, turn.itemId));
          setAnnouncement("Speech that matched the reply was left out of your draft.");
          return;
        }
        // Speech the guard let the reply talk over interrupts it once heard.
        if (turn && speechActiveRef.current) {
          stopSpeech();
          setPhase("listening");
          setAnnouncement("Reply interrupted. Listening to your new turn.");
        }
      } else if (eventType === "input_audio_buffer.committed") {
        commitPendingRef.current = false;
      } else if (eventType === "error") {
        const providerError = classifyRealtimeError(providerEvent);
        if (providerError.emptyCommit) {
          // Turn detection had already committed the last turn.
          commitPendingRef.current = false;
          return;
        }
        providerErrorCodeRef.current = providerError.code;
        if (providerError.fatal) {
          reviewAfterSessionEnded("The transcription provider ended the session.", token);
        } else {
          setAnnouncement("The transcription provider reported a problem it can recover from.");
        }
        return;
      }
      updateTranscript(applyRealtimeTranscriptEvent(transcriptStateRef.current, providerEvent));
    });
    peer.addEventListener("connectionstatechange", () => {
      // Startup owns failures until the channel is ready; do not start a
      // competing reconnect while its SDP exchange is still pending.
      if (!connected || !currentVoice(token) || peerRef.current !== peer || !["failed", "disconnected"].includes(peer.connectionState)) return;
      if (reconnectTimerRef.current !== null) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (peerRef.current === peer && ["failed", "disconnected"].includes(peer.connectionState)) void reconnect(token);
      }, 650);
    });

    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
    const peerCurrent = () => currentVoice(token) && peerRef.current === peer;
    try {
      await withVoiceStartupDeadline(controller, VOICE_AUDIO_CONNECT_TIMEOUT_MS,
        new RealtimeConnectionError(
          "The audio connection took too long. Check whether your network allows live audio, then try again.",
          "Audio connection · connection timed out",
        ), async () => {
          const offer = await peer.createOffer();
          if (!peerCurrent()) throw new DOMException("Canceled", "AbortError");
          await peer.setLocalDescription(offer);
          if (!peerCurrent()) throw new DOMException("Canceled", "AbortError");
          if (!offer.sdp) throw new RealtimeConnectionError(
            "The browser could not prepare live audio. Try again or use another browser.",
            "Audio connection · browser audio offer unavailable",
          );
          const answerResponse = await fetch(session.transportUrl, {
            method: "POST",
            headers: { authorization: `Bearer ${session.clientSecret}`, "content-type": "application/sdp" },
            body: offer.sdp,
            signal: controller.signal,
          });
          const answerSdp = await answerResponse.text();
          if (!peerCurrent()) throw new DOMException("Canceled", "AbortError");
          if (!answerResponse.ok) {
            let failureBody: unknown;
            if (answerSdp.length <= 16_384) {
              try { failureBody = JSON.parse(answerSdp); } catch { /* No provider text is shown. */ }
            }
            const failure = realtimeConnectionFailure("audio", answerResponse.status, failureBody);
            providerErrorCodeRef.current = failure.providerCode || "unknown";
            throw failure;
          }
          if (answerSdp.length > 1_000_000 || !answerSdp.startsWith("v=0")) throw new RealtimeConnectionError(
            "The voice service returned an unusable audio connection. Try again shortly.",
            `Audio connection · HTTP ${answerResponse.status} · invalid audio handshake`,
          );
          await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
        });
      await withVoiceStartupDeadline(controller, VOICE_CHANNEL_READY_TIMEOUT_MS,
        new RealtimeConnectionError(
          "Live audio could not connect on this network. Check your connection or try another network, then retry.",
          "Audio connection · listening channel timed out",
        ), () => waitForDataChannelOpen(channel, peerCurrent, peer));
      connected = true;
    } catch (connectionError) {
      if (peerRef.current === peer) {
        stopPeer();
        if (streamRef.current === stream) stopMedia();
      } else {
        channel.close();
        peer.close();
      }
      if (connectionError instanceof TypeError) {
        throw new RealtimeConnectionError(
          "The browser could not reach OpenAI for live audio. Check your network or browser connection settings, then try again.",
          "Audio connection · network request failed",
        );
      }
      if (!(connectionError instanceof RealtimeConnectionError) && !isAbortError(connectionError)) {
        throw new RealtimeConnectionError(
          "The browser could not establish live audio. Try again or open Asael in another browser.",
          "Audio connection · browser audio handshake failed",
        );
      }
      throw connectionError;
    } finally {
      if (requestControllerRef.current === controller) requestControllerRef.current = null;
    }
  }

  async function reconnect(token: number) {
    if (reconnectingRef.current || !currentVoice(token)) return;
    reconnectingRef.current = true;
    stopPeer();
    const attempt = reconnectCountRef.current + 1;
    if (attempt > 3) {
      reviewAfterSessionEnded("Realtime voice disconnected after three recovery attempts.", token);
      return;
    }
    reconnectCountRef.current = attempt;
    setPhase("reconnecting");
    setAnnouncement(`Connection interrupted. Reconnecting, attempt ${attempt} of 3.`);
    try {
      let stream = streamRef.current;
      if (!stream || stream.getAudioTracks().every((track) => track.readyState === "ended")) {
        stream = await requestAttemptMicrophone(token);
        streamRef.current = stream;
        startMeter(stream);
      }
      const session = await issueSession(token, attempt);
      sessionRef.current = session;
      await connectPeer(session, stream, token);
    } catch (reconnectError) {
      reconnectingRef.current = false;
      if (isAbortError(reconnectError) || !currentVoice(token)) return;
      stopPeer();
      stopMedia();
      if (attempt >= 3) {
        reviewAfterSessionEnded(
          reconnectError instanceof Error ? reconnectError.message : "Realtime voice could not reconnect.",
          token,
          reconnectError instanceof RealtimeConnectionError ? reconnectError.detail : "",
        );
        return;
      }
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void reconnect(token);
      }, Math.min(2_000, attempt * 500));
    }
  }

  async function startRealtime() {
    if (disabled || !isAuthorityCurrent()) return;
    const token = sessionTokenRef.current + 1;
    sessionTokenRef.current = token;
    resetSession();
    setPhase("requesting");
    setAnnouncement("Waiting for microphone permission.");
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      failVoice("Realtime voice is not supported by this browser.", token);
      return;
    }
    try {
      const stream = await requestAttemptMicrophone(token);
      if (!currentVoice(token)) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      startMeter(stream);
      setPhase("connecting");
      setAnnouncement("Connecting a private transcription session.");
      const session = await issueSession(token, 0);
      sessionRef.current = session;
      reportedRef.current = false;
      onConversationBound(session.conversationId);
      recordingStartedAtRef.current = Date.now();
      await connectPeer(session, stream, token);
      if (!currentVoice(token)) return;
      maxSessionTimerRef.current = window.setTimeout(() => void finishListening(), 10 * 60 * 1_000);
    } catch (startError) {
      if (isAbortError(startError) || !currentVoice(token)) return;
      failVoice(startError instanceof Error ? startError.message : "Realtime voice could not start.", token,
        startError instanceof RealtimeConnectionError ? startError.detail : "");
    }
  }

  async function finishListening() {
    const activePhase = phaseRef.current;
    if (!["listening", "speaking", "reconnecting"].includes(activePhase)) return;
    const token = sessionTokenRef.current;
    setPhase("finishing");
    setAnnouncement("Finishing the current transcription turn.");
    const channel = dataChannelRef.current;
    const open = channel?.readyState === "open";
    commitPendingRef.current = open && activePhase === "speaking";
    if (commitPendingRef.current) {
      channel?.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
    setMicrophoneOpen(false);
    // Review waits for every committed turn's final transcript, for as long
    // as one is likely to take.
    const deadline = Date.now() + 4_000;
    while (
      open &&
      currentVoice(token) &&
      Date.now() < deadline &&
      (commitPendingRef.current || realtimeTranscriptPending(transcriptStateRef.current))
    ) {
      await delay(50);
    }
    if (!currentVoice(token)) return;
    stopTransport();
    updateTranscript(closeRealtimeTranscript(transcriptStateRef.current));
    reviewAttestedRef.current = false;
    setReviewAttested(false);
    setPhase("review");
    setAnnouncement("Transcription stopped. Review and edit before sending.");
  }

  async function startContinuationListening(
    activeConversationId: string,
    token: number,
  ) {
    if (!currentVoice(token)) throw new DOMException("Workspace access changed.", "AbortError");
    sessionRef.current = null;
    transcriptStateRef.current = EMPTY_REALTIME_TRANSCRIPT;
    transcriptSubmittedRef.current = false;
    setTranscriptSubmitted(false);
    reconnectCountRef.current = 0;
    providerErrorCodeRef.current = "";
    reportedRef.current = false;
    reviewAttestedRef.current = false;
    setTranscriptState(EMPTY_REALTIME_TRANSCRIPT);
    setReviewAttested(false);
    setElapsedSeconds(0);
    setError("");
    setAnnouncement("Reopening listening so you can interrupt the reply.");
    const stream = await requestAttemptMicrophone(token);
    if (!currentVoice(token)) {
      stream.getTracks().forEach((track) => track.stop());
      throw new DOMException("Canceled", "AbortError");
    }
    streamRef.current = stream;
    startMeter(stream);
    const nextSession = await issueSession(token, 0, activeConversationId);
    sessionRef.current = nextSession;
    onConversationBound(nextSession.conversationId);
    recordingStartedAtRef.current = Date.now();
    await connectPeer(nextSession, stream, token);
    if (!currentVoice(token)) throw new DOMException("Workspace access changed.", "AbortError");
    maxSessionTimerRef.current = window.setTimeout(
      () => void finishListening(),
      10 * 60 * 1_000,
    );
  }

  async function streamReply(
    reply: VoiceCommandReply,
    activeConversationId: string,
    token: number,
  ) {
    if (!currentVoice(token)) return false;
    // Presentation only: keep the exact authorized reply readable if playback
    // is interrupted or unavailable. Session reset clears this with the draft.
    setReplyText(reply.text);
    const controller = new AbortController();
    const player = new StreamingPcmPlayer();
    speechControllerRef.current = controller;
    speechPlayerRef.current = player;
    speechActiveRef.current = true;
    setReplyAudioPlaying(false);
    setPhase("replying");
    setAnnouncement(`Preparing ${agentName}'s reply audio. Playback has not started.`);
    try {
      await streamVersionedSpeech({
        text: reply.text,
        threadId: activeConversationId,
        runId: reply.runId,
        agentId: reply.agentId,
      }, {
        player,
        signal: controller.signal,
        onStarted: () => {
          if (!currentVoice(token) || speechControllerRef.current !== controller || controller.signal.aborted) return;
          setReplyAudioPlaying(true);
          echoGuard.replyStarted(reply.text, Date.now());
          setPhase("replying");
          setAnnouncement(`${agentName} is speaking. Speak to interrupt.`);
        },
      });
      return currentVoice(token);
    } catch (speechError) {
      if (isAbortError(speechError) || controller.signal.aborted) return false;
      throw speechError;
    } finally {
      if (speechControllerRef.current === controller) {
        speechControllerRef.current = null;
        speechActiveRef.current = false;
        setReplyAudioPlaying(false);
        echoGuard.replyEnded(Date.now());
      }
      if (speechPlayerRef.current === player) speechPlayerRef.current = null;
    }
  }

  async function sendTranscript() {
    if (!isAuthorityCurrent()) return;
    const token = sessionTokenRef.current;
    const session = sessionRef.current;
    const transcript = realtimeTranscriptText(transcriptStateRef.current).trim();
    const confidence = realtimeTranscriptConfidence(transcriptStateRef.current);
    if (!session || !transcript) {
      setError("No speech was recognized. Nothing was sent.");
      setPhase("error");
      return;
    }
    if (confidence.requiresExplicitAttestation && !reviewAttestedRef.current) {
      setError("Confirm that the visible transcript matches what you intend before sending.");
      setAnnouncement("The transcript still needs explicit review.");
      return;
    }
    reviewAttestedRef.current = true;
    setReviewAttested(true);
    const review: VoiceCommandReview = {
      schemaVersion: 1,
      source: "realtime_voice",
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      provider: "openai",
      confidenceBand: confidence.band,
      confidenceMean: confidence.mean,
      confidenceMinimum: confidence.minimum,
      confidenceSampleCount: confidence.sampleCount,
      reviewMethod: confidence.requiresExplicitAttestation
        ? "explicit_checkbox"
        : "send_button",
      reviewAttested: true,
    };
    setPhase("sending");
    setAnnouncement("Sending the reviewed transcript to the conversation.");
    stopTransport();
    await reportSession("sent");
    if (!currentVoice(token)) return;
    onConversationBound(session.conversationId);
    setPhase("waiting");
    setAnnouncement(`${agentName} is working on the reviewed command.`);
    try {
      if (transcriptSubmittedRef.current) return;
      transcriptSubmittedRef.current = true;
      setTranscriptSubmitted(true);
      const reply = await onTranscript(transcript, session.conversationId, review);
      if (!currentVoice(token)) return;
      if (!reply?.text.trim()) {
        throw new Error(`${agentName} did not return a speakable response.`);
      }
      if (reply.approval) {
        approvalRunIdRef.current = reply.runId || "";
        approvalAgentIdRef.current = reply.agentId;
        approvalConversationIdRef.current = session.conversationId;
        setPendingApproval(reply.approval);
        setDecisionMessage("");
        await streamReply(reply, session.conversationId, token);
        if (currentVoice(token)) {
          setPhase("approval");
          setAnnouncement("Review the exact visible action. Spoken words cannot approve it.");
        }
        return;
      }
      await startContinuationListening(session.conversationId, token);
      const completed = await streamReply(reply, session.conversationId, token);
      if (completed && currentVoice(token)) {
        setPhase("listening");
        setAnnouncement("Reply complete. Listening for your next turn.");
      }
    } catch (sendError) {
      if (isAbortError(sendError) || !currentVoice(token)) return;
      failVoice(sendError instanceof Error
        ? sendError.message
        : "The voice reply could not be completed.", token);
    }
  }

  function interruptReply() {
    if (!speechActiveRef.current) return;
    stopSpeech();
    if (pendingApproval) {
      setPhase("approval");
      setAnnouncement("Reply interrupted. Review the visible action to approve or reject it.");
    } else {
      setPhase("listening");
      setAnnouncement("Reply interrupted. Listening for your next turn.");
    }
  }

  async function decideApproval(decision: "approve" | "reject", frozen?: Readonly<ApprovalDecisionRequest>) {
    if (!isAuthorityCurrent() || decidingRef.current || (decisionRecovery && !frozen)) return;
    const approval = pendingApproval;
    const runId = approvalRunIdRef.current;
    if (!approval || (!frozen && decision === "approve" && !approval.canApprove)) return;
    if (!frozen && decision === "reject" && !approval.canReject) return;
    const token = sessionTokenRef.current;
    decidingRef.current = true;
    let accepted = false;
    setPhase("deciding");
    setError("");
    setAnnouncement(`${decision === "approve" ? "Approving" : "Rejecting"} the exact visible action.`);
    try {
      const response = await postApprovalDecision(approval.id, frozen ?? {
        kind: "tool",
        decision,
        ...(approvalNote.trim() ? { reason: approvalNote.trim() } : {}),
      }, fetch, { scope: authorityScope, isCurrent: () => currentVoice(token) });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(body, "The approval decision could not be recorded."));
      if (!currentVoice(token)) return;
      accepted = true;
      setDecisionRecovery(undefined);
      setDecisionMessage(`${decision === "approve" ? "Approval" : "Rejection"} recorded for the exact action.`);
      if (response.status === 202) {
        const refreshed = await loadApprovalEvidence(approval.id, () => currentVoice(token));
        if (!currentVoice(token)) return;
        setPendingApproval(refreshed);
        setDecisionMessage("Your approval is recorded. Another eligible admin must review this action.");
        setPhase("approval");
        setAnnouncement("Approval recorded. The required quorum is not complete.");
        return;
      }
      if (decision === "reject") {
        setDecisionMessage("Rejection recorded. The visible action did not run.");
        setPhase("resolved");
        setAnnouncement("Rejection recorded. The action did not run.");
        return;
      }
      setDecisionMessage("Approval recorded. Waiting for the governed run to finish.");
      if (!runId) {
        setPhase("resolved");
        return;
      }
      const outcome = await waitForVoiceRun(
        runId,
        approval.id,
        () => currentVoice(token),
      );
      if (!currentVoice(token)) return;
      if (outcome.approval) {
        setPendingApproval(outcome.approval);
        setApprovalNote("");
        setDecisionMessage("The next risk-bearing action also needs visible approval.");
        setPhase("approval");
        setAnnouncement("The next action is waiting for visible approval.");
        return;
      }
      if (outcome.response) {
        setPendingApproval(undefined);
        const activeConversationId = outcome.threadId || approvalConversationIdRef.current;
        if (!activeConversationId) throw new Error("The voice conversation binding was lost.");
        await startContinuationListening(activeConversationId, token);
        const completed = await streamReply({
          text: outcome.response,
          runId,
          agentId: approvalAgentIdRef.current,
        }, activeConversationId, token);
        if (completed && currentVoice(token)) {
          setPhase("listening");
          setAnnouncement("Approved task complete. Listening for your next turn.");
        }
        return;
      }
      setDecisionMessage(outcome.message || "Approval recorded. The task continues in Activity.");
      setPhase("resolved");
    } catch (decisionError) {
      if (!currentVoice(token)) return;
      if (decisionError instanceof ApprovalDecisionUnconfirmedError) setDecisionRecovery(decisionError.request);
      setError(decisionError instanceof Error ? decisionError.message : "The approval decision failed.");
      setPhase(accepted ? "resolved" : "approval");
      setAnnouncement(accepted ? "The decision is recorded. Its follow-up could not be confirmed; review Activity. No decision was repeated." : "The decision could not be confirmed. Review the visible recovery notice.");
      if (accepted) setDecisionMessage("The exact decision was recorded. The current run or approval status could not be read. Review Activity; this does not revoke the recorded decision.");
    } finally {
      decidingRef.current = false;
    }
  }

  function continueInText() {
    const token = sessionTokenRef.current;
    if (!currentVoice(token) || transcriptSubmittedRef.current) return;
    const text = realtimeTranscriptText(transcriptStateRef.current);
    stopSpeech();
    stopTransport();
    try {
      if (!currentVoice(token)) return;
      if (!onContinueInText(text, sessionRef.current?.conversationId || conversationId)) throw new Error("The conversation changed. Reopen the matching conversation before moving this transcript.");
      // This is a local draft transfer, with no command or decision request.
      sessionTokenRef.current += 1;
      setOpen(false);
      setPhase("consent");
      resetSession();
      window.requestAnimationFrame(() => {
        const label = [...document.querySelectorAll("label")].find((element) => element.querySelector(".sr-only")?.textContent === "Message Asael");
        label?.querySelector("textarea")?.focus();
      });
    } catch (handoffError) {
      setError(handoffError instanceof Error ? handoffError.message : "The transcript could not be moved.");
      setPhase("review");
    }
  }

  function retryVoice() {
    void reportSession("failed");
    stopTransport();
    resetSession();
    setPhase("consent");
    setAnnouncement("Review provider use, then start a new session.");
  }

  const transcript = realtimeTranscriptText(transcriptState);
  const confidence = realtimeTranscriptConfidence(transcriptState);
  const status = voiceStatus(phase, elapsedSeconds, error, replyAudioPlaying);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { onOpen?.(); resetSession(); setPhase("consent"); setOpen(true); }}
        disabled={disabled}
        title={disabledReason || (disabled ? "Voice mode is unavailable while work is active." : "Start realtime voice mode")}
        className={styles.trigger}
        aria-label={`Start voice mode with ${agentName}`}
        aria-haspopup="dialog"
      >
        <AudioLines size={17} aria-hidden="true" />
      </button>

      {open ? (
        <div className={styles.backdrop}>
          <section
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="voice-mode-title"
            aria-describedby="voice-mode-status voice-mode-detail"
            className={styles.dialog}
            data-voice-phase={phase}
          >
            <header className={styles.header}>
              <div className={styles.title}>
                <h2 id="voice-mode-title">Realtime voice to {agentName}</h2>
              </div>
              <div className={clsx(styles.microphoneStatus, microphoneOpen && styles.microphoneLive)}>
                {microphoneOpen ? <Mic size={14} aria-hidden="true" /> : <MicOff size={14} aria-hidden="true" />}
                <span>Microphone {microphoneOpen ? "on" : "off"}</span>
                {microphoneOpen ? <span className={styles.elapsed}>{formatDuration(elapsedSeconds)}</span> : null}
              </div>
              <button type="button" onClick={() => closeDialog()} className={styles.close} aria-label="Cancel voice mode">
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            <div className={styles.stage}>
            <VoiceAtlasStage key={JSON.stringify([authorityScope, conversationId])} scope={isAuthorityCurrent() ? authorityScope : undefined} conversationId={conversationId}
              phase={phase} microphoneOpen={microphoneOpen} replyAudioPlaying={replyAudioPlaying} />
            {phase === "consent" ? (
              <div className={styles.consent}>
                <ShieldCheck size={28} className={styles.consentIcon} aria-hidden="true" />
                <h3 id="voice-mode-status" className={styles.consentTitle}>Live transcription session</h3>
                <p id="voice-mode-detail" className={styles.consentDescription}>OpenAI processes live microphone audio to produce partial text. Asael does not store the audio. The transcript remains an editable command draft until you send it, then the exact agent result streams back in Asael&apos;s versioned voice. Speaking interrupts playback.</p>
                <div className={styles.providerDetails}>
                  <p><strong className="text-foreground">Provider:</strong> OpenAI</p>
                  <p><strong className="text-foreground">Turn detection:</strong> server voice activity detection</p>
                  <p><strong className="text-foreground">Audio retention:</strong> not stored by Asael</p>
                </div>
                <label className={styles.field}>
                  Spoken language
                  <select value={language} onChange={(event) => setLanguage(event.currentTarget.value)} className={styles.input}>
                    {languageOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <div className={styles.session}>
                <div className={styles.audioStatus} aria-hidden="true">
                  {["requesting", "connecting", "finishing", "reconnecting", "sending", "waiting", "deciding"].includes(phase) ? (
                    <Loader2 size={28} className={styles.progress} />
                  ) : phase === "replying" ? <AudioLines size={28} /> : phase === "resolved" ? <Check size={28} /> : <Mic size={28} />}
                  <div className={clsx(styles.meter, microphoneOpen && styles.meterActive)}>
                    {meterLevels.map((level, index) => <span key={index} style={{ transform: `scaleY(${(4 + level * 18) / 22})` }} />)}
                  </div>
                </div>
                <p id="voice-mode-status" className={styles.statusTitle}>{status.title}</p>
                <p id="voice-mode-detail" className={clsx(styles.statusDetail, phase === "error" && styles.error)}>{status.detail}</p>
                {phase === "error" && connectionErrorDetail ? (
                  <details className="w-full text-left text-xs leading-5 text-muted">
                    <summary className="cursor-pointer">Connection details</summary>
                    <p>{connectionErrorDetail}</p>
                  </details>
                ) : null}
                <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
                {replyText && !(pendingApproval && ["approval", "deciding", "resolved"].includes(phase)) ? (
                  <section className={styles.reply} aria-label={`${agentName}'s response`}>
                    <h3>{agentName}&apos;s response{replyAudioPlaying ? <span className={styles.playbackLabel}><AudioLines size={13} aria-hidden="true" />Playing</span> : null}</h3>
                    <p>{replyText}</p>
                  </section>
                ) : null}
                {pendingApproval && ["approval", "deciding", "resolved"].includes(phase) ? (
                  <div className={styles.approval}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{pendingApproval.title}</p>
                        <p className="mt-1 text-xs leading-5 text-muted">{pendingApproval.description}</p>
                      </div>
                      <span className="shrink-0 rounded-full bg-warning/15 px-2.5 py-1 text-xs font-semibold text-warning">Risk {pendingApproval.riskLevel}</span>
                    </div>
                    <dl className={styles.approvalFacts}>
                      <div><dt className="text-muted">Tool</dt><dd className="mt-0.5 font-mono text-foreground">{pendingApproval.toolId}</dd></div>
                      <div><dt className="text-muted">Reversible</dt><dd className="mt-0.5 font-semibold text-foreground">{pendingApproval.reversible ? "Yes" : "No"}</dd></div>
                    </dl>
                    <p className="mt-3 text-xs leading-5 text-muted">{pendingApproval.reason}</p>
                    <div className="mt-3">
                      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted">Exact reviewed input</p>
                      <pre className={styles.exactInput}>{JSON.stringify(pendingApproval.input, null, 2)}</pre>
                    </div>
                    <label className={styles.field}>
                      Decision note (optional)
                      <textarea value={approvalNote} onChange={(event) => setApprovalNote(event.currentTarget.value)} maxLength={1_000} rows={2} disabled={phase !== "approval"} className={styles.input} />
                    </label>
                    <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-warning"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />Spoken words cannot approve this action. Use a visible button below.</p>
                    {pendingApproval.approvalProgress.required > 1 ? <p className="mt-1 text-xs text-muted">{pendingApproval.approvalProgress.approvals}/{pendingApproval.approvalProgress.required} eligible approvals recorded.</p> : null}
                    {pendingApproval.blockReason ? <p className="mt-1 text-xs leading-5 text-muted">{pendingApproval.blockReason}</p> : null}
                    {decisionMessage ? <p className="mt-2 text-xs font-medium leading-5 text-foreground">{decisionMessage}</p> : null}
                    {error ? <p className="mt-2 text-xs font-medium leading-5 text-danger">{error}</p> : null}
                  </div>
                ) : (
                  <>
                    <label className={styles.field}>
                      Editable transcript
                      <textarea
                        value={transcript}
                        onChange={(event) => {
                          reviewAttestedRef.current = false;
                          setReviewAttested(false);
                          setError("");
                          updateTranscript(editRealtimeTranscript(transcriptStateRef.current, event.currentTarget.value));
                        }}
                        rows={5}
                        maxLength={100_000}
                        disabled={["requesting", "connecting", "sending", "waiting", "replying"].includes(phase)}
                        placeholder={isActivePhase(phase) ? "Partial transcription will appear here…" : "No speech recognized yet."}
                        className={clsx(styles.input, styles.transcript, phase === "review" && styles.reviewTranscript)}
                      />
                    </label>
                    {phase === "review" && confidence.requiresExplicitAttestation ? (
                      <label className={styles.attestation}>
                        <input type="checkbox" checked={reviewAttested} onChange={(event) => {
                          reviewAttestedRef.current = event.currentTarget.checked;
                          setReviewAttested(event.currentTarget.checked);
                          setError("");
                        }} className="mt-1" />
                        <span>I reviewed the visible transcript and it matches the exact command I intend to send. Risk-bearing actions will still require a separate visible approval.</span>
                      </label>
                    ) : null}
                    {phase === "review" ? <p className="mt-2 w-full text-left text-xs text-muted">Transcription confidence: {confidenceLabel(confidence.band)}.</p> : null}
                    {agentVoice ? <p className="mt-2 text-xs leading-5 text-muted">{agentName}&apos;s identity ({agentVoice}) is spoken through Asael&apos;s governed voice profile.</p> : null}
                  </>
                )}
              </div>
            )}
            </div>

            <footer className={styles.footer}>
              {["review", "error"].includes(phase) && transcript.trim() && !transcriptSubmitted ? <button type="button" onClick={continueInText} className={clsx("action-button", styles.action)}>Continue in text</button> : null}
              {phase === "consent" ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className={clsx("action-button", styles.action)}>Cancel</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void startRealtime()} className={clsx("primary-button", styles.action)}><Mic size={15} aria-hidden="true" />Agree &amp; start</button>
                </>
              ) : ["listening", "speaking", "reconnecting"].includes(phase) ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className={clsx("action-button", styles.action)}>Cancel</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void finishListening()} className={clsx("primary-button", styles.action)}><Square size={14} fill="currentColor" aria-hidden="true" />Stop &amp; review</button>
                </>
              ) : phase === "review" ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className={clsx("action-button", styles.action)}>Cancel</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void sendTranscript()} disabled={!transcript.trim() || (confidence.requiresExplicitAttestation && !reviewAttested)} className={clsx("primary-button", styles.action)}><Send size={15} aria-hidden="true" />Send to {agentName}</button>
                </>
              ) : phase === "approval" && pendingApproval ? (
                <>
                  <button type="button" onClick={() => void decideApproval("reject")} disabled={!pendingApproval.canReject || Boolean(decisionRecovery)} className={clsx("action-button", styles.action)}>Reject</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void decideApproval("approve")} disabled={!pendingApproval.canApprove || Boolean(decisionRecovery)} title={pendingApproval.blockReason} className={clsx("primary-button", styles.action)}><Check size={15} aria-hidden="true" />Approve exact action</button>
                  {decisionRecovery ? <button type="button" onClick={() => void decideApproval(decisionRecovery.decision, decisionRecovery)} className={clsx("action-button", styles.action)}>Retry same saved decision</button> : null}
                </>
              ) : phase === "deciding" ? (
                <button type="button" disabled className={clsx("primary-button", styles.action)}><Loader2 size={15} className="animate-spin" aria-hidden="true" />Recording decision</button>
              ) : phase === "resolved" ? (
                <button ref={primaryActionRef} type="button" onClick={() => closeDialog("sent")} className={clsx("primary-button", styles.action)}><Check size={15} aria-hidden="true" />Done</button>
              ) : phase === "replying" ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className={clsx("action-button", styles.action)}>End voice mode</button>
                  <button ref={primaryActionRef} type="button" onClick={interruptReply} className={clsx("primary-button", styles.action)}><Square size={14} fill="currentColor" aria-hidden="true" />Interrupt reply</button>
                </>
              ) : phase === "error" ? (
                <>
                  <button type="button" onClick={() => closeDialog("failed")} className={clsx("action-button", styles.action)}>Close</button>
                  <button ref={primaryActionRef} type="button" onClick={retryVoice} className={clsx("primary-button", styles.action)}><RotateCcw size={15} aria-hidden="true" />Try again</button>
                </>
              ) : (
                <button ref={primaryActionRef} type="button" onClick={() => closeDialog()} className={clsx("action-button", styles.action)}>Cancel</button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}

/** Decorative only. Actual device/playback signals select presentation; a Voice
 * phase alone is never a microphone, playing audio, or verified completion. */
export function VoiceAtlasStage({ scope, conversationId, phase, microphoneOpen, replyAudioPlaying }: {
  scope?: string;
  conversationId?: string;
  phase: VoicePhase;
  microphoneOpen: boolean;
  replyAudioPlaying: boolean;
}) {
  const presentation = companionPresentation({
    microphoneActive: microphoneOpen,
    playbackActive: replyAudioPlaying,
    speechPreparing: phase === "replying" && !replyAudioPlaying,
    work: companionWork({ status: phase === "approval" ? "waiting_approval"
      : phase === "review" ? "review" : phase === "reconnecting" ? "reconnecting"
      : phase === "error" ? "failed" : ["sending", "waiting", "deciding"].includes(phase) ? "running" : undefined }),
  });
  const { read, observationRef, showPortrait, assetFailed, motion, intensity, portrait } = useCompanionAtlasPlayer({ scope, conversationId, presentation });
  const visible = read.state === "ready" && read.response?.snapshot.preferences.visible;
  // Keep both the gate and its observation element mounted while hidden, so a
  // preference/visibility change cannot replay a transition already observed.
  return (
    <aside ref={observationRef} className={styles.companion} aria-label="ATLAS companion" hidden={!visible}
      data-companion-state={presentation.state} data-companion-motion={motion} data-companion-intensity={intensity}
      data-companion-preferences={read.state}
      data-voice-portrait={showPortrait ? "visible" : assetFailed ? "unavailable" : "hidden"}>
      <CompanionAtlasPortrait {...portrait}
        className={styles.portrait} size="var(--atlas-portrait-size)" />
      <p className={styles.companionName}>ATLAS</p>
      <p className={styles.companionState}>{presentation.label}</p>
      {assetFailed ? <p className={styles.portraitFallback}>Portrait unavailable</p> : null}
    </aside>
  );
}

async function requestMicrophone() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch (error) {
    throw new Error(microphoneErrorMessage(error));
  }
}

function parseVoiceSession(value: unknown): VoiceSession {
  if (!isRecord(value)) throw new Error("The realtime session response was invalid.");
  if (
    !isUuid(value.sessionId) ||
    !isUuid(value.conversationId) ||
    typeof value.clientSecret !== "string" ||
    !/^ek_[A-Za-z0-9._~-]{8,2048}$/.test(value.clientSecret) ||
    !Number.isSafeInteger(value.clientSecretExpiresAt) ||
    value.transportUrl !== REALTIME_TRANSPORT_URL ||
    value.provider !== "openai" ||
    typeof value.model !== "string" ||
    !value.model.startsWith("gpt-") ||
    typeof value.language !== "string" ||
    value.turnDetection !== "server_vad" ||
    value.audioRetention !== "not_stored_by_asael" ||
    value.transcriptRetention !== "command_draft_until_sent" ||
    !Number.isInteger(value.reconnectAttempt) ||
    Number(value.reconnectAttempt) < 0 ||
    Number(value.reconnectAttempt) > 3
  ) throw new Error("The realtime session response was invalid.");
  return value as VoiceSession;
}

function eventTypeOf(value: unknown) {
  return isRecord(value) && typeof value.type === "string" ? value.type : "";
}

function errorMessage(value: unknown, fallback: string) {
  return isRecord(value) && typeof value.error === "string" ? value.error.slice(0, 500) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isUuid(value: unknown) {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isAbortError(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function microphoneErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Microphone access is blocked. Allow it in your browser settings, then try again.";
    if (error.name === "NotFoundError" || error.name === "OverconstrainedError") return "No available microphone was found.";
    if (error.name === "NotReadableError" || error.name === "AbortError") return "Your microphone is busy or could not be started.";
  }
  return "The microphone could not be started. Nothing was sent.";
}

function voiceStatus(phase: VoicePhase, elapsedSeconds: number, error: string, replyAudioPlaying: boolean) {
  if (phase === "requesting") return { title: "Allow microphone access", detail: "Allow microphone access in your browser or system prompt. If no prompt appears, check this site's microphone permission or open Asael in a full browser." };
  if (phase === "connecting") return { title: "Connecting", detail: "Opening a short-lived transcription-only connection." };
  if (phase === "listening") return { title: formatDuration(elapsedSeconds), detail: "Listening. Partial multilingual text appears below." };
  if (phase === "speaking") return { title: formatDuration(elapsedSeconds), detail: "Speech detected. Server VAD will close this turn after a short pause." };
  if (phase === "reconnecting") return { title: "Reconnecting", detail: "Your editable draft is preserved while the audio connection recovers." };
  if (phase === "finishing") return { title: "Finishing this turn", detail: "Waiting briefly for the last partial transcription." };
  if (phase === "review") return { title: "Review before sending", detail: error || "Edit the transcript. Nothing is sent to the Command API until you confirm." };
  if (phase === "sending") return { title: "Sending command", detail: "The reviewed text is being attributed to this conversation." };
  if (phase === "waiting") return { title: "Waiting for the result", detail: "The governed agent run is completing before speech playback starts." };
  if (phase === "replying") return replyAudioPlaying
    ? { title: "Speaking response", detail: "This is the exact agent result. Speak or use Interrupt reply to stop it." }
    : { title: "Preparing response audio", detail: "Playback has not started. The reply remains available as text; interruption controls remain available." };
  if (phase === "approval") return { title: "Visible approval required", detail: "Review the exact action and target below. Voice confirmation is disabled." };
  if (phase === "deciding") return { title: "Recording your decision", detail: "The governed executor is persisting the visible approval decision." };
  if (phase === "resolved") return { title: "Decision recorded", detail: "The durable approval record is available in Activity." };
  if (phase === "error") return { title: "Voice mode needs attention", detail: error || "Nothing was sent." };
  return { title: "Realtime voice", detail: "Review provider use before starting." };
}

function confidenceLabel(
  band: ReturnType<typeof realtimeTranscriptConfidence>["band"],
) {
  if (band === "high") return "high";
  if (band === "low") return "low — explicit review required";
  if (band === "edited") return "edited — explicit review required";
  return "unavailable — explicit review required";
}

function isActivePhase(phase: VoicePhase) {
  return ["listening", "speaking", "reconnecting", "replying"].includes(phase);
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => window.setTimeout(resolve, milliseconds));
}

async function loadApprovalEvidence(id: string, isCurrent: () => boolean) {
  if (!isCurrent()) throw new DOMException("Workspace access changed.", "AbortError");
  const response = await fetch(`/api/approvals/${encodeURIComponent(id)}`);
  const body: unknown = await response.json().catch(() => ({}));
  if (!isCurrent()) throw new DOMException("Workspace access changed.", "AbortError");
  if (!response.ok) {
    throw new Error(errorMessage(body, "Approval evidence is temporarily unavailable."));
  }
  const approval = parseVoiceApprovalEvidence(isRecord(body) ? body.approval : undefined);
  if (approval.id !== id) throw new Error("Approval evidence did not match the requested action.");
  return approval;
}

async function waitForVoiceRun(
  runId: string,
  previousApprovalId: string,
  isCurrent: () => boolean,
): Promise<{
  response?: string;
  threadId?: string;
  approval?: VoiceApprovalEvidence;
  message?: string;
}> {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    if (!isCurrent()) return { message: "The voice session ended." };
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}`);
    const body: unknown = await response.json().catch(() => ({}));
    if (!isCurrent()) return { message: "The voice session ended." };
    if (!response.ok) {
      throw new Error(errorMessage(body, "The approved run status is unavailable."));
    }
    const run = isRecord(body) && isRecord(body.run) ? body.run : {};
    if (run.id !== runId) throw new Error("The approved run response did not match the requested run.");
    const status = typeof run.status === "string" ? run.status : "";
    if (status === "completed") {
      return {
        response: typeof run.response === "string" ? run.response : "Task completed.",
        threadId: typeof run.threadId === "string" ? run.threadId : undefined,
      };
    }
    if (status === "waiting_approval") {
      const waiting = isRecord(run.waitingApproval) ? run.waitingApproval : {};
      if (
        typeof waiting.executionId === "string" &&
        waiting.executionId !== previousApprovalId
      ) {
        return { approval: await loadApprovalEvidence(waiting.executionId, isCurrent) };
      }
    }
    if (["failed", "canceled", "rejected"].includes(status)) {
      return {
        message: typeof run.error === "string"
          ? run.error
          : `The run ended with status ${status}.`,
      };
    }
    await delay(2_000);
  }
  return { message: "Approval recorded. The task continues in Activity." };
}

async function waitForDataChannelOpen(
  channel: RTCDataChannel,
  isCurrent: () => boolean,
  peer: RTCPeerConnection,
) {
  while (channel.readyState === "connecting") {
    if (!isCurrent()) throw new DOMException("Canceled", "AbortError");
    if (peer.connectionState === "failed" || peer.connectionState === "closed") break;
    await delay(50);
  }
  if (!isCurrent()) throw new DOMException("Canceled", "AbortError");
  if (channel.readyState !== "open") {
    throw new RealtimeConnectionError(
      "Live audio could not connect. Check whether your network allows live audio, then try again.",
      "Audio connection · listening channel closed before it was ready",
    );
  }
}

/** One deadline covers the request and its response body. Cancellation also
 * releases callers waiting on browser WebRTC promises that cannot be aborted. */
async function withVoiceStartupDeadline<T>(
  controller: AbortController,
  timeoutMs: number,
  timeoutError: RealtimeConnectionError,
  operation: () => Promise<T>,
): Promise<T> {
  if (controller.signal.aborted) throw new DOMException("Canceled", "AbortError");
  let timer: number | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new DOMException("Canceled", "AbortError"));
    controller.signal.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => {
      reject(timeoutError);
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(), interrupted]);
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener("abort", onAbort);
  }
}
