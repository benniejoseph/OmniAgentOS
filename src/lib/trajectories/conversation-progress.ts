import { createHash } from "node:crypto";
import type { DomainEvent } from "@/lib/events/store";
import type { AgentRunRecord } from "@/lib/runs/types";

export const CONVERSATION_PROGRESS_VERSION =
  "p11.2-conversation-progress:1" as const;

export type ConversationProgressCategory =
  | "request"
  | "plan"
  | "context"
  | "agent"
  | "model"
  | "tool"
  | "browser"
  | "voice"
  | "approval"
  | "evidence"
  | "result"
  | "recovery";

export type ConversationProgressState =
  | "recorded"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "canceled";

export type ConversationProgressItemV1 = Readonly<{
  id: string;
  source: "event" | "checkpoint";
  eventRef: string;
  category: ConversationProgressCategory;
  state: ConversationProgressState;
  title: string;
  summary: string;
  at: string;
  technical: Readonly<{
    eventType: string;
    streamKind: string;
    sequence: number;
  }>;
  checkpoint?: Readonly<{
    checkpointId: string;
    checkpointSha256: string;
    sequence: number;
    boundaryKind: "model" | "tool" | "approval" | "delegation" | "verifier";
    boundaryPhase: "before" | "waiting" | "after";
    lifecycleState: "active" | "waiting" | "terminal";
    resumeDisposition: "resumable" | "awaiting_signal" | "not_resumable";
  }>;
  action?: Readonly<{
    kind: "approval" | "browser" | "checkpoint" | "result";
    label: string;
    href?: string;
  }>;
}>;

export type ConversationProgressV1 = Readonly<{
  schemaVersion: 1;
  version: typeof CONVERSATION_PROGRESS_VERSION;
  runId: string;
  status: AgentRunRecord["status"];
  terminal: boolean;
  headline: string;
  summary: string;
  startedAt: string;
  completedAt?: string;
  agent: Readonly<
    | { state: "unbound" | "definition_unavailable" }
    | {
        state: "ready";
        logicalAgentId: string;
        definitionVersion: number;
        name: string;
        role: string;
        status: string;
      }
  >;
  context: Readonly<{
    state: "not_recorded" | "recorded";
    usedCount: number;
    excludedCount: number;
    droppedCount: number;
    receiptRef?: string;
  }>;
  result: Readonly<{
    state: "pending" | "completed" | "failed" | "canceled";
    responseLength: number;
    groundingStatus?: string;
    citationCount: number;
  }>;
  recovery: Readonly<{
    kind: "cancel" | "approval" | "clarification" | "retry" | "checkpoint" | "none";
    label: string;
    instruction: string;
    href?: string;
  }>;
  counts: Readonly<Record<ConversationProgressCategory, number>>;
  items: readonly ConversationProgressItemV1[];
}>;

type AgentIdentityProjection =
  | { state: "unbound" | "definition_unavailable" }
  | {
      state: "ready";
      card: {
        logicalAgentId: string;
        definitionVersion: number;
        name: string;
        role: string;
        status: string;
      };
    };

const categories: readonly ConversationProgressCategory[] = [
  "request",
  "plan",
  "context",
  "agent",
  "model",
  "tool",
  "browser",
  "voice",
  "approval",
  "evidence",
  "result",
  "recovery",
];

const MAX_PROGRESS_ITEMS = 120;

/**
 * Builds the Conversation activity contract exclusively from persisted,
 * owner-scoped events. It never projects prompts, responses, tool arguments,
 * tool output, credentials, or private reasoning.
 */
