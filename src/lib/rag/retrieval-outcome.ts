import "server-only";

import { createHash } from "node:crypto";
import type { DomainEvent } from "@/lib/events/store";
import { parseContextUseReceiptV1 } from "@/lib/rag/context-use-receipt";
import type { AgentRunRecord } from "@/lib/runs/types";

export const RETRIEVAL_OUTCOME_OBSERVATION_VERSION =
  "retrieval-outcome-observation:1" as const;
export const RETRIEVAL_OUTCOME_PUBLIC_AGGREGATE_VERSION =
  "retrieval-outcome-public-aggregate:1" as const;

const COVERAGE = "explicit_selection_only" as const;
const INTERPRETATION =
  "explicit_completed_run_feedback_correlation_not_causal" as const;

export type RetrievalEvidenceKindCounts = Readonly<{
  memory: number;
  knowledge: number;
  graph: number;
}>;

export type RetrievalOutcomeObservationV1 = Readonly<{
  schemaVersion: 1;
  version: typeof RETRIEVAL_OUTCOME_OBSERVATION_VERSION;
  tenantId: string;
  ownerActorId: string;
  runId: string;
  contextEventId: string;
  contextReceiptSha256: string;
  latestFeedbackEventId: string;
  verdict: "useful" | "needs_work";
  feedbackAt: string;
  receiptCounts: Readonly<{
    candidate: number;
    included: number;
    actual: number;
    dropped: number;
  }>;
  actualKindCounts: RetrievalEvidenceKindCounts;
  coverage: typeof COVERAGE;
  interpretation: typeof INTERPRETATION;
  shadowOnly: true;
  rankingEffect: "none";
  observationSha256: string;
}>;

export type PublicRetrievalOutcomeAggregateV1 = Readonly<{
  schemaVersion: 1;
  version: typeof RETRIEVAL_OUTCOME_PUBLIC_AGGREGATE_VERSION;
  sampleCount: number;
  feedbackCounts: Readonly<{
    useful: number;
    needsWork: number;
  }>;
  receiptTotals: Readonly<{
    candidate: number;
    included: number;
    actual: number;
    dropped: number;
  }>;
  actualKindTotals: RetrievalEvidenceKindCounts;
  coverage: typeof COVERAGE;
  interpretation: typeof INTERPRETATION;
  shadowOnly: true;
  rankingEffect: "none";
}>;

type ObservationBody = Omit<RetrievalOutcomeObservationV1, "observationSha256">;

/**
 * Correlates a completed run's immutable context receipt with its latest
 * explicit owner feedback. Absence is not an error: legacy and unreviewed runs
 * simply do not produce an observation. Malformed, cross-scope, or out-of-order
 * evidence fails closed.
 *
 * The correlation is shadow telemetry only. It does not establish causation and
 * it must not affect retrieval ranking without a separate evaluated rollout.
 */
