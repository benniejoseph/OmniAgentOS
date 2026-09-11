import "server-only";

import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
} from "@/lib/db/client";
import { listStreamEvents, type DomainEvent } from "@/lib/events/store";
import type { AgentMode } from "@/lib/orchestration/types";
import {
  projectRetrievalOutcomeObservationV1,
  type RetrievalOutcomeObservationV1,
} from "@/lib/rag/retrieval-outcome";
import { listAgentRuns } from "@/lib/runs/store";
import type { AgentRunFeedback, AgentRunRecord } from "@/lib/runs/types";

const DEFAULT_RUN_LIMIT = 200;
const MAX_RUN_LIMIT = 500;
const MAX_OWNER_ACTOR_IDS = 8;
const MAX_FILE_STREAM_EVENTS = 2_000;

type Row = Record<string, unknown>;

export type ActorRetrievalOutcomeObservations = Readonly<{
  eligibleRatedRunCount: number;
  observations: readonly RetrievalOutcomeObservationV1[];
  invalidOrExcludedCount: number;
}>;

/**
 * Reads a bounded window of explicitly rated, completed runs and derives
 * shadow-only retrieval outcome observations. It performs no writes, model
 * calls, or ranking changes. A malformed or incomplete event pair is counted
 * as excluded instead of being repaired or inferred.
 */
export async function listActorRetrievalOutcomeObservations(input: Readonly<{
  tenantId: string;
  ownerActorIds: readonly string[];
  limit?: number;
}>): Promise<ActorRetrievalOutcomeObservations> {
  const tenantId = requiredId(input.tenantId, "tenant", 120);
  const ownerActorIds = uniqueOwnerActorIds(input.ownerActorIds);
  const limit = boundedLimit(input.limit);
  if (ownerActorIds.length === 0) return emptyResult();

  return hasDatabaseUrl()
    ? listDatabaseObservations({ tenantId, ownerActorIds, limit })
    : listFileObservations({ tenantId, ownerActorIds, limit });
}

async function listDatabaseObservations(input: {
  tenantId: string;
  ownerActorIds: readonly string[];
  limit: number;
}): Promise<ActorRetrievalOutcomeObservations> {
  await ensureDatabaseSchema();
  const sql = getSql();
  const rawRows = await sql.query(
    `SELECT id, tenant_id, owner_actor_id, mode, status, feedback,
            memory_context_count, started_at, completed_at
     FROM omni_agent_runs
     WHERE tenant_id = $1
       AND owner_actor_id = ANY($2::text[])
       AND status = 'completed'
       AND feedback IS NOT NULL
     ORDER BY completed_at DESC, started_at DESC, id ASC
     LIMIT $3`,
    [input.tenantId, input.ownerActorIds, input.limit],
  );
  const selectedRows = [...rawRows]
    .sort(compareDatabaseRunRows)
    .slice(0, input.limit);
  const parsedRuns = selectedRows.map(parseDatabaseRun);
  const runIds = parsedRuns.flatMap((run) => run ? [run.id] : []);
  const eventsByRun = new Map<string, DomainEvent[]>();

  if (runIds.length > 0) {
    const eventRows = await sql.query(
      `SELECT DISTINCT ON (event.stream_id, event.type)
              event.id, event.seq, event.stream_id, event.type,
              event.tenant_id, event.actor_id, event.payload,
              event.causation_id, event.correlation_id, event.at
       FROM omni_events event
       JOIN omni_agent_runs run
         ON run.tenant_id = event.tenant_id
        AND event.stream_id = ('run:' || run.id)
        AND event.actor_id = run.owner_actor_id
       WHERE run.tenant_id = $1
         AND run.owner_actor_id = ANY($2::text[])
         AND run.id = ANY($3::text[])
         AND event.type IN ('run.context.receipt', 'run.feedback')
       ORDER BY event.stream_id ASC, event.type ASC, event.seq DESC,
                event.id ASC
       LIMIT $4`,
      [
        input.tenantId,
        input.ownerActorIds,
        runIds,
        Math.min(runIds.length * 2, MAX_RUN_LIMIT * 2),
      ],
    );
    for (const row of eventRows) {
      const event = parseDatabaseEvent(row);
      if (!event) continue;
      const runId = runIdFromStream(event.streamId);
      if (!runId || !runIds.includes(runId)) continue;
      const events = eventsByRun.get(runId) || [];
      events.push(event);
      eventsByRun.set(runId, events);
    }
  }

  return deriveObservations({
    tenantId: input.tenantId,
    eligibleRuns: parsedRuns,
    eventsForRun: async (run) => eventsByRun.get(run.id) || [],
  });
}