export function buildConversationProgressV1(input: {
  run: AgentRunRecord;
  events: DomainEvent[];
  correlationId: string;
  agentIdentity: AgentIdentityProjection;
}): ConversationProgressV1 {
  const tenantId = input.run.tenantId || "default";
  const rootStreamId = `run:${input.run.id}`;
  const related = [...new Map(input.events.map((event) => [event.id, event])).values()]
    .filter((event) =>
      event.tenantId === tenantId &&
      (event.streamId === rootStreamId || event.actorId === input.run.ownerActorId) &&
      (
        event.streamId === rootStreamId ||
        event.correlationId === input.correlationId ||
        isExactRunVoiceEvent(event, input.run.id)
      )
    )
    .sort((left, right) =>
      Date.parse(left.at) - Date.parse(right.at) ||
      left.seq - right.seq ||
      left.id.localeCompare(right.id)
    );
  const allItems = related.flatMap((event) => eventProgressItem(event, input.run.id));
  const items = boundedProgressItems(allItems);
  const latestContext = [...related].reverse().find(
    (event) => event.type === "run.context.receipt",
  );
  const contextPayload = recordValue(latestContext?.payload);
  const checkpointCount = allItems.filter((item) => item.source === "checkpoint").length;
  const counts = Object.fromEntries(
    categories.map((category) => [
      category,
      allItems.filter((item) => item.category === category).length,
    ]),
  ) as Record<ConversationProgressCategory, number>;
  const terminal = isTerminal(input.run.status);

  return deepFreeze({
    schemaVersion: 1,
    version: CONVERSATION_PROGRESS_VERSION,
    runId: input.run.id,
    status: input.run.status,
    terminal,
    ...runHeadline(input.run.status),
    startedAt: input.run.startedAt,
    completedAt: input.run.completedAt,
    agent: projectAgentIdentity(input.agentIdentity),
    context: latestContext
      ? {
          state: "recorded" as const,
          usedCount: safeCount(contextPayload?.actualCount) || 0,
          excludedCount: safeCount(contextPayload?.excludedCount) || 0,
          droppedCount: safeCount(contextPayload?.droppedCount) || 0,
          receiptRef: eventReference(latestContext.id),
        }
      : {
          state: "not_recorded" as const,
          usedCount: 0,
          excludedCount: 0,
          droppedCount: 0,
        },
    result: {
      state: resultState(input.run.status),
      responseLength: input.run.response?.length || 0,
      groundingStatus: input.run.grounding?.status,
      citationCount: input.run.grounding?.citedIds.length || 0,
    },
    recovery: recoveryProjection(input.run.status, checkpointCount),
    counts,
    items,
  });
}

function eventProgressItem(
  event: DomainEvent,
  runId: string,
): ConversationProgressItemV1[] {
  const checkpoint = checkpointProjection(event);
  const category = checkpoint
    ? checkpointCategory(checkpoint.boundaryKind)
    : eventCategory(event);
  if (!category) return [];
  const eventRef = eventReference(event.id);
  const item: ConversationProgressItemV1 = {
    id: `${checkpoint ? "checkpoint" : "event"}:${eventRef}`,
    source: checkpoint ? "checkpoint" : "event",
    eventRef,
    category,
    state: checkpoint
      ? checkpointState(checkpoint.lifecycleState, checkpoint.boundaryPhase)
      : eventState(event),
    title: checkpoint
      ? checkpointTitle(checkpoint.boundaryKind, checkpoint.boundaryPhase)
      : eventTitle(event, category),
    summary: checkpoint
      ? checkpointSummary(checkpoint)
      : eventSummary(event, category),
    at: event.at,
    technical: {
      eventType: safeEventType(event.type),
      streamKind: streamKind(event.streamId),
      sequence: event.seq,
    },
    checkpoint,
    action: progressAction(event, category, checkpoint, runId),
  };
  return [item];
}

