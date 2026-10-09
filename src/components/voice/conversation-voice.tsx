"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AudioLines, Check, Captions, Loader2, Mic, MicOff, PhoneOff, ShieldCheck, SlidersHorizontal, Volume2, X } from "lucide-react";
import { clsx } from "clsx";
import { requestCurrentMicrophone } from "./microphone-attempt";
import { VoiceAtlasStage } from "./voice-mode";
import { useWorkspaceSession } from "@/components/app-shell/session-context";
import { CompanionAtlasPortrait, useCompanionAtlasPlayer } from "@/components/companion-atlas-player";
import type { CompanionState } from "@/lib/companion/presentation";
import { useVoiceAppearance } from "./use-voice-appearance";
import { classifyRealtimeError, RealtimeConnectionError, realtimeConnectionFailure } from "@/lib/voice/realtime-error";
import {
  voiceConversationStartResponseSchema,
  type VoiceConversationCommandContext,
  type VoiceConversationStartRequest,
  type VoiceConversationStartResponse,
} from "@/lib/voice/conversation-contracts";
import type { VoiceConversationInput } from "@/lib/voice/command-input";
import type { VoiceCommandReply } from "@/lib/voice/command-review";
import styles from "./voice-mode.module.css";
import conversationStyles from "./conversation-voice.module.css";

export type ConversationVoiceConfiguration = Pick<VoiceConversationStartRequest,
  "agentId" | "projectId" | "mode" | "contextScope" | "contextReferences">;
export type ConversationVoiceRequest = Readonly<{
  request: string;
  voiceInput: VoiceConversationInput;
  commandContext: VoiceConversationCommandContext;
}>;
type Caption = { itemId: string; role: "user" | "assistant"; text: string; interrupted?: boolean };
type Phase = "notice" | "requesting" | "connecting" | "listening" | "thinking" | "speaking" | "reconnecting" | "error";
type Call = {
  controller: AbortController;
  scope: string;
  configurationKey: string;
  configuration: ConversationVoiceConfiguration;
  session?: VoiceConversationStartResponse;
  stream?: MediaStream;
  peer?: RTCPeerConnection;
  channel?: RTCDataChannel;
  ended: boolean;
  muted: boolean;
  startedAt: number;
  reconnectCount: number;
  reconnecting: boolean;
  reconnectTimer?: number;
  expiryTimer?: number;
  transportVersion: number;
  toolIds: Set<string>;
  tools: Promise<void>;
  blockedWork: boolean;
  responseActive: boolean;
  responsePending: boolean;
  userSpeaking: boolean;
  userItemId?: string;
  outputResponseId?: string;
  outputBlocked: boolean;
  interruptedResponses: Set<string>;
  drainedResponses: Set<string>;
  assistantCaptions: Map<string, { responseId: string; caption: Caption }>;
  historyIds: Set<string>;
  historyQueue: Caption[];
  historyFlush?: Promise<void>;
  historyFailed: boolean;
  turnCount: number;
  providerErrorCode?: string;
};

type Props = {
  disabled?: boolean;
  disabledReason?: string;
  agentName: string;
  conversationId?: string;
  configuration: ConversationVoiceConfiguration;
  /** Changes to the delegated model also end the call instead of changing it silently. */
  modelSelectionKey?: string;
  authorityScope: string;
  isAuthorityCurrent: () => boolean;
  onOpen?: () => void;
  onConversationBound: (id: string) => void;
  onRequest: (request: ConversationVoiceRequest) => Promise<VoiceCommandReply | undefined>;
  onHistorySaved?: (conversationId: string) => void;
};