export function projectRetrievalOutcomeObservationV1(input: Readonly<{
  tenantId: string;
  actorId: string;
  run: AgentRunRecord;
  events: readonly DomainEvent[];
}>): RetrievalOutcomeObservationV1 | undefined {
  const tenantId = requiredId(input.tenantId, "tenant");
  const actorId = requiredId(input.actorId, "actor");
  assertCompletedRunScope(input.run, tenantId, actorId);

  const relevant = input.events.filter((event) =>
    event.type === "run.context.receipt" || event.type === "run.feedback"
  );
  for (const event of relevant) {
    assertExactEventScope(event, input.run.id, tenantId, actorId);
  }
  assertStrictEventOrder(relevant);

  const contextEvents = relevant.filter((event) =>
    event.type === "run.context.receipt"
  );
  const feedbackEvents = relevant.filter((event) => event.type === "run.feedback");
  if (contextEvents.length === 0 || feedbackEvents.length === 0) return undefined;

  const latestContext = contextEvents[contextEvents.length - 1];
  const firstFeedback = feedbackEvents[0];
  const latestFeedback = feedbackEvents[feedbackEvents.length - 1];
  if (
    latestContext.seq >= firstFeedback.seq ||
    timestamp(latestContext.at, "context event") >
      timestamp(firstFeedback.at, "feedback event")
  ) {
    throw new Error("Retrieval outcome events are not in run chronology order.");
  }

  const startedAt = timestamp(input.run.startedAt, "run startedAt");
  const completedAt = timestamp(input.run.completedAt, "run completedAt");
  const contextAt = timestamp(latestContext.at, "context event");
  const feedbackAtMs = timestamp(latestFeedback.at, "feedback event");
  if (contextAt < startedAt || contextAt > completedAt || feedbackAtMs < completedAt) {
    throw new Error("Retrieval outcome events fall outside the completed run chronology.");
  }

  const contextPayload = withoutExecutionScope(latestContext.payload);
  let receipt;
  try {
    receipt = parseContextUseReceiptV1(contextPayload);
  } catch (error) {
    throw new Error("Retrieval outcome context receipt is invalid.", {
      cause: error,
    });
  }
  if (receipt.runId !== input.run.id) {
    throw new Error("Retrieval outcome context receipt belongs to another run.");
  }
  const receiptRecordedAt = timestamp(receipt.recordedAt, "context receipt recordedAt");
  if (receiptRecordedAt < startedAt || receiptRecordedAt > contextAt) {
    throw new Error("Retrieval outcome context receipt has invalid chronology.");
  }

  const feedbackPayloads = feedbackEvents.map(parseFeedbackEvent);
  const latestFeedbackPayload = feedbackPayloads[feedbackPayloads.length - 1];
  if (!input.run.feedback) {
    throw new Error("Retrieval outcome feedback event has no matching run feedback.");
  }
  const feedbackUpdatedAt = timestamp(
    input.run.feedback.updatedAt,
    "run feedback updatedAt",
  );
  if (
    input.run.feedback.verdict !== latestFeedbackPayload.verdict ||
    Boolean(input.run.feedback.correction) !== latestFeedbackPayload.hasCorrection ||
    feedbackUpdatedAt < completedAt ||
    feedbackUpdatedAt > feedbackAtMs
  ) {
    throw new Error("Latest retrieval outcome feedback does not match the run.");
  }

  const body: ObservationBody = {
    schemaVersion: 1,
    version: RETRIEVAL_OUTCOME_OBSERVATION_VERSION,
    tenantId,
    ownerActorId: actorId,
    runId: input.run.id,
    contextEventId: requiredId(latestContext.id, "context event"),
    contextReceiptSha256: receipt.receiptSha256,
    latestFeedbackEventId: requiredId(latestFeedback.id, "feedback event"),
    verdict: latestFeedbackPayload.verdict,
    feedbackAt: new Date(feedbackAtMs).toISOString(),
    receiptCounts: {
      candidate: receipt.candidateCount,
      included: receipt.includedCount,
      actual: receipt.actualCount,
      dropped: receipt.droppedCount,
    },
    actualKindCounts: evidenceKindCounts(receipt.actualEvidenceIds),
    coverage: COVERAGE,
    interpretation: INTERPRETATION,
    shadowOnly: true,
    rankingEffect: "none",
  };
  return deepFreeze({
    ...body,
    observationSha256: canonicalSha256(body),
  });
}

/**
 * Produces the browser-safe projection for a single exact actor scope. Only
 * bounded counts and the non-causal shadow labels leave the server; run,
 * event, receipt, tenant, actor, evidence, quote, and correction identifiers do
 * not.
 */
export function projectPublicRetrievalOutcomeAggregateV1(input: Readonly<{
  tenantId: string;
  actorId?: string;
  actorIds?: readonly string[];
  observations: readonly RetrievalOutcomeObservationV1[];
}>): PublicRetrievalOutcomeAggregateV1 {
  const tenantId = requiredId(input.tenantId, "tenant");
  const actorIds = new Set([
    ...(input.actorId ? [requiredId(input.actorId, "actor")] : []),
    ...(input.actorIds || []).map((actorId) => requiredId(actorId, "actor")),
  ]);
  if (!actorIds.size) {
    throw new Error("Retrieval outcome aggregate requires an actor scope.");
  }
  const aggregate = {
    schemaVersion: 1 as const,
    version: RETRIEVAL_OUTCOME_PUBLIC_AGGREGATE_VERSION,
    sampleCount: 0,
    feedbackCounts: { useful: 0, needsWork: 0 },
    receiptTotals: { candidate: 0, included: 0, actual: 0, dropped: 0 },
    actualKindTotals: { memory: 0, knowledge: 0, graph: 0 },
    coverage: COVERAGE,
    interpretation: INTERPRETATION,
    shadowOnly: true as const,
    rankingEffect: "none" as const,
  };

  for (const observation of input.observations) {
    assertObservation(observation, tenantId, actorIds);
    aggregate.sampleCount = addCount(aggregate.sampleCount, 1);
    if (observation.verdict === "useful") {
      aggregate.feedbackCounts.useful = addCount(
        aggregate.feedbackCounts.useful,
        1,
      );
    } else {
      aggregate.feedbackCounts.needsWork = addCount(
        aggregate.feedbackCounts.needsWork,
        1,
      );
    }
    aggregate.receiptTotals.candidate = addCount(
      aggregate.receiptTotals.candidate,
      observation.receiptCounts.candidate,
    );
    aggregate.receiptTotals.included = addCount(
      aggregate.receiptTotals.included,
      observation.receiptCounts.included,
    );
    aggregate.receiptTotals.actual = addCount(
      aggregate.receiptTotals.actual,
      observation.receiptCounts.actual,
    );
    aggregate.receiptTotals.dropped = addCount(
      aggregate.receiptTotals.dropped,
      observation.receiptCounts.dropped,
    );
    aggregate.actualKindTotals.memory = addCount(
      aggregate.actualKindTotals.memory,
      observation.actualKindCounts.memory,
    );
    aggregate.actualKindTotals.knowledge = addCount(
      aggregate.actualKindTotals.knowledge,
      observation.actualKindCounts.knowledge,
    );
    aggregate.actualKindTotals.graph = addCount(
      aggregate.actualKindTotals.graph,
      observation.actualKindCounts.graph,
    );
  }

  return deepFreeze(aggregate);
}