function eventCategory(event: DomainEvent): ConversationProgressCategory | undefined {
  const type = event.type.toLowerCase();
  if (type.startsWith("voice.")) return "voice";
  if (type.startsWith("browser.")) return "browser";
  if (type === "run.waiting_approval" || type.includes("approval.")) return "approval";
  if (
    type.includes("recovery") ||
    type.includes("resume") ||
    type.includes("retry") ||
    type === "run.fork.created" ||
    type === "run.forked"
  ) return "recovery";
  if (
    type === "run.done" ||
    type === "run.error" ||
    type === "run.canceled" ||
    type === "run.terminal_receipt.recorded"
  ) return "result";
  if (
    type === "run.context.receipt" ||
    type === "run.memory" ||
    type.startsWith("retrieval.") ||
    type.includes("context_compiler")
  ) return "context";
  if (
    type.startsWith("evidence.") ||
    type.includes("evidence_resolved") ||
    type === "run.council_verdict"
  ) return "evidence";
  if (type === "run.model" || type === "ai.usage.recorded" || type.startsWith("model.")) {
    return "model";
  }
  if (type === "run.tool" || type.startsWith("tool.")) {
    return isBrowserToolEvent(event) ? "browser" : "tool";
  }
  if (
    type === "run.scope_bound" ||
    type === "run.status" ||
    type === "run.delegated" ||
    type === "run.council_member" ||
    type.startsWith("agent.") ||
    type.includes("delegation")
  ) return "agent";
  if (
    type === "run.harness" ||
    type === "run.contracts.bound" ||
    type === "run.manifests.resolved" ||
    type.includes("plan")
  ) return "plan";
  if (type.startsWith("intent.") || type === "run.intent") return "request";
  return undefined;
}

function eventTitle(event: DomainEvent, category: ConversationProgressCategory) {
  const payload = recordValue(event.payload);
  if (event.type === "run.model") return "Model turn completed";
  if (event.type === "run.tool") {
    return safeToken(payload?.toolName) || safeToken(payload?.toolId) ||
      (category === "browser" ? "Browser action" : "Governed tool");
  }
  if (event.type === "run.waiting_approval") return "Approval required";
  if (event.type === "run.context.receipt") return "Context use recorded";
  if (event.type === "run.council_member") return "Specialist update";
  if (event.type === "run.council_verdict") return "Outcome reviewed";
  if (event.type === "run.done") return "Result completed";
  if (event.type === "run.error") return "Task stopped";
  if (event.type === "run.canceled") return "Task canceled";
  if (event.type === "voice.command_reviewed") return "Voice command reviewed";
  if (event.type === "voice.speech_streamed") return "Result spoken";
  if (event.type === "voice.speech_interrupted") return "Speech interrupted";
  if (event.type === "voice.speech_failed") return "Speech unavailable";
  if (event.type === "browser.frame.captured") return "Browser view captured";
  if (event.type === "browser.snapshot.captured") return "Page structure captured";
  if (event.type === "run.fork.created" || event.type === "run.forked") {
    return "Corrected trace created";
  }
  return humanizeEventType(event.type);
}