async function listFileObservations(input: {
  tenantId: string;
  ownerActorIds: readonly string[];
  limit: number;
}): Promise<ActorRetrievalOutcomeObservations> {
  const ownerIds = new Set(input.ownerActorIds);
  const runs = (await listAgentRuns(MAX_RUN_LIMIT, {
    tenantId: input.tenantId,
  }))
    .filter((run) =>
      run.tenantId === input.tenantId &&
      ownerIds.has(run.ownerActorId) &&
      run.status === "completed" &&
      Boolean(run.feedback)
    )
    .sort(compareRuns)
    .slice(0, input.limit);

  return deriveObservations({
    tenantId: input.tenantId,
    eligibleRuns: runs,
    eventsForRun: async (run) => {
      const events = await listStreamEvents(`run:${run.id}`, {
        tenantId: input.tenantId,
        actorId: run.ownerActorId,
        limit: MAX_FILE_STREAM_EVENTS,
        order: "asc",
      });
      return events.filter((event) =>
        event.type === "run.context.receipt" || event.type === "run.feedback"
      );
    },
  });
}

async function deriveObservations(input: {
  tenantId: string;
  eligibleRuns: readonly (AgentRunRecord | undefined)[];
  eventsForRun: (run: AgentRunRecord) => Promise<readonly DomainEvent[]>;
}): Promise<ActorRetrievalOutcomeObservations> {
  const observations: RetrievalOutcomeObservationV1[] = [];
  let invalidOrExcludedCount = 0;

  for (const run of input.eligibleRuns) {
    if (!run) {
      invalidOrExcludedCount += 1;
      continue;
    }
    try {
      const events = [...await input.eventsForRun(run)]
        .sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
      const observation = projectRetrievalOutcomeObservationV1({
        tenantId: input.tenantId,
        actorId: run.ownerActorId,
        run,
        events,
      });
      if (observation) observations.push(observation);
      else invalidOrExcludedCount += 1;
    } catch {
      invalidOrExcludedCount += 1;
    }
  }

  return deepFreeze({
    eligibleRatedRunCount: input.eligibleRuns.length,
    observations,
    invalidOrExcludedCount,
  });
}

function parseDatabaseRun(row: Row): AgentRunRecord | undefined {
  const id = exactText(row.id, 240);
  const tenantId = exactText(row.tenant_id, 120);
  const ownerActorId = exactText(row.owner_actor_id, 320);
  const mode = agentMode(row.mode);
  const startedAt = date(row.started_at);
  const completedAt = date(row.completed_at);
  const feedback = feedbackRecord(row.feedback);
  const memoryContextCount = count(row.memory_context_count);
  if (
    !id || !tenantId || !ownerActorId || !mode ||
    row.status !== "completed" || !startedAt || !completedAt ||
    !feedback || memoryContextCount === undefined
  ) return undefined;
  return {
    id,
    tenantId,
    ownerActorId,
    mode,
    status: "completed",
    prompt: "",
    messages: [],
    feedback,
    memoryContextCount,
    startedAt,
    completedAt,
  };
}