function assertCompletedRunScope(
  run: AgentRunRecord,
  tenantId: string,
  actorId: string,
) {
  if (
    run.status !== "completed" ||
    run.tenantId !== tenantId ||
    run.ownerActorId !== actorId ||
    !run.id.trim() ||
    !run.completedAt
  ) {
    throw new Error(
      "Retrieval outcome projection requires one completed actor-owned run.",
    );
  }
}

function assertExactEventScope(
  event: DomainEvent,
  runId: string,
  tenantId: string,
  actorId: string,
) {
  if (
    event.streamId !== `run:${runId}` ||
    event.tenantId !== tenantId ||
    event.actorId !== actorId
  ) {
    throw new Error("Retrieval outcome event scope does not match the run owner.");
  }
}

function assertStrictEventOrder(events: readonly DomainEvent[]) {
  let previousSeq = -1;
  let previousAt = -1;
  for (const event of events) {
    const at = timestamp(event.at, "domain event");
    if (
      !Number.isSafeInteger(event.seq) ||
      event.seq <= 0 ||
      event.seq <= previousSeq ||
      at < previousAt
    ) {
      throw new Error("Retrieval outcome events must be strictly ordered.");
    }
    previousSeq = event.seq;
    previousAt = at;
  }
}

function parseFeedbackEvent(event: DomainEvent) {
  const payload = withoutExecutionScope(event.payload);
  if (
    (payload.verdict !== "useful" && payload.verdict !== "needs_work") ||
    typeof payload.hasCorrection !== "boolean"
  ) {
    throw new Error("Retrieval outcome feedback event is invalid.");
  }
  return {
    verdict: payload.verdict,
    hasCorrection: payload.hasCorrection,
  } as const;
}

function evidenceKindCounts(ids: readonly string[]): RetrievalEvidenceKindCounts {
  const counts = { memory: 0, knowledge: 0, graph: 0 };
  for (const id of ids) {
    if (id.startsWith("memory:")) counts.memory += 1;
    else if (id.startsWith("knowledge:")) counts.knowledge += 1;
    else if (id.startsWith("graph:")) counts.graph += 1;
    else throw new Error("Retrieval outcome receipt has an unsupported evidence kind.");
  }
  return counts;
}

function assertObservation(
  observation: RetrievalOutcomeObservationV1,
  tenantId: string,
  actorIds: ReadonlySet<string>,
) {
  const { observationSha256, ...body } = observation;
  if (
    observation.schemaVersion !== 1 ||
    observation.version !== RETRIEVAL_OUTCOME_OBSERVATION_VERSION ||
    observation.tenantId !== tenantId ||
    !actorIds.has(observation.ownerActorId) ||
    observation.coverage !== COVERAGE ||
    observation.interpretation !== INTERPRETATION ||
    observation.shadowOnly !== true ||
    observation.rankingEffect !== "none" ||
    !/^[a-f0-9]{64}$/.test(observation.contextReceiptSha256) ||
    !/^[a-f0-9]{64}$/.test(observationSha256) ||
    canonicalSha256(body) !== observationSha256
  ) {
    throw new Error("Retrieval outcome observation is invalid or cross-scope.");
  }
  for (const value of [
    ...Object.values(observation.receiptCounts),
    ...Object.values(observation.actualKindCounts),
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Retrieval outcome observation counts are invalid.");
    }
  }
  if (
    observation.receiptCounts.actual !==
      Object.values(observation.actualKindCounts).reduce((sum, value) => sum + value, 0)
  ) {
    throw new Error("Retrieval outcome observation kind counts are invalid.");
  }
}

function withoutExecutionScope(payload: Record<string, unknown>) {
  const { _executionScope: _scope, ...body } = payload;
  void _scope;
  return body;
}

function requiredId(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > 240) {
    throw new Error(`Retrieval outcome ${label} scope is invalid.`);
  }
  return normalized;
}

function timestamp(value: string | undefined, label: string) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) {
    throw new Error(`Retrieval outcome ${label} timestamp is invalid.`);
  }
  return parsed;
}

function addCount(left: number, right: number) {
  if (!Number.isSafeInteger(right) || right < 0) {
    throw new Error("Retrieval outcome count is invalid.");
  }
  return Math.min(Number.MAX_SAFE_INTEGER, left + right);
}

function canonicalSha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
