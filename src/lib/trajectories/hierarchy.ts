import { createHash } from "node:crypto";
import type { DomainEvent } from "@/lib/events/store";
import type { AgentRunRecord, RunStatus } from "@/lib/runs/types";
import type { WorkflowRunRecord } from "@/lib/workflows/types";

export const traceStageIds = [
  "intent",
  "plan",
  "agent",
  "model",
  "tool",
  "evidence",
  "effect",
  "verification",
  "memory",
] as const;

export type TraceStageId = (typeof traceStageIds)[number];
export type TraceStageStatus =
  | "observed"
  | "pending"
  | "missing"
  | "not_applicable";

export type TraceEventReceipt = {
  eventRef: string;
  parentEventRef?: string;
  causationRef?: string;
  streamKind: string;
  type: string;
  seq: number;
  at: string;
  summary: string;
};

export type TraceStage = {
  id: TraceStageId;
  label: string;
  ordinal: number;
  parentStageId?: TraceStageId;
  required: boolean;
  status: TraceStageStatus;
  eventCount: number;
  startedAt?: string;
  completedAt?: string;
  events: TraceEventReceipt[];
};

export type RunTraceHierarchy = {
  version: 1;
  traceId: string;
  correlationSha256: string;
  runId: string;
  outcome: "running" | "waiting" | "succeeded" | "failed" | "canceled";
  startedAt: string;
  completedAt?: string;
  summary: {
    eventCount: number;
    observedStageCount: number;
    pendingStageCount: number;
    missingStageCount: number;
    notApplicableStageCount: number;
  };
  stages: TraceStage[];
};

const stageLabels: Record<TraceStageId, string> = {
  intent: "Intent",
  plan: "Plan",
  agent: "Agent",
  model: "Model",
  tool: "Tool",
  evidence: "Evidence",
  effect: "Effect",
  verification: "Verification",
  memory: "Memory",
};

/**
 * Resolves the correlation root from the immutable scope binding when one is
 * present. Legacy runs fall back to the most common run-stream correlation and
 * finally the run id; the raw value is never returned by the hierarchy.
 */