function eventSummary(event: DomainEvent, category: ConversationProgressCategory) {
  const payload = recordValue(event.payload);
  if (event.type === "run.model" || event.type === "ai.usage.recorded") {
    const provider = safeToken(payload?.provider);
    const model = safeToken(payload?.model);
    return provider && model ? `${provider} · ${model}` : "A bounded model call was recorded.";
  }
  if (event.type === "run.tool") {
    const status = safeToken(payload?.status) || "recorded";
    const risk = safeCount(payload?.riskLevel);
    return `${category === "browser" ? "Governed browser action" : "Governed tool action"} · ${status}${risk === undefined ? "" : ` · risk ${risk}`}.`;
  }
  if (event.type === "run.waiting_approval") {
    return "Work is paused until the exact governed action is reviewed.";
  }
  if (event.type === "run.context.receipt") {
    const used = safeCount(payload?.actualCount) || 0;
    const excluded = safeCount(payload?.excludedCount) || 0;
    const dropped = safeCount(payload?.droppedCount) || 0;
    return `${used} authorized context item${used === 1 ? "" : "s"} used · ${excluded} excluded · ${dropped} dropped.`;
  }
  if (event.type === "run.memory") {
    const count = safeCount(payload?.count) || 0;
    return `${count} authorized context item${count === 1 ? "" : "s"} prepared.`;
  }
  if (event.type === "run.council_member") {
    const status = safeToken(payload?.status) || safeToken(payload?.lifecycleState) || "recorded";
    const agent = safeToken(payload?.agentId);
    return `${agent || "A bounded specialist"} · ${status}.`;
  }
  if (event.type === "run.council_verdict") {
    const status = safeToken(payload?.status) || "recorded";
    const score = safeFinite(payload?.score);
    return `Verifier verdict · ${status}${score === undefined ? "" : ` · ${Math.round(score * 100)}%`}.`;
  }
  if (event.type === "run.done") {
    const grounding = recordValue(payload?.grounding);
    const status = safeToken(grounding?.status);
    return status ? `The finished answer is in the conversation · grounding ${status}.` : "The finished answer is in the conversation.";
  }
  if (event.type === "run.error") {
    return "The task stopped before a completed result. Protected error details remain in monitoring.";
  }
  if (event.type === "run.canceled") return "The task was canceled before completion.";
  if (event.type === "voice.command_reviewed") {
    const band = safeToken(payload?.confidenceBand) || "reviewed";
    const method = safeToken(payload?.reviewMethod) || "visible review";
    return `Transcript ${band} · confirmed through ${method}.`;
  }
  if (event.type.startsWith("voice.speech_")) {
    const characters = safeCount(payload?.characters) || 0;
    return `${characters} result character${characters === 1 ? "" : "s"} sent through the versioned voice profile; no audio was retained.`;
  }
  if (event.type.startsWith("browser.frame.") || event.type.startsWith("browser.snapshot.")) {
    return event.type.endsWith(".captured")
      ? "A redacted observation receipt was retained for this governed browser action."
      : event.type.endsWith(".suppressed")
        ? "Observation capture was intentionally suppressed by policy."
        : "The browser observation could not be retained.";
  }
  if (event.type === "run.harness") {
    const model = safeToken(payload?.model);
    const mode = safeToken(payload?.mode);
    return [mode && `${mode} mode`, model, "bounded tools and policy recorded"].filter(Boolean).join(" · ") + ".";
  }
  if (event.type === "run.scope_bound") return "Tenant, actor, Agent, and execution scope were bound before work.";
  if (event.type === "run.fork.created" || event.type === "run.forked") {
    return "A new trace started from verified history with fresh grants and approvals.";
  }
  return `${humanizeEventType(event.type)} was recorded.`;
}

function eventState(event: DomainEvent): ConversationProgressState {
  const type = event.type.toLowerCase();
  const payload = recordValue(event.payload);
  const status = safeToken(payload?.status)?.toLowerCase();
  if (type === "run.error" || type.endsWith(".failed") || type.endsWith("_failed") || status === "failed" || status === "blocked" || status === "rejected") return "failed";
  if (type === "run.canceled" || type.endsWith(".canceled") || type.endsWith("_canceled")) return "canceled";
  if (type === "run.waiting_approval" || type.includes("waiting") || status === "approval_required") return "waiting";
  if (status === "running" || status === "executing" || status === "working") return "running";
  if (type === "run.done" || type.endsWith(".completed") || type.endsWith(".streamed") || type.endsWith("_streamed") || status === "completed" || status === "executed" || status === "success") return "completed";
  return "recorded";
}

function checkpointProjection(event: DomainEvent): ConversationProgressItemV1["checkpoint"] {
  if (event.type !== "run.checkpoint.recorded") return undefined;
  const payload = recordValue(event.payload);
  const checkpointId = safeToken(payload?.checkpointId);
  const checkpointSha256 = safeSha256(payload?.checkpointSha256);
  const sequence = safeCount(payload?.sequence);
  const boundaryKind = safeToken(payload?.boundaryKind);
  const boundaryPhase = safeToken(payload?.boundaryPhase);
  const lifecycleState = safeToken(payload?.lifecycleState);
  const resumeDisposition = safeToken(payload?.resumeDisposition);
  if (
    !checkpointId || !checkpointSha256 || sequence === undefined ||
    !isBoundaryKind(boundaryKind) || !isBoundaryPhase(boundaryPhase) ||
    !isLifecycleState(lifecycleState) || !isResumeDisposition(resumeDisposition)
  ) return undefined;
  return {
    checkpointId,
    checkpointSha256,
    sequence,
    boundaryKind,
    boundaryPhase,
    lifecycleState,
    resumeDisposition,
  };
}

