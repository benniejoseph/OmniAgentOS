import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@/lib/events/store";
import {
  issueContextSelectionPreview,
  lockContextSelection,
} from "@/lib/rag/context-selection-lock";
import { buildContextUseReceiptV1 } from "@/lib/rag/context-use-receipt";
import type { AgentRunRecord } from "@/lib/runs/types";

const mocks = vi.hoisted(() => ({
  database: false,
  ensureSchema: vi.fn(),
  query: vi.fn(),
  listRuns: vi.fn(),
  listEvents: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({
  ensureDatabaseSchema: mocks.ensureSchema,
  getSql: () => ({ query: mocks.query }),
  hasDatabaseUrl: () => mocks.database,
}));

vi.mock("@/lib/runs/store", () => ({
  listAgentRuns: mocks.listRuns,
}));

vi.mock("@/lib/events/store", () => ({
  listStreamEvents: mocks.listEvents,
}));

import { listActorRetrievalOutcomeObservations } from "@/lib/runs/retrieval-outcomes";

const tenantId = "tenant-outcome-store";
const actorId = "actor-outcome-store";
const startedAt = "2026-09-11T11:00:00.000Z";
const completedAt = "2026-09-11T11:02:00.000Z";
const feedbackAt = "2026-09-11T11:03:00.000Z";

describe("retrieval outcome bounded store", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.database = false;
    vi.stubEnv("OMNIAGENT_INTERNAL_AUTH_SECRET", "retrieval-store-test-secret");
  });

  it("loads only exact actor-owned completed rated runs in file mode", async () => {
    const valid = fixture("run-valid");
    mocks.listRuns.mockResolvedValue([
      { ...valid.run, ownerActorId: "another-actor" },
      { ...valid.run, id: "run-running", status: "running" },
      { ...valid.run, id: "run-unrated", feedback: undefined },
      valid.run,
    ]);
    mocks.listEvents.mockResolvedValue(valid.events);

    const result = await listActorRetrievalOutcomeObservations({
      tenantId,
      ownerActorIds: [actorId, actorId],
      limit: 20,
    });

    expect(mocks.listRuns).toHaveBeenCalledWith(500, { tenantId });
    expect(mocks.listEvents).toHaveBeenCalledWith("run:run-valid", {
      tenantId,
      actorId,
      limit: 2_000,
      order: "asc",
    });
    expect(result).toMatchObject({
      eligibleRatedRunCount: 1,
      invalidOrExcludedCount: 0,
      observations: [{ runId: "run-valid", verdict: "useful" }],
    });
  });

  it("counts missing, malformed, and cross-scope pairs without guessing", async () => {
    const valid = fixture("run-valid");
    const missing = fixture("run-missing");
    const tampered = fixture("run-tampered");
    const wrongScope = fixture("run-wrong-scope");
    mocks.listRuns.mockResolvedValue([
      wrongScope.run,
      tampered.run,
      missing.run,
      valid.run,
    ]);
    mocks.listEvents.mockImplementation(async (streamId: string) => {
      if (streamId === "run:run-valid") return valid.events;
      if (streamId === "run:run-missing") return [];
      if (streamId === "run:run-tampered") {
        return tampered.events.map((event, index) => index === 0
          ? { ...event, payload: { ...event.payload, actualCount: 8 } }
          : event);
      }
      return wrongScope.events.map((event) => ({
        ...event,
        actorId: "another-actor",
      }));
    });

    const result = await listActorRetrievalOutcomeObservations({
      tenantId,
      ownerActorIds: [actorId],
    });

    expect(result.eligibleRatedRunCount).toBe(4);
    expect(result.observations.map((item) => item.runId)).toEqual(["run-valid"]);
    expect(result.invalidOrExcludedCount).toBe(3);
  });

  it("uses bounded PostgreSQL reads with exact scope and deterministic latest events", async () => {
    mocks.database = true;
    const older = fixture("run-older", {
      startedAt: "2026-09-11T09:00:00.000Z",
      completedAt: "2026-09-11T09:02:00.000Z",
      feedbackAt: "2026-09-11T09:03:00.000Z",
    });
    const newer = fixture("run-newer");
    const rows = [databaseRunRow(older.run), databaseRunRow(newer.run)];
    const eventRows = [...databaseEventRows(older.events), ...databaseEventRows(newer.events)];
    mocks.query
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce(eventRows.reverse());

    const result = await listActorRetrievalOutcomeObservations({
      tenantId,
      ownerActorIds: [actorId],
      limit: 900,
    });

    expect(mocks.ensureSchema).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    const [runQuery, runParams] = mocks.query.mock.calls[0];
    expect(runQuery).toContain("owner_actor_id = ANY($2::text[])");
    expect(runQuery).toContain("status = 'completed'");
    expect(runQuery).toContain("feedback IS NOT NULL");
    expect(runQuery).toContain("ORDER BY completed_at DESC, started_at DESC, id ASC");
    expect(runParams).toEqual([tenantId, [actorId], 500]);
    const [eventQuery, eventParams] = mocks.query.mock.calls[1];
    expect(eventQuery).toContain("DISTINCT ON (event.stream_id, event.type)");
    expect(eventQuery).toContain("event.actor_id = run.owner_actor_id");
    expect(eventQuery).toContain("event.type IN ('run.context.receipt', 'run.feedback')");
    expect(eventParams[0]).toBe(tenantId);
    expect(eventParams[1]).toEqual([actorId]);
    expect(eventParams[2]).toEqual(["run-newer", "run-older"]);
    expect(eventParams[3]).toBe(4);
    expect(result.observations.map((item) => item.runId)).toEqual([
      "run-newer",
      "run-older",
    ]);
    expect(result.invalidOrExcludedCount).toBe(0);
  });

  it("defensively excludes malformed PostgreSQL rows and event pairs", async () => {
    mocks.database = true;
    const valid = fixture("run-valid");
    const invalid = fixture("run-invalid");
    const invalidRow = {
      ...databaseRunRow(invalid.run),
      feedback: { verdict: "useful", updatedAt: "not-a-date" },
    };
    mocks.query
      .mockResolvedValueOnce([databaseRunRow(valid.run), invalidRow])
      .mockResolvedValueOnce(databaseEventRows(valid.events));

    const result = await listActorRetrievalOutcomeObservations({
      tenantId,
      ownerActorIds: [actorId],
    });

    expect(result).toMatchObject({
      eligibleRatedRunCount: 2,
      invalidOrExcludedCount: 1,
    });
    expect(result.observations.map((item) => item.runId)).toEqual(["run-valid"]);
  });

  it("validates bounded scope inputs and returns a frozen empty result", async () => {
    const empty = await listActorRetrievalOutcomeObservations({
      tenantId,
      ownerActorIds: [],
    });
    expect(empty).toEqual({
      eligibleRatedRunCount: 0,
      observations: [],
      invalidOrExcludedCount: 0,
    });
    expect(Object.isFrozen(empty)).toBe(true);
    expect(Object.isFrozen(empty.observations)).toBe(true);
    await expect(listActorRetrievalOutcomeObservations({
      tenantId,
      ownerActorIds: Array.from({ length: 9 }, (_, index) => `actor-${index}`),
    })).rejects.toThrow(/at most 8/i);
    await expect(listActorRetrievalOutcomeObservations({
      tenantId: ` ${tenantId}`,
      ownerActorIds: [actorId],
    })).rejects.toThrow(/tenant id is invalid/i);
  });
});