export function ConversationVoice(props: Props) {
  const latest = useRef(props);
  useLayoutEffect(() => { latest.current = props; });
  const mounted = useRef(true);
  const callRef = useRef<Call | undefined>(undefined);
  const audioRef = useRef<HTMLAudioElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const captionsEndRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [reaction, setReaction] = useState(0);
  const { session: workspace, status: workspaceStatus } = useWorkspaceSession();
  const owner = workspaceStatus === "ready" && workspace?.context?.tenantId && workspace.context.actorId
    && (!workspace.authEnabled || workspace.authenticated) && props.isAuthorityCurrent()
    ? { tenantId: workspace.context.tenantId, actorId: workspace.context.actorId } : undefined;
  const { appearance, setAppearance, persistenceNotice, available: appearanceAvailable } = useVoiceAppearance(owner);
  const [phase, setPhase] = useState<Phase>("notice");
  const [muted, setMuted] = useState(false);
  const [microphoneOpen, setMicrophoneOpen] = useState(false);
  const [outputActive, setOutputActive] = useState(false);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [agentName, setAgentName] = useState(props.agentName);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [error, setError] = useState("");
  const [detail, setDetail] = useState("");
  const [notice, setNotice] = useState("");
  const [historyWarning, setHistoryWarning] = useState("");
  const [approvalPending, setApprovalPending] = useState(false);
  const titleId = useId();
  const statusId = useId();
  const configurationKey = JSON.stringify([props.configuration, props.modelSelectionKey]);
  const active = !["notice", "error"].includes(phase);

  function hasAuthority(call: Call) {
    return latest.current.authorityScope === call.scope && latest.current.isAuthorityCurrent();
  }
  function current(call: Call) {
    return mounted.current && callRef.current === call && !call.ended && hasAuthority(call);
  }
  function send(call: Call, event: Record<string, unknown>) {
    if (!current(call) || call.channel?.readyState !== "open") return false;
    call.channel.send(JSON.stringify(event));
    return true;
  }
  function closeTransport(call: Call) {
    if (call.reconnectTimer !== undefined) window.clearTimeout(call.reconnectTimer);
    if (call.expiryTimer !== undefined) window.clearTimeout(call.expiryTimer);
    call.reconnectTimer = undefined;
    call.expiryTimer = undefined;
    disconnectPeer(call);
    call.stream?.getTracks().forEach((track) => track.stop());
    call.stream = undefined;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.srcObject = null;
    }
  }
  async function flushHistory(call: Call, retry = false) {
    while (call.historyFlush) await call.historyFlush;
    if (!call.session || !hasAuthority(call) || (call.historyFailed && !retry)) return;
    call.historyFailed = false;
    const session = call.session;
    const work = (async () => {
      while (call.historyQueue.length && hasAuthority(call)) {
        const batch = call.historyQueue.slice(0, 4);
        while (batch.length > 1 && new TextEncoder().encode(JSON.stringify(batch)).byteLength > 60_000) batch.pop();
        try {
          await bounded(async (signal) => {
            const response = await fetch("/api/voice/conversation/turns", {
              method: "POST", headers: { "content-type": "application/json" }, signal,
              body: JSON.stringify({ schemaVersion: 2, sessionId: session.sessionId, conversationId: session.conversationId, turns: batch }),
            });
            if (!response.ok) throw new Error("History save failed.");
            const result: unknown = await response.json();
            if (!isRecord(result) || result.recorded !== true) throw new Error("History save was not confirmed.");
          }, 8_000, undefined, "Conversation history took too long to save.");
          call.historyQueue.splice(0, batch.length);
        } catch {
          call.historyFailed = true;
          if (mounted.current && callRef.current === call) setHistoryWarning("Some captions have not been saved yet. Voice can continue; keep important details until history is available.");
          break;
        }
      }
    })();
    call.historyFlush = work;
    await work;
    if (call.historyFlush === work) call.historyFlush = undefined;
  }
  function saveCaption(call: Call, caption: Caption) {
    if (call.historyIds.has(caption.itemId) || !caption.text.trim()) return;
    call.historyIds.add(caption.itemId);
    call.turnCount += 1;
    if (call.historyQueue.length >= 64) {
      setHistoryWarning("Conversation history is unavailable. Recent captions remain visible while voice continues.");
      return;
    }
    call.historyQueue.push({ ...caption, text: caption.text.trim().slice(0, 12_000) });
    void flushHistory(call);
  }
  async function finalize(call: Call, outcome: "ended" | "failed") {
    // The server accepts history only while the session is active. Flush it
    // before the close receipt, even though local audio stops immediately.
    await flushHistory(call, true);
    if (!call.session || !hasAuthority(call)) return;
    const session = call.session;
    await bounded(async (signal) => {
      await fetch("/api/voice/conversation/session", {
        method: "PATCH", headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({ schemaVersion: 2, sessionId: session.sessionId, conversationId: session.conversationId,
          outcome, durationMilliseconds: Math.min(30 * 60_000, Math.max(0, Date.now() - call.startedAt)),
          turnCount: call.turnCount, reconnectCount: call.reconnectCount, providerErrorCode: call.providerErrorCode }),
      });
    }, 8_000, undefined, "Voice session close was not confirmed.").catch(() => undefined);
    if (mounted.current && hasAuthority(call)) latest.current.onHistorySaved?.(session.conversationId);
  }
  function endCall(close = true, failure?: unknown) {
    const call = callRef.current;
    if (call) {
      if (call.outputResponseId) interruptResponse(call, call.outputResponseId);
      call.ended = true;
      call.controller.abort();
      closeTransport(call);
      callRef.current = undefined;
      void finalize(call, failure ? "failed" : "ended");
    }
    if (!mounted.current) return;
    setMicrophoneOpen(false);
    setOutputActive(false);
    if (failure) {
      setPhase("error");
      setError(failure instanceof Error ? failure.message : "Voice disconnected. Try starting it again.");
      setDetail(failure instanceof RealtimeConnectionError ? failure.detail : "");
    } else if (close) {
      setOpen(false);
      window.requestAnimationFrame(() => triggerRef.current?.focus());
    }
  }
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      endCall();
    };
  }, []);
  useEffect(() => {
    const call = callRef.current;
    if (!call) return;
    if (!hasAuthority(call) || configurationKey !== call.configurationKey ||
        (props.conversationId && call.session && props.conversationId !== call.session.conversationId)) {
      endCall();
    }
  }, [configurationKey, props.conversationId, props.authorityScope, props.isAuthorityCurrent]);
  useEffect(() => {
    if (!open) return;
    const overflow = document.body.style.overflow;
    if (!active) document.body.style.overflow = "hidden";
    primaryRef.current?.focus({ preventScroll: true });
    const keydown = (event: KeyboardEvent) => {
      if (active && !dialogRef.current?.contains(document.activeElement)) return;
      if (event.key === "Escape") { event.preventDefault(); endCall(); }
      if (active || event.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], summary, [tabindex="0"]'));
      const first = items[0];
      const last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", keydown);
    return () => { if (!active) document.body.style.overflow = overflow; window.removeEventListener("keydown", keydown); };
  }, [open, active]);
  useEffect(() => { captionsEndRef.current?.scrollIntoView({ block: "nearest" }); }, [captions, captionsOpen]);

  function updateCaption(caption: Caption, append = false) {
    setCaptions((previous) => {
      const existing = previous.find((item) => item.itemId === caption.itemId);
      const next = { ...caption, text: (append ? `${existing?.text || ""}${caption.text}` : caption.text).slice(0, 12_000) };
      return (existing ? previous.map((item) => item.itemId === caption.itemId ? next : item) : [...previous, next]).slice(-40);
    });
  }
  function completeAssistant(call: Call, responseId: string) {
    for (const [itemId, entry] of call.assistantCaptions) {
      if (entry.responseId !== responseId) continue;
      call.assistantCaptions.delete(itemId);
      const caption = call.interruptedResponses.has(responseId)
        ? { ...entry.caption, text: "[Reply interrupted]", interrupted: true }
        : entry.caption;
      updateCaption(caption);
      saveCaption(call, caption);
    }
  }
  function interruptResponse(call: Call, responseId: string) {
    if (!responseId) return;
    call.interruptedResponses.add(responseId);
    completeAssistant(call, responseId);
  }
  function requestResponse(call: Call) {
    if (call.responseActive || call.userSpeaking) { call.responsePending = true; return; }
    call.responsePending = false;
    if (send(call, { type: "response.create" })) call.responseActive = true;
  }
  function delegate(call: Call, event: Record<string, unknown>) {
    const callId = safeId(event.call_id);
    if (!callId || call.toolIds.has(callId)) return;
    call.toolIds.add(callId);
    const version = call.transportVersion;
    call.tools = call.tools.then(async () => {
      if (!current(call) || version !== call.transportVersion || call.channel?.readyState !== "open" || !call.session) return;
      let result: Record<string, unknown>;
      let args: unknown;
      try { args = typeof event.arguments === "string" && event.arguments.length <= 16_384 ? JSON.parse(event.arguments) : undefined; } catch { /* Rejected below. */ }
      if (event.name !== "ask_asael" || !isRecord(args) || Object.keys(args).some((key) => key !== "request") ||
          typeof args.request !== "string" || !args.request.trim() || args.request.length > 8_000) {
        result = { status: "rejected", message: "The app request was invalid. Ask the user to restate the request." };
      } else if (call.blockedWork) {
        result = { status: "waiting", message: "A previous task needs review in the conversation or approvals inbox. Do not submit it again." };
      } else {
        setNotice("Working on your request. You can keep talking.");
        try {
          const reply = await latest.current.onRequest({
            request: args.request.trim(),
            voiceInput: { schemaVersion: 2, source: "realtime_voice", sessionId: call.session.sessionId,
              conversationId: call.session.conversationId, provider: "openai", turnId: callId },
            commandContext: call.session.commandContext,
          });
          if (!reply) {
            call.blockedWork = true;
            result = { status: "unconfirmed", message: "The task outcome is not confirmed. Ask the user to check the conversation or History. Do not claim success or repeat the task." };
          } else {
            call.blockedWork = Boolean(reply.approval);
            if (current(call)) setApprovalPending(Boolean(reply.approval));
            result = { status: reply.approval ? "approval_required" : "returned", result: reply.text.slice(0, 24_000),
              ...(reply.approval ? { message: "The action has not been approved. The user can review it in the approvals inbox; spoken agreement does not approve it." } : {}) };
          }
        } catch {
          call.blockedWork = true;
          result = { status: "unconfirmed", message: "The task result could not be confirmed. Check History before retrying. Do not claim success or submit it again." };
        }
        if (current(call)) setNotice(call.blockedWork ? "Your task needs review in the conversation or approvals inbox." : "Your request has a response.");
      }
      if (!current(call) || version !== call.transportVersion) return;
      if (send(call, { type: "conversation.item.create", item: { type: "function_call_output", call_id: callId, output: JSON.stringify(result) } })) {
        requestResponse(call);
      }
    }).catch(() => { if (current(call)) setNotice("The task connection ended. Check History before trying the request again."); });
  }
  function receive(call: Call, event: unknown) {
    if (!current(call) || !isRecord(event)) return;
    const type = event.type;
    const itemId = safeId(event.item_id);
    const responseId = safeId(event.response_id);
    if (type === "input_audio_buffer.speech_started") {
      if (call.muted) return;
      call.userSpeaking = true;
      call.userItemId = itemId;
      if (call.outputResponseId) interruptResponse(call, call.outputResponseId);
      setOutputActive(false);
      setReaction((value) => value + 1);
      setPhase("listening");
    } else if (type === "input_audio_buffer.speech_stopped") {
      call.userSpeaking = false;
      call.userItemId = undefined;
      if (!call.muted) setPhase("thinking");
    } else if (type === "conversation.item.input_audio_transcription.delta" && itemId && typeof event.delta === "string") {
      updateCaption({ itemId, role: "user", text: event.delta }, true);
    } else if (type === "conversation.item.input_audio_transcription.completed" && itemId && typeof event.transcript === "string") {
      const caption: Caption = { itemId, role: "user", text: event.transcript.slice(0, 12_000) };
      updateCaption(caption); saveCaption(call, caption);
    } else if (type === "conversation.item.input_audio_transcription.failed") {
      setNotice("A spoken turn could not be captioned. Please repeat it if the reply missed your meaning.");
    } else if (type === "response.created") {
      call.responseActive = true;
      call.responsePending = false;
      if (!call.userSpeaking) setPhase("thinking");
    } else if (type === "response.output_audio_transcript.delta" && itemId && responseId && typeof event.delta === "string") {
      if (!call.interruptedResponses.has(responseId)) updateCaption({ itemId, role: "assistant", text: event.delta }, true);
    } else if (type === "response.output_audio_transcript.done" && itemId && responseId && typeof event.transcript === "string") {
      call.assistantCaptions.set(itemId, { responseId, caption: { itemId, role: "assistant", text: event.transcript.slice(0, 12_000) } });
      if (call.drainedResponses.has(responseId) || call.interruptedResponses.has(responseId)) completeAssistant(call, responseId);
    } else if (type === "output_audio_buffer.started") {
      call.outputResponseId = responseId;
      if (responseId && call.outputBlocked) call.interruptedResponses.add(responseId);
      setReaction((value) => value + 1);
      setOutputActive(true); setPhase("speaking");
    } else if (type === "output_audio_buffer.stopped" && responseId) {
      call.drainedResponses.add(responseId);
      completeAssistant(call, responseId);
      if (call.outputResponseId === responseId) call.outputResponseId = undefined;
      setOutputActive(false); setPhase("listening");
    } else if (type === "output_audio_buffer.cleared" && responseId) {
      interruptResponse(call, responseId);
      if (call.outputResponseId === responseId) call.outputResponseId = undefined;
      setOutputActive(false); setPhase("listening");
    } else if (type === "response.function_call_arguments.done") {
      delegate(call, event);
    } else if (type === "response.done" && isRecord(event.response)) {
      call.responseActive = false;
      const id = safeId(event.response.id);
      if (id && event.response.status !== "completed") interruptResponse(call, id);
      if (Array.isArray(event.response.output)) {
        for (const item of event.response.output) if (isRecord(item) && item.type === "function_call") delegate(call, item);
      }
      if (call.responsePending) requestResponse(call);
      if (!call.outputResponseId && !call.userSpeaking) setPhase("listening");
    } else if (type === "error") {
      const failure = classifyRealtimeError(event);
      if (failure.emptyCommit) return;
      call.providerErrorCode = failure.code;
      if (failure.fatal) endCall(false, new Error("This voice session has ended. Start again to continue the conversation."));
      else setNotice("The voice service could not complete one step. Please repeat your question if needed; app tasks were not retried.");
    }
  }
  async function connect(call: Call, reconnectAttempt: number) {
    const previous = call.session;
    const session = await bounded(async (signal) => {
      const response = await fetch("/api/voice/conversation/session", {
        method: "POST", headers: { "content-type": "application/json" }, signal,
        body: JSON.stringify({ schemaVersion: 2, ...call.configuration,
          conversationId: previous?.conversationId || latest.current.conversationId,
          ...(reconnectAttempt && previous ? { sessionId: previous.sessionId } : {}), reconnectAttempt,
          providerConsent: true, continuousConsent: true, audioRetention: "not_stored_by_asael", transcriptRetention: "conversation_history" }),
      });
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw conversationConnectionFailure("session", response.status, body);
      return voiceConversationStartResponseSchema.parse(body);
    }, 45_000, call.controller.signal, "Voice setup took too long. Check your connection and try again.");
    if (!current(call)) throw canceled();
    call.session = session;
    setAgentName(session.agentName);
    latest.current.onConversationBound(session.conversationId);
    const peer = new RTCPeerConnection();
    call.peer = peer;
    call.transportVersion += 1;
    const version = call.transportVersion;
    const channel = peer.createDataChannel("oai-events");
    call.channel = channel;
    call.stream?.getAudioTracks().forEach((track) => peer.addTrack(track, call.stream!));
    peer.addEventListener("track", (event) => {
      if (!current(call) || call.peer !== peer || !audioRef.current) return;
      audioRef.current.srcObject = event.streams[0] || new MediaStream([event.track]);
      void audioRef.current.play().catch(() => {
        if (!current(call)) return;
        call.outputBlocked = true;
        if (call.outputResponseId) interruptResponse(call, call.outputResponseId);
        setAudioBlocked(true);
      });
    });
    channel.addEventListener("message", (event) => {
      if (call.transportVersion !== version || typeof event.data !== "string" || event.data.length > 250_000) return;
      try { receive(call, JSON.parse(event.data)); } catch { /* Untrusted events do not control application authority. */ }
    });
    await bounded(async (signal) => {
      const offer = await peer.createOffer();
      if (!current(call) || call.peer !== peer) throw canceled();
      await peer.setLocalDescription(offer);
      if (!offer.sdp) throw new Error("The browser could not prepare live audio. Try another browser.");
      const response = await fetch(session.transportUrl, {
        method: "POST", headers: { authorization: `Bearer ${session.clientSecret}`, "content-type": "application/sdp" }, body: offer.sdp, signal,
      });
      const sdp = await response.text();
      if (!current(call) || call.peer !== peer) throw canceled();
      if (!response.ok) {
        let body: unknown;
        if (sdp.length <= 16_384) { try { body = JSON.parse(sdp); } catch { /* Never show provider text. */ } }
        throw conversationConnectionFailure("audio", response.status, body);
      }
      if (!sdp.startsWith("v=0") || sdp.length > 1_000_000) throw new Error("The voice service returned an unusable audio connection. Try again.");
      await peer.setRemoteDescription({ type: "answer", sdp });
    }, 20_000, call.controller.signal, "The audio connection took too long. Check your network and try again.");
    await bounded(async (signal) => {
      while (channel.readyState === "connecting") {
        if (signal.aborted || !current(call)) throw canceled();
        if (peer.connectionState === "failed" || peer.connectionState === "closed") break;
        await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
      }
      if (channel.readyState !== "open") throw new Error("Live audio could not connect. Check your network or try another browser.");
    }, 15_000, call.controller.signal, "Live audio could not connect on this network. Check your connection and try again.");
    if (!current(call)) throw canceled();
    call.reconnecting = false;
    setPhase("listening");
    const recover = () => {
      if (!current(call) || call.peer !== peer || call.reconnecting || call.reconnectTimer !== undefined) return;
      call.reconnectTimer = window.setTimeout(() => {
        call.reconnectTimer = undefined;
        if (current(call) && call.peer === peer && (channel.readyState !== "open" || ["failed", "disconnected"].includes(peer.connectionState))) void reconnect(call);
      }, 1_000);
    };
    peer.addEventListener("connectionstatechange", () => { if (["failed", "disconnected"].includes(peer.connectionState)) recover(); });
    channel.addEventListener("close", recover);
    call.expiryTimer = window.setTimeout(() => {
      if (current(call)) endCall(false, new Error("This voice session has reached its time limit. Start again to continue."));
    }, Math.max(1_000, Math.min(30 * 60_000, Date.parse(session.expiresAt) - Date.now() - 15_000)));
  }
  async function reconnect(call: Call) {
    if (!current(call) || call.reconnecting) return;
    call.reconnecting = true;
    setOutputActive(false); setPhase("reconnecting");
    interruptResponse(call, call.outputResponseId || "");
    call.outputResponseId = undefined;
    call.responseActive = false;
    call.responsePending = false;
    disconnectPeer(call);
    if (call.expiryTimer !== undefined) window.clearTimeout(call.expiryTimer);
    while (current(call) && call.reconnectCount < 3) {
      call.reconnectCount += 1;
      try { await flushHistory(call); await connect(call, call.reconnectCount); return; }
      catch (failure) {
        disconnectPeer(call);
        if (!current(call)) return;
        if (call.reconnectCount >= 3) { endCall(false, readableFailure(failure)); return; }
      }
    }
    if (current(call)) endCall(false, new Error("Voice disconnected. Start again to continue; existing app tasks remain in History."));
  }
  async function start() {
    if (callRef.current || props.disabled || !props.isAuthorityCurrent()) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === "undefined") {
      setPhase("error"); setError("This browser cannot open live audio. Open Asael in a full browser with microphone support."); return;
    }
    if (props.configuration.contextScope === "mission" || props.configuration.contextScope === "explicit_selection") {
      setPhase("error"); setError("Choose conversation, project, workspace, or current-turn context before starting voice. The current context needs a separate review."); return;
    }
    const call: Call = { controller: new AbortController(), scope: props.authorityScope, configurationKey,
      configuration: structuredClone(props.configuration), ended: false, muted: false, startedAt: Date.now(), reconnectCount: 0,
      reconnecting: false, transportVersion: 0, toolIds: new Set(), tools: Promise.resolve(), blockedWork: false,
      responseActive: false, responsePending: false, userSpeaking: false, outputBlocked: false, interruptedResponses: new Set(), drainedResponses: new Set(),
      assistantCaptions: new Map(), historyIds: new Set(), historyQueue: [], historyFailed: false, turnCount: 0 };
    callRef.current = call;
    setCaptions([]); setError(""); setDetail(""); setNotice(""); setHistoryWarning(""); setApprovalPending(false);
    setMuted(false); setAudioBlocked(false); setAgentName(props.agentName); setPhase("requesting");
    try {
      const stream = await bounded((signal) => requestCurrentMicrophone(
        () => navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } }),
        () => current(call) && !signal.aborted,
      ), 30_000, call.controller.signal,
      "Microphone permission is still pending. Allow it in your browser or site settings. If no prompt appears, open Asael in a full browser.");
      if (!stream || !current(call)) { stream?.getTracks().forEach((track) => track.stop()); return; }
      call.stream = stream;
      const tracks = stream.getAudioTracks();
      if (!tracks.length) throw new Error("No microphone was found. Connect one and try again.");
      setMicrophoneOpen(tracks.some((track) => track.readyState === "live" && track.enabled));
      for (const track of tracks) track.addEventListener("ended", () => {
        if (current(call) && call.stream?.getAudioTracks().every((item) => item.readyState === "ended")) {
          endCall(false, new Error("The microphone disconnected. Check microphone access, then start voice again."));
        }
      });
      setPhase("connecting");
      await connect(call, 0);
    } catch (failure) {
      if (!current(call)) return;
      endCall(false, readableFailure(failure));
    }
  }
  function toggleMute() {
    const call = callRef.current;
    if (!call || !current(call)) return;
    call.muted = !call.muted;
    call.stream?.getAudioTracks().forEach((track) => { track.enabled = !call.muted; });
    if (call.muted && call.userSpeaking) send(call, { type: "input_audio_buffer.clear" });
    call.userSpeaking = false;
    if (call.responsePending) requestResponse(call);
    setMuted(call.muted);
    setMicrophoneOpen(!call.muted && Boolean(call.stream?.getAudioTracks().some((track) => track.readyState === "live")));
  }
  const busy = ["requesting", "connecting", "reconnecting"].includes(phase);
  const speaking = outputActive && !audioBlocked;
  const label = phase === "requesting" ? "Allow microphone access" : phase === "connecting" ? "Connecting" : phase === "reconnecting" ? "Reconnecting"
    : phase === "error" ? "Voice paused" : speaking ? "Speaking" : phase === "thinking" ? "Thinking" : muted ? "Microphone off" : microphoneOpen ? "Listening" : "Ready";
  const lastCaption = captions.at(-1);
  const portraitState: CompanionState = phase === "error" || phase === "reconnecting" ? "blocked" : speaking ? "responding"
    : busy || phase === "thinking" ? "working" : muted ? "paused" : microphoneOpen ? "listening" : "available";
  return <>
    <button ref={triggerRef} type="button" className={styles.trigger} disabled={props.disabled}
      title={props.disabledReason || (open ? "Voice conversation is open" : "Start a voice conversation")} aria-label={open ? "Voice conversation is open" : `Start voice conversation with ${props.agentName}`} aria-haspopup="dialog" aria-expanded={open}
      onClick={() => { if (open) { primaryRef.current?.focus(); return; } props.onOpen?.(); setAgentName(props.agentName); setPhase("notice"); setError(""); setDetail(""); setOpen(true); }}>
      <AudioLines size={17} aria-hidden="true" />
    </button>
    <audio ref={audioRef} autoPlay playsInline onPlaying={() => {
      const call = callRef.current;
      if (call) call.outputBlocked = false;
      setAudioBlocked(false);
    }} />
    {open && active ? <div className={conversationStyles.presenceLayer}>
      <section ref={dialogRef} className={conversationStyles.presence} role="region" aria-labelledby={titleId}
        data-voice-phase={phase} data-voice-appearance={appearance}>
        <h2 id={titleId} className="sr-only">Conversation with {agentName}</h2>
        {captionsOpen ? <section className={conversationStyles.captionPanel} aria-label="Conversation captions">
          <header><h3>Conversation</h3><button type="button" aria-label="Hide captions" onClick={() => setCaptionsOpen(false)}><X size={17} aria-hidden="true" /></button></header>
          <div className={conversationStyles.captionScroll}>
            {captions.length ? captions.map((caption) => <div key={caption.itemId} className={conversationStyles.caption} data-speaker={caption.role}>
              <span>{caption.role === "user" ? "You" : agentName}</span><p>{caption.text}</p>
            </div>) : <p className={conversationStyles.captionEmpty}>Your conversation will appear here as you speak.</p>}
            <div ref={captionsEndRef} />
          </div>
        </section> : null}
        <div className={conversationStyles.presenceToolbar}>
          <button type="button" aria-label={captionsOpen ? "Hide captions" : "Show captions"} title={captionsOpen ? "Hide captions" : "Show captions"}
            aria-pressed={captionsOpen} onClick={() => setCaptionsOpen((value) => !value)}><Captions size={17} aria-hidden="true" /></button>
          <details className={conversationStyles.appearanceMenu}>
            <summary aria-label="Voice appearance" title="Voice appearance"><SlidersHorizontal size={16} aria-hidden="true" /></summary>
            <div className={conversationStyles.appearanceOptions} role="group" aria-label="Voice appearance">
              <p>Voice appearance</p>
              {(["companion", "perch"] as const).map((value) => <button key={value} type="button" disabled={!appearanceAvailable}
                aria-pressed={appearance === value} onClick={(event) => { if (setAppearance(value)) event.currentTarget.closest("details")?.removeAttribute("open"); }}>
                {value === "companion" ? "Companion" : "Perch"}{appearance === value ? <Check size={16} aria-hidden="true" /> : null}
              </button>)}
              <span role="status">{persistenceNotice || "Saved on this device"}</span>
            </div>
          </details>
        </div>
        <div className={conversationStyles.presenceBody}>
          <ConversationPortrait scope={props.isAuthorityCurrent() ? props.authorityScope : undefined}
            conversationId={callRef.current?.session?.conversationId || props.conversationId} state={portraitState} label={label} reaction={reaction} />
          <div className={conversationStyles.presenceCopy}>
            <div className={conversationStyles.presenceIdentity}><span>{agentName}</span>
              <span className={conversationStyles.microphoneBadge} data-microphone-open={microphoneOpen} role="img" aria-label={`Microphone ${microphoneOpen ? "on" : "off"}`} title={`Microphone ${microphoneOpen ? "on" : "off"}`}>
                {microphoneOpen ? <Mic size={12} aria-hidden="true" /> : <MicOff size={12} aria-hidden="true" />}{!microphoneOpen ? "Off" : null}
              </span>
            </div>
            <p id={statusId} className={conversationStyles.presenceStatus} role="status">{label}</p>
            <p className={conversationStyles.presenceCaption}>{busy ? phase === "requesting" ? "Allow the microphone to begin." : "Opening your conversation…"
              : lastCaption?.text || (muted ? "You can still hear replies." : "Go ahead, I’m listening.")}</p>
          </div>
          <div className={conversationStyles.presenceControls}>
            <button ref={primaryRef} type="button" disabled={busy} onClick={toggleMute} aria-pressed={muted}
              className={conversationStyles.voiceControl} title={muted ? "Unmute microphone" : "Mute microphone"}>
              {muted ? <Mic size={19} aria-hidden="true" /> : <MicOff size={19} aria-hidden="true" />}<span>{muted ? "Unmute" : "Mute"}</span>
            </button>
            <button type="button" className={clsx(conversationStyles.voiceControl, conversationStyles.endControl)} onClick={() => endCall()} title="End voice conversation">
              <PhoneOff size={19} aria-hidden="true" /><span>End</span>
            </button>
          </div>
        </div>
        {audioBlocked || notice || approvalPending || historyWarning ? <div className={conversationStyles.presenceNotice}>
          {audioBlocked ? <button type="button" onClick={() => {
            void audioRef.current?.play().then(() => setAudioBlocked(false)).catch(() => setNotice("Your browser is blocking sound. Check the site's audio permission."));
          }}><Volume2 size={16} aria-hidden="true" />Enable sound</button> : null}
          {notice ? <p role="status">{notice}</p> : null}
          {approvalPending ? <p>An action needs your review. <a href="/app/approvals" onClick={() => endCall()}>Open approvals</a></p> : null}
          {historyWarning ? <p role="status">{historyWarning}</p> : null}
        </div> : null}
      </section>
    </div> : open ? <div className={styles.backdrop}>
      <section ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={statusId}
        className={clsx(styles.dialog, conversationStyles.dialog)} data-voice-phase={phase}>
        <header className={styles.header}>
          <h2 id={titleId} className={styles.title}>Conversation with {agentName}</h2>
          <span className={clsx(styles.microphoneStatus, microphoneOpen && styles.microphoneLive)}>
            {microphoneOpen ? <Mic size={14} aria-hidden="true" /> : <MicOff size={14} aria-hidden="true" />}Microphone {microphoneOpen ? "on" : "off"}
          </span>
          <button type="button" className={styles.close} aria-label="End voice conversation" onClick={() => endCall()}><X size={18} aria-hidden="true" /></button>
        </header>

        <div className={styles.stage}>
          <VoiceAtlasStage scope={props.isAuthorityCurrent() ? props.authorityScope : undefined} conversationId={callRef.current?.session?.conversationId || props.conversationId}
            phase={phase === "notice" ? "consent" : phase === "error" ? "error" : speaking ? "replying" : phase === "thinking" ? "waiting" : busy ? "connecting" : "listening"}
            microphoneOpen={microphoneOpen} replyAudioPlaying={speaking} />
          <div className={styles.session}>
            {phase === "notice" ? <>
              <ShieldCheck size={25} className={styles.consentIcon} aria-hidden="true" />
              <h3 id={statusId} className={styles.consentTitle}>Just start talking</h3>
              <p className={styles.consentDescription}>Speak naturally. {props.agentName} replies when you pause, and you can speak again to interrupt. Your microphone stays on until you mute it or end the conversation.</p>
              <p className={styles.providerDetails}>OpenAI processes live audio. Asael saves conversation captions, but does not store the audio. App requests use your selected agent and context; actions that need approval stay in your approvals inbox.</p>
            </> : <>
              <div className={styles.audioStatus}>{busy ? <Loader2 className={styles.progress} size={24} aria-hidden="true" /> : speaking ? <AudioLines size={24} aria-hidden="true" /> : muted ? <MicOff size={24} aria-hidden="true" /> : <Mic size={24} aria-hidden="true" />}</div>
              <h3 id={statusId} className={styles.statusTitle} role="status">{label}</h3>
              <p className={clsx(styles.statusDetail, phase === "error" && styles.error)}>{phase === "error" ? error : phase === "requesting"
                ? "Allow the microphone in your browser or system prompt. If no prompt appears, check the site's permissions."
                : busy ? "Opening your live conversation." : muted ? "You can still hear replies. Unmute whenever you want to speak." : "Speak naturally. No send button needed."}</p>
              {detail ? <details className={conversationStyles.note}><summary>Connection details</summary><p>{detail}</p></details> : null}
              {notice ? <p className={conversationStyles.note} role="status">{notice}</p> : null}
              {approvalPending ? <p className={conversationStyles.note}>An action needs your review. <a href="/app/approvals" onClick={() => endCall()}>Open approvals</a></p> : null}
              {audioBlocked ? <button type="button" className={clsx("action-button", styles.action)} onClick={() => {
                void audioRef.current?.play().then(() => setAudioBlocked(false)).catch(() => setNotice("Your browser is blocking sound. Check the site's audio permission."));
              }}><Volume2 size={16} aria-hidden="true" />Enable sound</button> : null}
              {historyWarning ? <p className={conversationStyles.note} role="status">{historyWarning}</p> : null}
              {captions.length ? <div className={conversationStyles.captions} aria-label="Conversation captions">
                {captions.map((caption) => <div key={caption.itemId} className={conversationStyles.caption} data-speaker={caption.role}>
                  <span>{caption.role === "user" ? "You" : agentName}</span><p>{caption.text}</p>
                </div>)}<div ref={captionsEndRef} />
              </div> : null}
            </>}
          </div>
        </div>
        <footer className={styles.footer}>
          {phase === "notice" || phase === "error" ? <>
            <button type="button" className={clsx("action-button", styles.action)} onClick={() => endCall()}>Close</button>
            <button ref={primaryRef} type="button" className={clsx("primary-button", styles.action)} onClick={() => void start()}><Mic size={16} aria-hidden="true" />{phase === "error" ? "Start again" : "Start conversation"}</button>
          </> : <>
            <button ref={primaryRef} type="button" className={clsx("action-button", styles.action)} disabled={!active || busy} onClick={toggleMute} aria-pressed={muted}>
              {muted ? <Mic size={17} aria-hidden="true" /> : <MicOff size={17} aria-hidden="true" />}{muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className={clsx("action-button", styles.action)} onClick={() => endCall()}><PhoneOff size={17} aria-hidden="true" />End</button>
          </>}
        </footer>
      </section>
    </div> : null}
  </>;
}