function checkpointCategory(kind: NonNullable<ConversationProgressItemV1["checkpoint"]>["boundaryKind"]): ConversationProgressCategory {
  if (kind === "model") return "model";
  if (kind === "tool") return "tool";
  if (kind === "approval") return "approval";
  if (kind === "delegation") return "agent";
  return "result";
}

function checkpointState(
  lifecycle: NonNullable<ConversationProgressItemV1["checkpoint"]>["lifecycleState"],
  phase: NonNullable<ConversationProgressItemV1["checkpoint"]>["boundaryPhase"],
): ConversationProgressState {
  if (lifecycle === "waiting" || phase === "waiting") return "waiting";
  if (lifecycle === "active" && phase === "before") return "running";
  return phase === "after" || lifecycle === "terminal" ? "completed" : "recorded";
}

function checkpointTitle(
  kind: NonNullable<ConversationProgressItemV1["checkpoint"]>["boundaryKind"],
  phase: NonNullable<ConversationProgressItemV1["checkpoint"]>["boundaryPhase"],
) {
  return `${capitalize(kind)} checkpoint · ${phase}`;
}

function checkpointSummary(checkpoint: NonNullable<ConversationProgressItemV1["checkpoint"]>) {
  const authority = checkpoint.resumeDisposition === "resumable"
    ? "compatible for reviewed recovery"
    : checkpoint.resumeDisposition === "awaiting_signal"
      ? "waiting for an external decision"
      : "record only; it grants no resume authority";
  return `Boundary ${checkpoint.sequence} · ${checkpoint.lifecycleState} · ${authority}.`;
}

function progressAction(
  event: DomainEvent,
  category: ConversationProgressCategory,
  checkpoint: ConversationProgressItemV1["checkpoint"],
  runId: string,
): ConversationProgressItemV1["action"] {
  if (category === "approval") {
    return { kind: "approval", label: "Review approval", href: "/app/approvals" };
  }
  if (category === "browser") return { kind: "browser", label: "Open browser evidence" };
  if (checkpoint) return { kind: "checkpoint", label: "Inspect checkpoint" };
  if (event.type === "run.done") {
    return {
      kind: "result",
      label: "Open result evidence",
      href: `/app/results?run=${encodeURIComponent(`agent:${runId}`)}`,
    };
  }
  return undefined;
}

function runHeadline(status: AgentRunRecord["status"]) {
  if (status === "completed") return { headline: "Task complete", summary: "The progress trail has collapsed into the finished answer and its evidence." };
  if (status === "failed") return { headline: "Task stopped", summary: "No successful result is implied. Review the last recorded boundary before retrying or correcting." };
  if (status === "canceled") return { headline: "Task canceled", summary: "Recorded work remains inspectable, but the task did not complete." };
  if (status === "waiting_approval") return { headline: "Approval required", summary: "The exact governed action must be reviewed before work can continue." };
  if (status === "waiting_clarification") return { headline: "Clarification needed", summary: "Reply in this conversation with the exact target or missing detail." };
  if (status === "queued") return { headline: "Task queued", summary: "The durable run is waiting for an execution lease." };
  if (status === "resuming") return { headline: "Task resuming", summary: "The run is continuing from its validated durable state." };
  return { headline: "Asael is working", summary: "Progress appears only after its event or checkpoint is durably recorded." };
}