function fixture(runId: string, times: {
  startedAt?: string;
  completedAt?: string;
  feedbackAt?: string;
} = {}) {
  const runStartedAt = times.startedAt || startedAt;
  const runCompletedAt = times.completedAt || completedAt;
  const runFeedbackAt = times.feedbackAt || feedbackAt;
  const runContextAt = new Date(Date.parse(runStartedAt) + 60_000).toISOString();
  const preview = issueContextSelectionPreview({
    tenantId,
    actorId,
    query: "Use my context",
    candidateEvidenceIds: ["knowledge:guide", "memory:preference"],
    contextPackSha256: "b".repeat(64),
    now: new Date(runStartedAt),
  });
  const locked = lockContextSelection({
    tenantId,
    actorId,
    query: "Use my context",
    evidenceIds: ["knowledge:guide"],
    previewToken: preview.token,
    now: new Date(runStartedAt),
  });
  const receipt = buildContextUseReceiptV1({
    runId,
    selection: locked.binding,
    actualEvidenceIds: ["knowledge:guide"],
    compiledContext: "Private context",
    contextBudget: { maxTokens: 1_000 },
    recordedAt: runContextAt,
  });
  const run: AgentRunRecord = {
    id: runId,
    tenantId,
    ownerActorId: actorId,
    mode: "orchestrate",
    status: "completed",
    prompt: "Private prompt",
    messages: [],
    feedback: { verdict: "useful", updatedAt: runFeedbackAt },
    memoryContextCount: 1,
    startedAt: runStartedAt,
    completedAt: runCompletedAt,
  };
  const events: DomainEvent[] = [
    event(runId, "context", 10, "run.context.receipt", runContextAt, receipt),
    event(runId, "feedback", 20, "run.feedback", runFeedbackAt, {
      verdict: "useful",
      hasCorrection: false,
    }),
  ];
  return { run, events };
}

function event(
  runId: string,
  suffix: string,
  seq: number,
  type: string,
  at: string,
  payload: Record<string, unknown>,
): DomainEvent {
  return {
    id: `event-${runId}-${suffix}`,
    seq,
    streamId: `run:${runId}`,
    type,
    tenantId,
    actorId,
    payload,
    correlationId: runId,
    at,
  };
}

function databaseRunRow(run: AgentRunRecord) {
  return {
    id: run.id,
    tenant_id: run.tenantId,
    owner_actor_id: run.ownerActorId,
    mode: run.mode,
    status: run.status,
    feedback: run.feedback,
    memory_context_count: run.memoryContextCount,
    started_at: run.startedAt,
    completed_at: run.completedAt,
  };
}

function databaseEventRows(events: readonly DomainEvent[]) {
  return events.map((item) => ({
    id: item.id,
    seq: item.seq,
    stream_id: item.streamId,
    type: item.type,
    tenant_id: item.tenantId,
    actor_id: item.actorId,
    payload: item.payload,
    correlation_id: item.correlationId,
    at: item.at,
  }));
}
