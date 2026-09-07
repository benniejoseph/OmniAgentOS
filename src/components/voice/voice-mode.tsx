"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, AudioLines, Check, Loader2, Mic, RotateCcw, Send, ShieldCheck, Square, X } from "lucide-react";
import { clsx } from "clsx";
import {
  applyRealtimeTranscriptEvent,
  editRealtimeTranscript,
  EMPTY_REALTIME_TRANSCRIPT,
  realtimeTranscriptConfidence,
  realtimeTranscriptText,
  type RealtimeTranscriptState,
} from "@/lib/voice/realtime-transcript";
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
  onTranscript,
}: {
  disabled?: boolean;
  disabledReason?: string;
  agentName?: string;
  agentVoice?: string;
  conversationId?: string;
  mode?: AgentMode;
  onConversationBound: (conversationId: string) => void;
  onTranscript: (
    text: string,
    conversationId: string,
    review: VoiceCommandReview,
  ) => Promise<VoiceCommandReply | undefined>;
}) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<VoicePhase>("consent");
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("auto");
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [meterLevels, setMeterLevels] = useState(restingMeter);
  const [transcriptState, setTranscriptState] = useState<RealtimeTranscriptState>(EMPTY_REALTIME_TRANSCRIPT);
  const [reviewAttested, setReviewAttested] = useState(false);
  const [pendingApproval, setPendingApproval] = useState<VoiceApprovalEvidence>();
  const [approvalNote, setApprovalNote] = useState("");
  const [decisionMessage, setDecisionMessage] = useState("");
  const [announcement, setAnnouncement] = useState("Voice mode ready.");
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
  const reconnectTimerRef = useRef<number | null>(null);
  const maxSessionTimerRef = useRef<number | null>(null);
  const sessionRef = useRef<VoiceSession | null>(null);
  const transcriptStateRef = useRef<RealtimeTranscriptState>(EMPTY_REALTIME_TRANSCRIPT);
  const recordingStartedAtRef = useRef(0);
  const sessionTokenRef = useRef(0);
  const phaseRef = useRef<VoicePhase>("consent");
  const reconnectingRef = useRef(false);
  const reconnectCountRef = useRef(0);
  const reportedRef = useRef(false);
  const reviewAttestedRef = useRef(false);
  const approvalRunIdRef = useRef("");
  const approvalAgentIdRef = useRef<string | undefined>(undefined);
  const approvalConversationIdRef = useRef("");
  const mountedRef = useRef(true);

  useEffect(() => {
    transcriptStateRef.current = transcriptState;
  }, [transcriptState]);

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
    speechActiveRef.current = false;
    speechControllerRef.current?.abort();
    speechControllerRef.current = null;
    speechPlayerRef.current?.stop();
    speechPlayerRef.current = null;
  }, []);

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
    if (!session || reportedRef.current) return;
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
      }),
      keepalive: true,
    }).catch(() => undefined);
  }, []);

  const resetSession = useCallback(() => {
    sessionRef.current = null;
    transcriptStateRef.current = EMPTY_REALTIME_TRANSCRIPT;
    reconnectCountRef.current = 0;
    reportedRef.current = false;
    reviewAttestedRef.current = false;
    approvalRunIdRef.current = "";
    approvalAgentIdRef.current = undefined;
    approvalConversationIdRef.current = "";
    setTranscriptState(EMPTY_REALTIME_TRANSCRIPT);
    setReviewAttested(false);
    setPendingApproval(undefined);
    setApprovalNote("");
    setDecisionMessage("");
    setElapsedSeconds(0);
    setError("");
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

  useEffect(() => () => {
    mountedRef.current = false;
    sessionTokenRef.current += 1;
    void reportSession("canceled");
    stopSpeech();
    stopTransport();
  }, [reportSession, stopSpeech, stopTransport]);

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
    void reportSession("failed");
    stopSpeech();
    stopTransport();
    setPhase("error");
    setError(message);
    setAnnouncement(message);
  }

  async function issueSession(
    token: number,
    reconnectAttempt: number,
    conversationOverride?: string,
  ): Promise<VoiceSession> {
    const existing = sessionRef.current;
    const controller = new AbortController();
    requestControllerRef.current?.abort();
    requestControllerRef.current = controller;
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
    if (!response.ok) throw new Error(errorMessage(body, "Realtime voice could not start."));
    if (token !== sessionTokenRef.current) throw new DOMException("Canceled", "AbortError");
    return parseVoiceSession(body);
  }

  async function connectPeer(session: VoiceSession, stream: MediaStream, token: number) {
    stopPeer();
    const peer = new RTCPeerConnection();
    peerRef.current = peer;
    for (const track of stream.getAudioTracks()) peer.addTrack(track, stream);
    const channel = peer.createDataChannel("oai-events");
    dataChannelRef.current = channel;
    channel.addEventListener("open", () => {
      if (token !== sessionTokenRef.current || peerRef.current !== peer) return;
      reconnectingRef.current = false;
      setPhase("listening");
      setAnnouncement("Realtime transcription connected. Listening.");
    });
    channel.addEventListener("message", (event) => {
      if (token !== sessionTokenRef.current || typeof event.data !== "string") return;
      let providerEvent: unknown;
      try { providerEvent = JSON.parse(event.data); } catch { return; }
      const eventType = eventTypeOf(providerEvent);
      if (eventType === "input_audio_buffer.speech_started") {
        const interruptedReply = speechActiveRef.current;
        if (interruptedReply) stopSpeech();
        setPhase("speaking");
        setAnnouncement(interruptedReply
          ? "Reply interrupted. Listening to your new turn."
          : "Speech detected. Live transcription is updating.");
      } else if (eventType === "input_audio_buffer.speech_stopped") {
        setPhase("listening");
        setAnnouncement("Turn detected. Listening for more.");
      } else if (eventType === "error") {
        failVoice("The realtime transcription provider reported an error.", token);
        return;
      }
      setTranscriptState((current) => applyRealtimeTranscriptEvent(current, providerEvent));
    });
    peer.addEventListener("connectionstatechange", () => {
      if (token !== sessionTokenRef.current || peerRef.current !== peer || !["failed", "disconnected"].includes(peer.connectionState)) return;
      if (reconnectTimerRef.current !== null) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        if (peerRef.current === peer && ["failed", "disconnected"].includes(peer.connectionState)) void reconnect(token);
      }, 650);
    });

    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    if (!offer.sdp) throw new Error("The browser did not create a realtime audio offer.");
    const form = new FormData();
    form.set("sdp", new Blob([offer.sdp], { type: "application/sdp" }), "offer.sdp");
    const controller = new AbortController();
    requestControllerRef.current = controller;
    const answerResponse = await fetch(session.transportUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${session.clientSecret}` },
      body: form,
      signal: controller.signal,
    });
    const answerSdp = await answerResponse.text();
    if (!answerResponse.ok || answerSdp.length > 1_000_000 || !answerSdp.startsWith("v=0")) throw new Error("The realtime audio connection was rejected.");
    if (token !== sessionTokenRef.current || peerRef.current !== peer) return;
    await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
  }

  async function reconnect(token: number) {
    if (reconnectingRef.current || token !== sessionTokenRef.current) return;
    reconnectingRef.current = true;
    stopPeer();
    const attempt = reconnectCountRef.current + 1;
    if (attempt > 3) {
      failVoice("Realtime voice disconnected after three recovery attempts. Your draft is still available to copy.", token);
      return;
    }
    reconnectCountRef.current = attempt;
    setPhase("reconnecting");
    setAnnouncement(`Connection interrupted. Reconnecting, attempt ${attempt} of 3.`);
    try {
      let stream = streamRef.current;
      if (!stream || stream.getAudioTracks().every((track) => track.readyState === "ended")) {
        stream = await requestMicrophone();
        streamRef.current = stream;
        startMeter(stream);
      }
      const session = await issueSession(token, attempt);
      sessionRef.current = session;
      await connectPeer(session, stream, token);
    } catch (reconnectError) {
      reconnectingRef.current = false;
      if (isAbortError(reconnectError) || token !== sessionTokenRef.current) return;
      reconnectTimerRef.current = window.setTimeout(() => {
        reconnectTimerRef.current = null;
        void reconnect(token);
      }, Math.min(2_000, attempt * 500));
    }
  }

  async function startRealtime() {
    if (disabled) return;
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
      const stream = await requestMicrophone();
      if (!mountedRef.current || token !== sessionTokenRef.current) {
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
      maxSessionTimerRef.current = window.setTimeout(() => void finishListening(), 10 * 60 * 1_000);
    } catch (startError) {
      if (isAbortError(startError) || token !== sessionTokenRef.current) return;
      failVoice(startError instanceof Error ? startError.message : "Realtime voice could not start.", token);
    }
  }

  async function finishListening() {
    const activePhase = phaseRef.current;
    if (!["listening", "speaking", "reconnecting"].includes(activePhase)) return;
    const token = sessionTokenRef.current;
    setPhase("finishing");
    setAnnouncement("Finishing the current transcription turn.");
    const channel = dataChannelRef.current;
    if (activePhase === "speaking" && channel?.readyState === "open") {
      channel.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
    }
    streamRef.current?.getAudioTracks().forEach((track) => { track.enabled = false; });
    await delay(1_200);
    if (token !== sessionTokenRef.current) return;
    stopTransport();
    reviewAttestedRef.current = false;
    setReviewAttested(false);
    setPhase("review");
    setAnnouncement("Transcription stopped. Review and edit before sending.");
  }

  async function startContinuationListening(
    activeConversationId: string,
    token: number,
  ) {
    sessionRef.current = null;
    transcriptStateRef.current = EMPTY_REALTIME_TRANSCRIPT;
    reconnectCountRef.current = 0;
    reportedRef.current = false;
    reviewAttestedRef.current = false;
    setTranscriptState(EMPTY_REALTIME_TRANSCRIPT);
    setReviewAttested(false);
    setElapsedSeconds(0);
    setAnnouncement("Reopening listening so you can interrupt the reply.");
    const stream = await requestMicrophone();
    if (!mountedRef.current || token !== sessionTokenRef.current) {
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
    const channel = dataChannelRef.current;
    if (!channel) throw new Error("The listening channel did not open.");
    await waitForDataChannelOpen(channel, () => (
      mountedRef.current && token === sessionTokenRef.current
    ));
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
    const controller = new AbortController();
    const player = new StreamingPcmPlayer();
    speechControllerRef.current = controller;
    speechPlayerRef.current = player;
    speechActiveRef.current = true;
    setPhase("replying");
    setAnnouncement(`${agentName} is replying. Speak at any time to interrupt.`);
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
          if (token !== sessionTokenRef.current) return;
          setPhase("replying");
          setAnnouncement(`${agentName} is speaking. Speak to interrupt.`);
        },
      });
      return token === sessionTokenRef.current;
    } catch (speechError) {
      if (isAbortError(speechError) || controller.signal.aborted) return false;
      throw speechError;
    } finally {
      if (speechControllerRef.current === controller) {
        speechControllerRef.current = null;
        speechActiveRef.current = false;
      }
      if (speechPlayerRef.current === player) speechPlayerRef.current = null;
    }
  }

  async function sendTranscript() {
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
    const token = sessionTokenRef.current;
    if (!mountedRef.current || token !== sessionTokenRef.current) return;
    onConversationBound(session.conversationId);
    setPhase("waiting");
    setAnnouncement(`${agentName} is working on the reviewed command.`);
    try {
      const reply = await onTranscript(transcript, session.conversationId, review);
      if (!mountedRef.current || token !== sessionTokenRef.current) return;
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
        if (token === sessionTokenRef.current) {
          setPhase("approval");
          setAnnouncement("Review the exact visible action. Spoken words cannot approve it.");
        }
        return;
      }
      await startContinuationListening(session.conversationId, token);
      const completed = await streamReply(reply, session.conversationId, token);
      if (completed && token === sessionTokenRef.current) {
        setPhase("listening");
        setAnnouncement("Reply complete. Listening for your next turn.");
      }
    } catch (sendError) {
      if (isAbortError(sendError) || token !== sessionTokenRef.current) return;
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

  async function decideApproval(decision: "approve" | "reject") {
    const approval = pendingApproval;
    const runId = approvalRunIdRef.current;
    if (!approval || (decision === "approve" && !approval.canApprove)) return;
    if (decision === "reject" && !approval.canReject) return;
    const token = sessionTokenRef.current;
    setPhase("deciding");
    setError("");
    setAnnouncement(`${decision === "approve" ? "Approving" : "Rejecting"} the exact visible action.`);
    try {
      const response = await fetch(`/api/approvals/${encodeURIComponent(approval.id)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "tool",
          decision,
          ...(approvalNote.trim() ? { reason: approvalNote.trim() } : {}),
        }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(errorMessage(body, "The approval decision could not be recorded."));
      if (token !== sessionTokenRef.current) return;
      if (response.status === 202) {
        const refreshed = await loadApprovalEvidence(approval.id);
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
        () => token === sessionTokenRef.current,
      );
      if (token !== sessionTokenRef.current) return;
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
        if (completed && token === sessionTokenRef.current) {
          setPhase("listening");
          setAnnouncement("Approved task complete. Listening for your next turn.");
        }
        return;
      }
      setDecisionMessage(outcome.message || "Approval recorded. The task continues in Activity.");
      setPhase("resolved");
    } catch (decisionError) {
      if (token !== sessionTokenRef.current) return;
      setError(decisionError instanceof Error ? decisionError.message : "The approval decision failed.");
      setPhase("approval");
      setAnnouncement("The approval decision was not recorded.");
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
  const status = voiceStatus(phase, elapsedSeconds, error);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => { resetSession(); setPhase("consent"); setOpen(true); }}
        disabled={disabled}
        title={disabledReason || (disabled ? "Voice mode is unavailable while work is active." : "Start realtime voice mode")}
        className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground disabled:cursor-not-allowed disabled:opacity-35"
        aria-label={`Start voice mode with ${agentName}`}
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
            className="relative flex min-h-[34rem] w-full max-w-lg flex-col overflow-hidden rounded-t-[2rem] border border-line/80 bg-background shadow-2xl outline-none sm:min-h-[36rem] sm:rounded-[2rem]"
          >
            <div className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-[radial-gradient(circle_at_50%_-15%,color-mix(in_oklab,var(--color-primary)_24%,transparent),transparent_68%)]" />
            <header className="relative flex items-center justify-between px-5 py-4">
              <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted">
                <Mic size={14} className="text-primary" aria-hidden="true" />
                <span id="voice-mode-title">Realtime voice to {agentName}</span>
              </div>
              <button type="button" onClick={() => closeDialog()} className="grid size-10 place-items-center rounded-full text-muted transition hover:bg-surface-raised hover:text-foreground" aria-label="Cancel voice mode">
                <X size={18} aria-hidden="true" />
              </button>
            </header>

            {phase === "consent" ? (
              <div className="relative flex flex-1 flex-col px-6 pb-5 pt-3 text-left">
                <div className="mx-auto grid size-24 place-items-center rounded-full border border-primary/30 bg-primary/10 text-primary"><ShieldCheck size={34} aria-hidden="true" /></div>
                <h3 className="mt-6 text-center text-lg font-semibold">Live transcription session</h3>
                <p className="mt-2 text-center text-sm leading-6 text-muted">OpenAI processes live microphone audio to produce partial text. Asael does not store the audio. The transcript remains an editable command draft until you send it, then the exact agent result streams back in Asael&apos;s versioned voice. Speaking interrupts playback.</p>
                <div className="mt-5 rounded-xl border border-line bg-surface px-4 py-3 text-xs leading-5 text-muted">
                  <p><strong className="text-foreground">Provider:</strong> OpenAI</p>
                  <p><strong className="text-foreground">Turn detection:</strong> server voice activity detection</p>
                  <p><strong className="text-foreground">Audio retention:</strong> not stored by Asael</p>
                </div>
                <label className="mt-4 text-xs font-semibold text-foreground">
                  Spoken language
                  <select value={language} onChange={(event) => setLanguage(event.currentTarget.value)} className="mt-1.5 h-11 w-full rounded-lg border border-line bg-background px-3 text-sm font-normal outline-none focus:border-primary">
                    {languageOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </label>
              </div>
            ) : (
              <div className="relative flex flex-1 flex-col items-center overflow-y-auto px-6 pb-4 pt-2 text-center">
                <div className={clsx("relative grid size-32 place-items-center rounded-full border transition-all duration-300", ["speaking", "replying"].includes(phase) ? "border-primary/40 bg-primary/10 shadow-[0_0_55px_color-mix(in_oklab,var(--color-primary)_25%,transparent)]" : "border-line bg-surface")} aria-hidden="true">
                  <div className="flex h-20 items-center gap-1">
                    {meterLevels.map((level, index) => <span key={index} className={clsx("w-1 rounded-full transition-[height,opacity] duration-100", isActivePhase(phase) ? "bg-primary opacity-90" : "bg-muted/45 opacity-55")} style={{ height: `${Math.round(8 + level * 50)}px` }} />)}
                  </div>
                  {["requesting", "connecting", "finishing", "reconnecting", "sending", "waiting", "deciding"].includes(phase) ? <span className="absolute inset-0 grid place-items-center rounded-full bg-background/72 backdrop-blur-sm"><Loader2 size={28} className="animate-spin text-primary" /></span> : null}
                  {phase === "error" ? <span className="absolute inset-0 grid place-items-center rounded-full bg-background/80"><Mic size={28} className="text-danger" /></span> : null}
                </div>
                <p id="voice-mode-status" className="mt-5 text-lg font-semibold tracking-tight">{status.title}</p>
                <p id="voice-mode-detail" className={clsx("mt-1.5 max-w-sm text-sm leading-6", phase === "error" ? "text-danger" : "text-muted")}>{status.detail}</p>
                <p role="status" aria-live="polite" className="sr-only">{announcement}</p>
                {pendingApproval && ["approval", "deciding", "resolved"].includes(phase) ? (
                  <div className="mt-4 w-full rounded-xl border border-warning/40 bg-warning/5 p-4 text-left">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="text-sm font-semibold text-foreground">{pendingApproval.title}</p>
                        <p className="mt-1 text-xs leading-5 text-muted">{pendingApproval.description}</p>
                      </div>
                      <span className="shrink-0 rounded-full bg-warning/15 px-2.5 py-1 text-[11px] font-semibold text-warning">Risk {pendingApproval.riskLevel}</span>
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div><dt className="text-muted">Tool</dt><dd className="mt-0.5 font-mono text-foreground">{pendingApproval.toolId}</dd></div>
                      <div><dt className="text-muted">Reversible</dt><dd className="mt-0.5 font-semibold text-foreground">{pendingApproval.reversible ? "Yes" : "No"}</dd></div>
                    </dl>
                    <p className="mt-3 text-xs leading-5 text-muted">{pendingApproval.reason}</p>
                    <div className="mt-3">
                      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">Exact reviewed input</p>
                      <pre className="mt-1.5 max-h-28 overflow-auto rounded-lg border border-line bg-background p-2.5 text-[11px] leading-5 text-foreground">{JSON.stringify(pendingApproval.input, null, 2)}</pre>
                    </div>
                    <label className="mt-3 block text-xs font-semibold text-foreground">
                      Decision note (optional)
                      <textarea value={approvalNote} onChange={(event) => setApprovalNote(event.currentTarget.value)} maxLength={1_000} rows={2} disabled={phase !== "approval"} className="mt-1.5 w-full resize-none rounded-lg border border-line bg-background px-3 py-2 text-sm font-normal outline-none focus:border-primary disabled:opacity-60" />
                    </label>
                    <p className="mt-2 flex items-start gap-2 text-xs leading-5 text-warning"><AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />Spoken words cannot approve this action. Use a visible button below.</p>
                    {pendingApproval.approvalProgress.required > 1 ? <p className="mt-1 text-xs text-muted">{pendingApproval.approvalProgress.approvals}/{pendingApproval.approvalProgress.required} eligible approvals recorded.</p> : null}
                    {pendingApproval.blockReason ? <p className="mt-1 text-xs leading-5 text-muted">{pendingApproval.blockReason}</p> : null}
                    {decisionMessage ? <p className="mt-2 text-xs font-medium leading-5 text-foreground">{decisionMessage}</p> : null}
                    {error ? <p className="mt-2 text-xs font-medium leading-5 text-danger">{error}</p> : null}
                  </div>
                ) : (
                  <>
                    <label className="mt-4 block w-full text-left text-xs font-semibold text-foreground">
                      Editable transcript
                      <textarea
                        value={transcript}
                        onChange={(event) => {
                          reviewAttestedRef.current = false;
                          setReviewAttested(false);
                          setError("");
                          setTranscriptState((current) => editRealtimeTranscript(current, event.currentTarget.value));
                        }}
                        rows={5}
                        maxLength={100_000}
                        disabled={["requesting", "connecting", "sending", "waiting", "replying"].includes(phase)}
                        placeholder={isActivePhase(phase) ? "Partial transcription will appear here…" : "No speech recognized yet."}
                        className="mt-1.5 min-h-28 w-full resize-none rounded-xl border border-line bg-surface px-3 py-2.5 text-sm font-normal leading-6 outline-none focus:border-primary disabled:opacity-65"
                      />
                    </label>
                    {phase === "review" && confidence.requiresExplicitAttestation ? (
                      <label className="mt-3 flex w-full items-start gap-2 rounded-lg border border-warning/35 bg-warning/5 px-3 py-2.5 text-left text-xs leading-5 text-foreground">
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

            <footer className="relative flex min-h-24 items-center justify-center gap-3 border-t border-line/70 bg-surface/65 px-5 py-4">
              {phase === "consent" ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">Cancel</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void startRealtime()} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90"><Mic size={15} aria-hidden="true" />Agree &amp; start</button>
                </>
              ) : ["listening", "speaking", "reconnecting"].includes(phase) ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">Cancel</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void finishListening()} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90"><Square size={14} fill="currentColor" aria-hidden="true" />Stop &amp; review</button>
                </>
              ) : phase === "review" ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">Cancel</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void sendTranscript()} disabled={!transcript.trim() || (confidence.requiresExplicitAttestation && !reviewAttested)} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-35"><Send size={15} aria-hidden="true" />Send to {agentName}</button>
                </>
              ) : phase === "approval" && pendingApproval ? (
                <>
                  <button type="button" onClick={() => void decideApproval("reject")} disabled={!pendingApproval.canReject} className="min-h-11 rounded-full px-5 text-sm font-semibold text-danger transition hover:bg-danger/10 disabled:opacity-35">Reject</button>
                  <button ref={primaryActionRef} type="button" onClick={() => void decideApproval("approve")} disabled={!pendingApproval.canApprove} title={pendingApproval.blockReason} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90 disabled:opacity-35"><Check size={15} aria-hidden="true" />Approve exact action</button>
                </>
              ) : phase === "deciding" ? (
                <button type="button" disabled className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background opacity-60"><Loader2 size={15} className="animate-spin" aria-hidden="true" />Recording decision</button>
              ) : phase === "resolved" ? (
                <button ref={primaryActionRef} type="button" onClick={() => closeDialog("sent")} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background"><Check size={15} aria-hidden="true" />Done</button>
              ) : phase === "replying" ? (
                <>
                  <button type="button" onClick={() => closeDialog()} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">End voice mode</button>
                  <button ref={primaryActionRef} type="button" onClick={interruptReply} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90"><Square size={14} fill="currentColor" aria-hidden="true" />Interrupt reply</button>
                </>
              ) : phase === "error" ? (
                <>
                  <button type="button" onClick={() => closeDialog("failed")} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">Close</button>
                  <button ref={primaryActionRef} type="button" onClick={retryVoice} className="inline-flex min-h-12 items-center gap-2 rounded-full bg-foreground px-6 text-sm font-semibold text-background transition hover:opacity-90"><RotateCcw size={15} aria-hidden="true" />Try again</button>
                </>
              ) : (
                <button ref={primaryActionRef} type="button" onClick={() => closeDialog()} className="min-h-11 rounded-full px-5 text-sm font-semibold text-muted transition hover:bg-surface-raised hover:text-foreground">Cancel</button>
              )}
            </footer>
          </section>
        </div>
      ) : null}
    </>
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

function voiceStatus(phase: VoicePhase, elapsedSeconds: number, error: string) {
  if (phase === "requesting") return { title: "Allow microphone access", detail: "The provider session starts only after permission is granted." };
  if (phase === "connecting") return { title: "Connecting", detail: "Opening a short-lived transcription-only connection." };
  if (phase === "listening") return { title: formatDuration(elapsedSeconds), detail: "Listening. Partial multilingual text appears below." };
  if (phase === "speaking") return { title: formatDuration(elapsedSeconds), detail: "Speech detected. Server VAD will close this turn after a short pause." };
  if (phase === "reconnecting") return { title: "Reconnecting", detail: "Your editable draft is preserved while the audio connection recovers." };
  if (phase === "finishing") return { title: "Finishing this turn", detail: "Waiting briefly for the last partial transcription." };
  if (phase === "review") return { title: "Review before sending", detail: "Edit the transcript. Nothing is sent to the Command API until you confirm." };
  if (phase === "sending") return { title: "Sending command", detail: "The reviewed text is being attributed to this conversation." };
  if (phase === "waiting") return { title: "Waiting for the result", detail: "The governed agent run is completing before speech playback starts." };
  if (phase === "replying") return { title: "Speaking response", detail: "This is the exact agent result. Speak or use Interrupt reply to stop it." };
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

async function loadApprovalEvidence(id: string) {
  const response = await fetch(`/api/approvals/${encodeURIComponent(id)}`);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(errorMessage(body, "Approval evidence is temporarily unavailable."));
  }
  return parseVoiceApprovalEvidence(isRecord(body) ? body.approval : undefined);
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
    if (!response.ok) {
      throw new Error(errorMessage(body, "The approved run status is unavailable."));
    }
    const run = isRecord(body) && isRecord(body.run) ? body.run : {};
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
        return { approval: await loadApprovalEvidence(waiting.executionId) };
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
) {
  const deadline = Date.now() + 10_000;
  while (channel.readyState === "connecting" && Date.now() < deadline) {
    if (!isCurrent()) throw new DOMException("Canceled", "AbortError");
    await delay(50);
  }
  if (!isCurrent()) throw new DOMException("Canceled", "AbortError");
  if (channel.readyState !== "open") {
    throw new Error("The listening channel did not become ready.");
  }
}