/** The open interruption microphone is independent of ATLAS's current response.
 * Real voice phases choose expression; playback alone enables a speaking loop. */
function ConversationPortrait({ scope, conversationId, state, label, reaction }: {
  scope?: string; conversationId?: string; state: CompanionState; label: string; reaction: number;
}) {
  const presentation = { state, label, detail: "", work: { state, label, detail: "" } };
  const { observationRef, portrait, showPortrait, motion, intensity, assetFailed } = useCompanionAtlasPlayer({
    scope, conversationId, presentation, voice: true, reaction,
  });
  return <aside ref={observationRef} aria-hidden="true" className={conversationStyles.presenceMascot} hidden={!showPortrait}
    data-companion-state={state} data-companion-motion={motion} data-companion-intensity={intensity}
    data-voice-portrait={showPortrait ? "visible" : assetFailed ? "unavailable" : "hidden"}>
    <CompanionAtlasPortrait {...portrait} className={conversationStyles.presencePortrait} size="100%" />
  </aside>;
}

function safeId(value: unknown) { return typeof value === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === "object" && !Array.isArray(value)); }
function canceled() { return new DOMException("Voice ended.", "AbortError"); }
function disconnectPeer(call: Call) {
  // Invalidate queued provider events and unstarted tool calls immediately;
  // a reconnect can spend several seconds preparing its replacement transport.
  call.transportVersion += 1;
  const channel = call.channel;
  const peer = call.peer;
  call.channel = undefined;
  call.peer = undefined;
  channel?.close();
  peer?.close();
}
function readableFailure(failure: unknown) {
  if (failure instanceof RealtimeConnectionError) return failure;
  if (failure instanceof DOMException) {
    if (["NotAllowedError", "SecurityError"].includes(failure.name)) return new Error("Microphone access is blocked. Allow it in your browser and device privacy settings, then try again.");
    if (["NotFoundError", "OverconstrainedError"].includes(failure.name)) return new Error("No microphone was found. Connect a microphone, then try again.");
    if (failure.name === "NotReadableError") return new Error("Your microphone is busy. Close other recording apps, then try again.");
    return new Error("The browser could not establish live audio. Try again or open Asael in another browser.");
  }
  if (failure instanceof TypeError) return new Error("The voice connection could not reach the service. Check your network, then try again.");
  if (failure instanceof Error && failure.name !== "ZodError") return failure;
  return new Error("Voice setup returned an unexpected response. Refresh Asael, then try again.");
}
function conversationConnectionFailure(stage: "session" | "audio", status: number, body: unknown) {
  const fallback = realtimeConnectionFailure(stage, status, body);
  const messages: Record<string, string> = {
    voice_provider_inactive: "Enable your OpenAI connection in Settings, then start voice again.",
    voice_provider_unavailable: "The OpenAI connection could not be opened. Check it in Settings, then try again.",
    voice_provider_not_configured: "Connect OpenAI in Settings to start a live conversation.",
    voice_provider_credential_rejected: "OpenAI refused this connection. Validate your OpenAI connection in Settings, then try again.",
    voice_provider_timeout: "OpenAI took too long to open voice. Check your connection, then try again.",
    voice_provider_limit: "OpenAI cannot start another voice session right now. Check account usage or try again shortly.",
    voice_rate_limited: "Too many voice sessions were started. Wait a minute, then try again.",
    voice_context_needs_selection: "Choose conversation, project, workspace, or current-turn context before starting voice.",
    voice_context_changed: "The selected context changed. Start a new voice conversation to use the current selection.",
    voice_conversation_not_found: "This conversation is unavailable. Open a new conversation, then start voice again.",
    voice_conversation_closed: "This voice session has ended. Start again to continue.",
    voice_context_too_large: "This conversation has too much context for live voice. Start a new conversation or select a smaller project context.",
    voice_model_invalid: "The live voice model is unavailable. Check your OpenAI connection in Settings, then try again.",
    voice_provider_request_rejected: "OpenAI could not start live voice. Check your OpenAI connection in Settings, then try again.",
    voice_connection_unavailable: "The voice connection is temporarily unavailable. Try again shortly.",
    voice_admission_unavailable: "Asael could not prepare this voice session. Try again shortly.",
    voice_provider_contract_invalid: "The voice service returned an unexpected response. Try again shortly.",
  };
  const code = isRecord(body) && typeof body.code === "string" && Object.hasOwn(messages, body.code) ? body.code : undefined;
  return new RealtimeConnectionError(code ? messages[code] : fallback.message.replaceAll("Realtime transcription in Settings → Models", "your OpenAI connection in Settings")
    .replaceAll("the OpenAI provider in Settings → Models", "your OpenAI connection in Settings")
    .replaceAll("Settings → Models, check Realtime transcription", "Settings and check your OpenAI connection"),
  code ? `Voice setup · HTTP ${status} · ${code}` : fallback.detail, code || fallback.providerCode);
}
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, parent: AbortSignal | undefined, message: string): Promise<T> {
  const controller = new AbortController();
  if (parent?.aborted) throw canceled();
  let timer: number | undefined;
  let onAbort: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(canceled()); controller.abort(); };
    parent?.addEventListener("abort", onAbort, { once: true });
    timer = window.setTimeout(() => { reject(new Error(message)); controller.abort(); }, timeoutMs);
  });
  try { return await Promise.race([operation(controller.signal), interrupted]); }
  finally {
    if (timer !== undefined) window.clearTimeout(timer);
    if (onAbort) parent?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