export function resolveRunCorrelationId(
  run: AgentRunRecord,
  runEvents: DomainEvent[],
) {
  const bound = runEvents.find((event) =>
    event.streamId === `run:${run.id}` &&
    event.type === "run.scope_bound" &&
    event.executionScope?.correlationId
  )?.executionScope?.correlationId;
  if (bound) return bound;

  const counts = new Map<string, number>();
  for (const event of runEvents) {
    if (event.streamId !== `run:${run.id}` || !event.correlationId) continue;
    counts.set(event.correlationId, (counts.get(event.correlationId) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .at(0)?.[0] || run.id;
}

export function buildRunTraceHierarchy(
  run: AgentRunRecord,
  domainEvents: DomainEvent[],
  correlationId: string,
): RunTraceHierarchy {
  return buildTraceHierarchy({
    id: run.id,
    tenantId: run.tenantId || "default",
    ownerActorId: run.ownerActorId,
    rootStreamId: `run:${run.id}`,
    status: run.status,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    evidenceExpected: run.memoryContextCount > 0 || Boolean(run.grounding?.sources.length),
  }, domainEvents, correlationId);
}

export function buildWorkflowTraceHierarchy(
  run: WorkflowRunRecord,
  ownerActorId: string,
  domainEvents: DomainEvent[],
  correlationId: string,
): RunTraceHierarchy {
  return buildTraceHierarchy({
    id: run.id,
    tenantId: run.tenantId || "default",
    ownerActorId,
    rootStreamId: `workflow:${run.id}`,
    status: run.status,
    startedAt: run.createdAt,
    completedAt: run.completedAt,
    evidenceExpected: false,
  }, domainEvents, correlationId);
}

type TraceSubject = {
  id: string;
  tenantId: string;
  ownerActorId: string;
  rootStreamId: string;
  status: RunStatus | WorkflowRunRecord["status"];
  startedAt: string;
  completedAt?: string;
  evidenceExpected: boolean;
};

function buildTraceHierarchy(
  subject: TraceSubject,
  domainEvents: DomainEvent[],
  correlationId: string,
): RunTraceHierarchy {
  const tenantId = subject.tenantId;
  const ordered = dedupeEvents(domainEvents)
    .filter((event) =>
      event.tenantId === tenantId &&
      (
        event.actorId === subject.ownerActorId ||
        event.streamId === subject.rootStreamId
      )
    )
    .sort((left, right) => left.seq - right.seq);
  const knownEventIds = new Map(
    ordered.map((event) => [event.id, eventReference(event.id)]),
  );
  const stageEvents = new Map<TraceStageId, TraceEventReceipt[]>(
    traceStageIds.map((stage) => [stage, []]),
  );

  for (const event of ordered) {
    const stage = classifyTraceStage(event);
    if (!stage) continue;
    stageEvents.get(stage)?.push(toTraceEventReceipt(event, knownEventIds));
  }

  const terminal = isTerminal(subject.status);
  const requirements = requiredStages(subject, ordered);
  const stages = traceStageIds.map((id, ordinal): TraceStage => {
    const events = stageEvents.get(id) || [];
    const required = requirements.has(id);
    const status: TraceStageStatus = events.length
      ? "observed"
      : required
        ? terminal
          ? "missing"
          : "pending"
        : "not_applicable";
    return {
      id,
      label: stageLabels[id],
      ordinal,
      parentStageId: ordinal ? traceStageIds[ordinal - 1] : undefined,
      required,
      status,
      eventCount: events.length,
      startedAt: events.at(0)?.at,
      completedAt: events.at(-1)?.at,
      events,
    };
  });
  const correlationSha256 = sha256(correlationId);

  return {
    version: 1,
    traceId: sha256(`${tenantId}:${subject.ownerActorId}:${correlationId}`),
    correlationSha256,
    runId: subject.id,
    outcome: runOutcome(subject.status),
    startedAt: subject.startedAt,
    completedAt: subject.completedAt,
    summary: {
      eventCount: ordered.length,
      observedStageCount: countStatus(stages, "observed"),
      pendingStageCount: countStatus(stages, "pending"),
      missingStageCount: countStatus(stages, "missing"),
      notApplicableStageCount: countStatus(stages, "not_applicable"),
    },
    stages,
  };
}

function requiredStages(subject: TraceSubject, events: DomainEvent[]) {
  const required = new Set<TraceStageId>([
    "intent",
    "plan",
    "agent",
    "model",
    "verification",
  ]);
  if (
    subject.evidenceExpected ||
    events.some((event) => classifyTraceStage(event) === "evidence")
  ) {
    required.add("evidence");
  }
  if (events.some(isConsequentialToolSuccess)) required.add("effect");
  return required;
}

function classifyTraceStage(event: DomainEvent): TraceStageId | undefined {
  const type = event.type.toLowerCase();

  if (
    type.includes("effect_receipt") ||
    type.includes("effect.receipt") ||
    type.includes("effect_recorded") ||
    type.includes("effect.recorded") ||
    type.includes("effect_pending")
  ) return "effect";
  if (
    type.startsWith("memory.") ||
    type.includes("memory_formed") ||
    type.includes("memory.formed") ||
    type.includes("memory_created") ||
    type.includes("memory.created")
  ) return "memory";
  if (
    type.startsWith("intent.") ||
    type === "run.intent" ||
    type.includes("intent.captured") ||
    type.includes("intent.bound")
  ) return "intent";
  if (
    type === "run.harness" ||
    type === "run.contracts.bound" ||
    type === "run.manifests.resolved" ||
    type.includes("dynamic_plan") ||
    type.includes("replan_triggered") ||
    type.includes("subtree_replanned") ||
    type.endsWith("plan.created") ||
    type.endsWith("plan.bound")
  ) return "plan";
  if (
    type === "run.model" ||
    type.startsWith("model.") ||
    type.includes("model_call") ||
    type.includes("model.called")
  ) return "model";
  if (
    type === "run.tool" ||
    type === "run.waiting_approval" ||
    type.startsWith("tool.") ||
    type.includes("tool_execution") ||
    type.includes("tool.execut")
  ) return "tool";
  if (
    type === "run.memory" ||
    type.includes("context_compiler") ||
    type.startsWith("retrieval.") ||
    type.startsWith("evidence.") ||
    type.includes("evidence_resolved") ||
    type.includes("evidence.resolved")
  ) return "evidence";
  if (
    type === "run.done" ||
    type === "run.error" ||
    type === "run.canceled" ||
    type === "run.council_verdict" ||
    type === "run.terminal_receipt.recorded" ||
    type.includes("outcome_evaluated") ||
    type.endsWith(".completed") ||
    type.endsWith(".failed") ||
    type.endsWith(".verified") ||
    type.includes(".verify")
  ) return "verification";
  if (
    type === "run.scope_bound" ||
    type === "run.status" ||
    type === "run.delegated" ||
    type === "run.council_member" ||
    type.startsWith("agent.") ||
    type.includes("specialist") ||
    type.includes("plan_node") ||
    type.startsWith("step.")
  ) return "agent";
  return undefined;
}

function toTraceEventReceipt(
  event: DomainEvent,
  knownEventIds: Map<string, string>,
): TraceEventReceipt {
  const parentEventRef = event.causationId
    ? knownEventIds.get(event.causationId)
    : undefined;
  return {
    eventRef: eventReference(event.id),
    parentEventRef,
    causationRef: event.causationId && !parentEventRef
      ? eventReference(event.causationId)
      : undefined,
    streamKind: streamKind(event.streamId),
    type: event.type,
    seq: event.seq,
    at: event.at,
    summary: safeEventSummary(event),
  };
}

function safeEventSummary(event: DomainEvent) {
  const payload = event.payload;
  if (event.type === "run.model") {
    const provider = safeToken(payload.provider);
    const model = safeToken(payload.model);
    return provider && model ? `${provider} / ${model}` : "Model turn recorded";
  }
  if (event.type === "run.tool") {
    const tool = safeToken(payload.toolName) || safeToken(payload.toolId);
    const status = safeToken(payload.status);
    return [tool || "Governed tool", status].filter(Boolean).join(" · ");
  }
  if (event.type === "run.done") {
    const grounding = recordValue(payload.grounding);
    const groundingStatus = safeToken(grounding?.status);
    return groundingStatus
      ? `Outcome recorded · grounding ${groundingStatus}`
      : "Outcome recorded";
  }
  if (event.type === "run.memory") {
    const count = safeCount(payload.count);
    return count === undefined ? "Authorized context recorded" : `${count} context item${count === 1 ? "" : "s"}`;
  }
  if (event.type === "run.council_verdict") {
    const status = safeToken(payload.status);
    return status ? `Verifier verdict · ${status}` : "Verifier verdict recorded";
  }
  if (event.type.startsWith("workflow.")) {
    return humanizeEventType(event.type.replace(/^workflow\./, ""));
  }
  return humanizeEventType(event.type);
}

function isConsequentialToolSuccess(event: DomainEvent) {
  if (event.type !== "run.tool" && !event.type.startsWith("tool.")) return false;
  const status = safeToken(event.payload.status);
  return event.payload.dryRun === false &&
    (status === "executed" || status === "completed" || status === "success");
}

function dedupeEvents(events: DomainEvent[]) {
  return [...new Map(events.map((event) => [event.id, event])).values()];
}

function streamKind(streamId: string) {
  const separator = streamId.indexOf(":");
  return (separator > 0 ? streamId.slice(0, separator) : "event")
    .replace(/[^a-zA-Z0-9_.-]/g, "_")
    .slice(0, 40) || "event";
}

function eventReference(value: string) {
  return sha256(value);
}

function safeToken(value: unknown) {
  if (typeof value !== "string") return undefined;
  const token = value.trim();
  return token && token.length <= 160 && /^[a-zA-Z0-9_.:/ -]+$/.test(token)
    ? token
    : undefined;
}

function safeCount(value: unknown) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : undefined;
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
  return text.slice(0, 160) || "Trace event recorded";
}

function countStatus(stages: TraceStage[], status: TraceStageStatus) {
  return stages.filter((stage) => stage.status === status).length;
}

function isTerminal(status: TraceSubject["status"]) {
  return status === "completed" || status === "failed" || status === "canceled";
}

function runOutcome(status: TraceSubject["status"]): RunTraceHierarchy["outcome"] {
  if (status === "completed") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "canceled") return "canceled";
  if (
    status === "waiting_approval" ||
    status === "waiting_clarification" ||
    status === "paused"
  ) return "waiting";
  return "running";
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
