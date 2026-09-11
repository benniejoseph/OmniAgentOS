import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import {
  issueContextSelectionPreview,
  lockContextSelection,
} from "@/lib/rag/context-selection-lock";
import { buildContextUseReceiptV1 } from "@/lib/rag/context-use-receipt";
import {
  projectPublicRetrievalOutcomeAggregateV1,
  projectRetrievalOutcomeObservationV1,
  RETRIEVAL_OUTCOME_OBSERVATION_VERSION,
} from "@/lib/rag/retrieval-outcome";
import type { AgentRunRecord } from "@/lib/runs/types";

const tenantId = "tenant-retrieval-outcome";
const actorId = "actor-retrieval-outcome";
const runId = "run-retrieval-outcome";
const startedAt = "2026-09-11T10:00:00.000Z";
const contextRecordedAt = "2026-09-11T10:01:00.000Z";
const contextEventAt = "2026-09-11T10:01:01.000Z";
const completedAt = "2026-09-11T10:02:00.000Z";
const feedbackAt = "2026-09-11T10:03:00.000Z";

describe("retrieval outcome shadow projection", () => {
  beforeEach(() => {
    vi.stubEnv(
      "OMNIAGENT_INTERNAL_AUTH_SECRET",
      "retrieval-outcome-unit-test-secret",
    );
  });

  it("projects a digest-bound non-causal observation from explicit feedback", () => {
    const fixture = buildFixture();
    const observation = projectRetrievalOutcomeObservationV1(fixture);

    expect(observation).toMatchObject({
      schemaVersion: 1,
      version: RETRIEVAL_OUTCOME_OBSERVATION_VERSION,
      tenantId,
      ownerActorId: actorId,
      runId,
      contextEventId: "event-context",
      latestFeedbackEventId: "event-feedback",
      verdict: "useful",
      feedbackAt,
      receiptCounts: { candidate: 4, included: 3, actual: 2, dropped: 1 },
      actualKindCounts: { memory: 0, knowledge: 1, graph: 1 },
      coverage: "explicit_selection_only",
      interpretation: "explicit_completed_run_feedback_correlation_not_causal",
      shadowOnly: true,
      rankingEffect: "none",
    });
    expect(observation?.observationSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(observation)).toBe(true);
  });

  it("fails closed when a context receipt body is tampered", () => {
    const fixture = buildFixture();
    fixture.events[0] = {
      ...fixture.events[0],
      payload: { ...fixture.events[0].payload, actualCount: 3 },
    };

    expect(() => projectRetrievalOutcomeObservationV1(fixture)).toThrow(
      /context receipt is invalid/i,
    );
  });

  it("rejects cross-scope events and invalid event chronology", () => {
    for (const changed of [
      { tenantId: "another-tenant" },
      { actorId: "another-actor" },
      { streamId: "run:another-run" },
    ]) {
      const fixture = buildFixture();
      fixture.events[0] = { ...fixture.events[0], ...changed };
      expect(() => projectRetrievalOutcomeObservationV1(fixture)).toThrow(
        /event scope/i,
      );
    }

    const reversed = buildFixture();
    reversed.events.reverse();
    expect(() => projectRetrievalOutcomeObservationV1(reversed)).toThrow(
      /strictly ordered/i,
    );

    const feedbackBeforeContext = buildFixture();
    feedbackBeforeContext.events = [
      { ...feedbackBeforeContext.events[1], seq: 10, at: contextEventAt },
      { ...feedbackBeforeContext.events[0], seq: 11, at: feedbackAt },
    ];
    expect(() => projectRetrievalOutcomeObservationV1(feedbackBeforeContext)).toThrow(
      /chronology order/i,
    );
  });

  it("uses only the latest feedback revision and binds it to mutable run state", () => {
    const fixture = buildFixture({
      verdict: "needs_work",
      correction: "Private correction details",
      feedbackAt: "2026-09-11T10:04:00.000Z",
    });
    fixture.events.splice(1, 0, domainEvent({
      id: "event-feedback-earlier",
      seq: 20,
      type: "run.feedback",
      at: feedbackAt,
      payload: { verdict: "useful", hasCorrection: false },
    }));
    fixture.events[2] = {
      ...fixture.events[2],
      seq: 21,
      id: "event-feedback-latest",
    };

    const observation = projectRetrievalOutcomeObservationV1(fixture);
    expect(observation).toMatchObject({
      latestFeedbackEventId: "event-feedback-latest",
      verdict: "needs_work",
      feedbackAt: "2026-09-11T10:04:00.000Z",
    });
    expect(JSON.stringify(observation)).not.toContain("Private correction details");

    const mismatched = buildFixture();
    mismatched.run.feedback = {
      verdict: "needs_work",
      correction: "Private mismatch",
      updatedAt: feedbackAt,
    };
    expect(() => projectRetrievalOutcomeObservationV1(mismatched)).toThrow(
      /does not match the run/i,
    );
  });

  it("keeps an explicit zero-context receipt as a control observation", () => {
    const fixture = buildFixture({ actualEvidenceIds: [] });
    const observation = projectRetrievalOutcomeObservationV1(fixture);

    expect(observation?.receiptCounts).toEqual({
      candidate: 4,
      included: 3,
      actual: 0,
      dropped: 3,
    });
    expect(observation?.actualKindCounts).toEqual({
      memory: 0,
      knowledge: 0,
      graph: 0,
    });

    const noReceipt = buildFixture();
    noReceipt.events = noReceipt.events.filter(
      (event) => event.type !== "run.context.receipt",
    );
    expect(projectRetrievalOutcomeObservationV1(noReceipt)).toBeUndefined();
  });

  it("publishes counts without scope, event, receipt, evidence, or correction IDs", () => {
    const usefulFixture = buildFixture();
    const needsWorkFixture = buildFixture({
      runId: "run-second",
      verdict: "needs_work",
      correction: "Never expose this correction",
      feedbackAt: "2026-09-11T10:05:00.000Z",
    });
    const observations = [
      projectRetrievalOutcomeObservationV1(usefulFixture),
      projectRetrievalOutcomeObservationV1(needsWorkFixture),
    ].filter((value): value is NonNullable<typeof value> => Boolean(value));
    const aggregate = projectPublicRetrievalOutcomeAggregateV1({
      tenantId,
      actorId,
      observations,
    });

    expect(aggregate).toEqual({
      schemaVersion: 1,
      version: "retrieval-outcome-public-aggregate:1",
      sampleCount: 2,
      feedbackCounts: { useful: 1, needsWork: 1 },
      receiptTotals: { candidate: 8, included: 6, actual: 4, dropped: 2 },
      actualKindTotals: { memory: 0, knowledge: 2, graph: 2 },
      coverage: "explicit_selection_only",
      interpretation: "explicit_completed_run_feedback_correlation_not_causal",
      shadowOnly: true,
      rankingEffect: "none",
    });
    const serialized = JSON.stringify(aggregate);
    for (const privateValue of [
      tenantId,
      actorId,
      runId,
      "run-second",
      "event-context",
      "event-feedback",
      "knowledge:runbook",
      "graph:owner",
      "Never expose this correction",
      observations[0].contextReceiptSha256,
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(Object.isFrozen(aggregate)).toBe(true);
  });
});

function buildFixture(options: {
  runId?: string;
  verdict?: "useful" | "needs_work";
  correction?: string;
  feedbackAt?: string;
  actualEvidenceIds?: string[];
} = {}) {
  const selectedRunId = options.runId || runId;
  const selectedFeedbackAt = options.feedbackAt || feedbackAt;
  const verdict = options.verdict || "useful";
  const candidates = [
    "knowledge:runbook",
    "memory:preference",
    "graph:owner",
    "knowledge:excluded",
  ];
  const preview = issueContextSelectionPreview({
    tenantId,
    actorId,
    query: "Use reviewed context",
    candidateEvidenceIds: candidates,
    contextPackSha256: "a".repeat(64),
    now: new Date(startedAt),
  });
  const locked = lockContextSelection({
    tenantId,
    actorId,
    query: "Use reviewed context",
    evidenceIds: candidates.slice(0, 3),
    previewToken: preview.token,
    now: new Date(startedAt),
  });
  const receipt = buildContextUseReceiptV1({
    runId: selectedRunId,
    selection: locked.binding,
    actualEvidenceIds: options.actualEvidenceIds || [
      "knowledge:runbook",
      "graph:owner",
    ],
    retrievalTraceId: `trace:${selectedRunId}`,
    compiledContext: "Private compiled context",
    contextBudget: { maxTokens: 4_000 },
    recordedAt: contextRecordedAt,
  });
  const run: AgentRunRecord = {
    id: selectedRunId,
    tenantId,
    ownerActorId: actorId,
    mode: "orchestrate",
    status: "completed",
    prompt: "Private prompt",
    messages: [],
    memoryContextCount: receipt.actualCount,
    response: "Private response",
    feedback: {
      verdict,
      correction: options.correction,
      updatedAt: selectedFeedbackAt,
    },
    startedAt,
    completedAt,
  };
  const events = [
    domainEvent({
      id: "event-context",
      seq: 10,
      runId: selectedRunId,
      type: "run.context.receipt",
      at: contextEventAt,
      payload: receipt,
    }),
    domainEvent({
      id: "event-feedback",
      seq: 20,
      runId: selectedRunId,
      type: "run.feedback",
      at: selectedFeedbackAt,
      payload: { verdict, hasCorrection: Boolean(options.correction) },
    }),
  ];
  return { tenantId, actorId, run, events };
}

function domainEvent(input: {
  id: string;
  seq: number;
  runId?: string;
  type: string;
  at: string;
  payload: Record<string, unknown>;
}): DomainEvent {
  return {
    id: input.id,
    seq: input.seq,
    streamId: `run:${input.runId || runId}`,
    type: input.type,
    tenantId,
    actorId,
    payload: input.payload,
    correlationId: input.runId || runId,
    at: input.at,
  };
}