function parseDatabaseEvent(row: Row): DomainEvent | undefined {
  const id = exactText(row.id, 240);
  const streamId = exactText(row.stream_id, 480);
  const type = row.type === "run.context.receipt" || row.type === "run.feedback"
    ? row.type
    : undefined;
  const tenantId = exactText(row.tenant_id, 120);
  const actorId = exactText(row.actor_id, 320);
  const seq = count(row.seq);
  const at = date(row.at);
  const payload = record(row.payload);
  if (!id || !streamId || !type || !tenantId || !actorId || !seq || !at || !payload) {
    return undefined;
  }
  return {
    id,
    seq,
    streamId,
    type,
    tenantId,
    actorId,
    payload,
    causationId: exactText(row.causation_id, 240),
    correlationId: exactText(row.correlation_id, 240),
    at,
  };
}

function feedbackRecord(value: unknown): AgentRunFeedback | undefined {
  const item = record(value);
  if (!item || (item.verdict !== "useful" && item.verdict !== "needs_work")) {
    return undefined;
  }
  const updatedAt = date(item.updatedAt);
  if (!updatedAt) return undefined;
  if (item.correction !== undefined && typeof item.correction !== "string") {
    return undefined;
  }
  return {
    verdict: item.verdict,
    ...(item.correction ? { correction: item.correction } : {}),
    updatedAt,
  };
}

function compareDatabaseRunRows(left: Row, right: Row) {
  return compareRunOrder(
    date(right.completed_at),
    date(left.completed_at),
    date(right.started_at),
    date(left.started_at),
    String(left.id || ""),
    String(right.id || ""),
  );
}

function compareRuns(left: AgentRunRecord, right: AgentRunRecord) {
  return compareRunOrder(
    right.completedAt,
    left.completedAt,
    right.startedAt,
    left.startedAt,
    left.id,
    right.id,
  );
}

function compareRunOrder(
  rightCompleted: string | undefined,
  leftCompleted: string | undefined,
  rightStarted: string | undefined,
  leftStarted: string | undefined,
  leftId: string,
  rightId: string,
) {
  return String(rightCompleted || "").localeCompare(String(leftCompleted || "")) ||
    String(rightStarted || "").localeCompare(String(leftStarted || "")) ||
    leftId.localeCompare(rightId);
}

function uniqueOwnerActorIds(values: readonly string[]) {
  const ids = [...new Set(values.map((value) =>
    requiredId(value, "owner actor", 320)
  ))];
  if (ids.length > MAX_OWNER_ACTOR_IDS) {
    throw new Error(`Retrieval outcomes support at most ${MAX_OWNER_ACTOR_IDS} owner actor ids.`);
  }
  return ids;
}

function boundedLimit(value: number | undefined) {
  if (value === undefined) return DEFAULT_RUN_LIMIT;
  if (!Number.isFinite(value)) throw new Error("Retrieval outcome limit is invalid.");
  return Math.min(Math.max(Math.trunc(value), 1), MAX_RUN_LIMIT);
}

function requiredId(value: string, label: string, maxLength: number) {
  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > maxLength || value.includes("\0")) {
    throw new Error(`Retrieval outcome ${label} id is invalid.`);
  }
  return normalized;
}

function exactText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed && trimmed === value && trimmed.length <= maxLength && !value.includes("\0")
    ? trimmed
    : undefined;
}

function agentMode(value: unknown): AgentMode | undefined {
  return value === "orchestrate" || value === "research" ||
      value === "execute" || value === "learn"
    ? value
    : undefined;
}

function count(value: unknown) {
  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)
      ? Number(value)
      : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function date(value: unknown) {
  const parsed = value instanceof Date
    ? value.getTime()
    : typeof value === "string" && value.trim() === value
      ? Date.parse(value)
      : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function runIdFromStream(streamId: string) {
  return streamId.startsWith("run:") ? streamId.slice(4) : undefined;
}

function emptyResult(): ActorRetrievalOutcomeObservations {
  return deepFreeze({
    eligibleRatedRunCount: 0,
    observations: [],
    invalidOrExcludedCount: 0,
  });
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}