function recoveryProjection(
  status: AgentRunRecord["status"],
  checkpointCount: number,
): ConversationProgressV1["recovery"] {
  if (status === "waiting_approval") return { kind: "approval", label: "Review approval", instruction: "Review the exact pending action; an approval resumes only this owner-bound run.", href: "/app/approvals" };
  if (status === "waiting_clarification") return { kind: "clarification", label: "Reply with clarification", instruction: "Continue in this conversation. The existing run and Agent pin will be revalidated before resuming." };
  if (status === "running" || status === "queued" || status === "resuming") return { kind: "cancel", label: "Stop run", instruction: "The current durable run can be canceled from the Conversation controls." };
  if ((status === "failed" || status === "canceled" || status === "completed") && checkpointCount > 0) {
    return { kind: "checkpoint", label: "Correct from checkpoint", instruction: "Choose a verified checkpoint and start a new trace. Grants and approvals are not inherited." };
  }
  if (status === "failed" || status === "canceled") return { kind: "retry", label: "Start a new attempt", instruction: "Send a corrected request in this conversation; the stopped run remains unchanged." };
  return { kind: "none", label: "No recovery needed", instruction: "The completed result and evidence remain available in this conversation." };
}

function projectAgentIdentity(identity: AgentIdentityProjection): ConversationProgressV1["agent"] {
  if (identity.state !== "ready") return { state: identity.state };
  return {
    state: "ready",
    logicalAgentId: identity.card.logicalAgentId,
    definitionVersion: identity.card.definitionVersion,
    name: identity.card.name,
    role: identity.card.role,
    status: identity.card.status,
  };
}

function boundedProgressItems(items: ConversationProgressItemV1[]) {
  if (items.length <= MAX_PROGRESS_ITEMS) return items;
  return [...items.slice(0, 8), ...items.slice(-(MAX_PROGRESS_ITEMS - 8))];
}

function isExactRunVoiceEvent(event: DomainEvent, runId: string) {
  if (!event.type.startsWith("voice.")) return false;
  return safeToken(recordValue(event.payload)?.runId) === runId;
}

function isBrowserToolEvent(event: DomainEvent) {
  const payload = recordValue(event.payload);
  const tool = `${safeToken(payload?.toolId) || ""} ${safeToken(payload?.toolName) || ""}`.toLowerCase();
  return tool.includes("browser_") || tool.includes("browser.") || tool.includes("playwright");
}

function resultState(status: AgentRunRecord["status"]): ConversationProgressV1["result"]["state"] {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  return "pending";
}

function isTerminal(status: AgentRunRecord["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function streamKind(streamId: string) {
  const separator = streamId.indexOf(":");
  return (separator > 0 ? streamId.slice(0, separator) : "event")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 40) || "event";
}

function eventReference(eventId: string) {
  return createHash("sha256").update(eventId).digest("hex");
}

function safeEventType(value: string) {
  return /^[a-zA-Z0-9_.:-]{1,160}$/.test(value) ? value : "event.recorded";
}

function safeToken(value: unknown) {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token && token.length <= 160 && /^[a-zA-Z0-9_.:@/+ -]+$/.test(token)
    ? token
    : undefined;
}

function safeSha256(value: unknown) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
    ? value
    : undefined;
}

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
}

function safeFinite(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function recordValue(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function humanizeEventType(type: string) {
  const text = type
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
  return text.slice(0, 160) || "Event recorded";
}

function capitalize(value: string) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function isBoundaryKind(value: string | undefined): value is NonNullable<ConversationProgressItemV1["checkpoint"]>["boundaryKind"] {
  return ["model", "tool", "approval", "delegation", "verifier"].includes(value || "");
}

function isBoundaryPhase(value: string | undefined): value is NonNullable<ConversationProgressItemV1["checkpoint"]>["boundaryPhase"] {
  return ["before", "waiting", "after"].includes(value || "");
}

function isLifecycleState(value: string | undefined): value is NonNullable<ConversationProgressItemV1["checkpoint"]>["lifecycleState"] {
  return ["active", "waiting", "terminal"].includes(value || "");
}

function isResumeDisposition(value: string | undefined): value is NonNullable<ConversationProgressItemV1["checkpoint"]>["resumeDisposition"] {
  return ["resumable", "awaiting_signal", "not_resumable"].includes(value || "");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return value;
}
