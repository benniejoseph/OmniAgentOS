import { createHash } from "node:crypto";

import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { appendScopedDomainEvent } from "@/lib/events/store";
import { AGENT_MAX_MESSAGES } from "@/lib/config";
import type { AgentMode, ChatMessage } from "@/lib/orchestration/types";
import {
  buildCheckpointCorrectionMessages,
  buildRunForkEventPrefixV1,
  buildRunForkLineageV1,
  parseRunForkLineageV1,
  validateRunCheckpointForkChainV1,
  type RunForkLineageV1,
} from "@/lib/runs/forks";
import { getAgentRun } from "@/lib/runs/store";
import type { AgentRunRecord } from "@/lib/runs/types";
import { redactSensitive } from "@/lib/security/context";
import {
  assertExecutionScopeTenant,
  parsePersistedExecutionScope,
  type ExecutionScope,
} from "@/lib/security/execution-scope";

type SqlRow = Record<string, unknown>;

export type CreateRunForkInput = Readonly<{
  tenantId: string;
  actorId: string;
  sourceRunId: string;
  checkpointId: string;
  correction: string;
  idempotencyKey: string;
  executionScope: ExecutionScope;
}>;

export type CreateRunForkResult = Readonly<{
  lineage: RunForkLineageV1;
  run: AgentRunRecord;
  created: boolean;
}>;

export async function createRunForkFromCheckpoint(
  input: CreateRunForkInput,
): Promise<CreateRunForkResult> {
  if (!hasDatabaseUrl()) {
    throw new Error("Checkpoint forks require the durable Postgres event store.");
  }
  await ensureDatabaseSchema();
  const tenantId = required(input.tenantId, "tenant id");
  const actorId = required(input.actorId, "actor id");
  const executionScope = parsePersistedExecutionScope(input.executionScope);
  if (!executionScope) throw new Error("Checkpoint fork execution scope is invalid.");
  assertExecutionScopeTenant(executionScope, tenantId);
  if (executionScope.initiatingActorId !== actorId) {
    throw new Error("Checkpoint fork actor does not match its execution scope.");
  }
  const safeCorrection = String(redactSensitive(input.correction)).trim();

  const stored = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
    const sourceRows = await sql.query(
      `SELECT run.*,
              CASE WHEN thread.actor_id = $2 THEN run.thread_id ELSE NULL END
                AS fork_thread_id
       FROM omni_agent_runs run
       LEFT JOIN omni_threads thread
         ON thread.tenant_id = run.tenant_id AND thread.id = run.thread_id
       WHERE run.tenant_id = $1 AND run.id = $3
       ORDER BY run.id ASC
       LIMIT 2
       FOR SHARE OF run`,
      [tenantId, actorId, input.sourceRunId],
    );
    const source = exactlyOne(sourceRows, "source run");

    const selectedRows = await sql.query(
      `SELECT sequence
       FROM omni_run_checkpoints
       WHERE tenant_id = $1 AND run_id = $2 AND checkpoint_id = $3
       ORDER BY checkpoint_id ASC
       LIMIT 2
       FOR SHARE`,
      [tenantId, input.sourceRunId, input.checkpointId],
    );
    const selected = exactlyOne(selectedRows, "source checkpoint");
    const selectedSequence = Number(selected.sequence);
    if (!Number.isSafeInteger(selectedSequence) || selectedSequence < 0) {
      throw new Error("Source checkpoint sequence is invalid.");
    }
    const checkpointRows = await sql.query(
      `SELECT checkpoint_json
       FROM omni_run_checkpoints
       WHERE tenant_id = $1 AND run_id = $2 AND sequence <= $3
       ORDER BY sequence ASC`,
      [tenantId, input.sourceRunId, selectedSequence],
    );
    const checkpoint = validateRunCheckpointForkChainV1(
      checkpointRows.map((row) => row.checkpoint_json),
      input.checkpointId,
    );

    const checkpointEventRows = await sql.query(
      `SELECT id, seq, type, payload, at
       FROM omni_events
       WHERE tenant_id = $1
         AND stream_id = $2
         AND type = 'run.checkpoint.recorded'
         AND payload ->> 'checkpointId' = $3
         AND payload ->> 'checkpointSha256' = $4
       ORDER BY seq ASC
       LIMIT 2
       FOR SHARE`,
      [
        tenantId,
        `run:${input.sourceRunId}`,
        checkpoint.checkpointId,
        checkpoint.checkpointSha256,
      ],
    );
    const checkpointEvent = exactlyOne(
      checkpointEventRows,
      "source checkpoint event",
    );
    const checkpointEventSeq = Number(checkpointEvent.seq);
    const eventRows = await sql.query(
      `SELECT id, seq, type, payload, at
       FROM omni_events
       WHERE tenant_id = $1 AND stream_id = $2 AND seq <= $3
       ORDER BY seq ASC
       LIMIT 2001
       FOR SHARE`,
      [tenantId, `run:${input.sourceRunId}`, checkpointEventSeq],
    );
    const eventPrefix = buildRunForkEventPrefixV1(
      eventRows.map(replayEventFromRow),
      checkpoint,
    );
    const createdAt = new Date().toISOString();
    const lineage = buildRunForkLineageV1({
      checkpoint,
      executionScope,
      correction: safeCorrection,
      idempotencyKey: input.idempotencyKey,
      eventPrefix,
      createdAt,
    });

    const existingRows = await sql.query(
      `SELECT lineage_json
       FROM omni_run_forks
       WHERE tenant_id = $1 AND fork_id = $2
       ORDER BY fork_id ASC
       LIMIT 2
       FOR SHARE`,
      [tenantId, lineage.forkId],
    );
    if (existingRows.length) {
      const existing = parseRunForkLineageV1(
        exactlyOne(existingRows, "existing run fork").lineage_json,
      );
      assertIdempotentRunFork(existing, lineage);
      return { lineage: existing, created: false };
    }

    const messages = buildCheckpointCorrectionMessages({
      sourceMessages: messagesFromRow(source.messages),
      checkpoint,
      correction: safeCorrection,
      maxMessages: AGENT_MAX_MESSAGES,
    });
    const safeMessages = redactSensitive(messages) as ChatMessage[];
    const prompt = safeMessages.at(-1)?.content || safeCorrection;
    const mode = agentModeFromRow(source.mode);
    const agentId = required(String(source.agent_id || "atlas"), "agent id");
    const specialistIds = Array.isArray(source.specialist_ids)
      ? source.specialist_ids.map(String).filter(Boolean).slice(0, 5)
      : [agentId];
    const forkThreadId = source.fork_thread_id
      ? String(source.fork_thread_id)
      : null;

    const insertedRuns = await sql.query(
      `INSERT INTO omni_agent_runs (
         id, tenant_id, thread_id, mode, status, prompt, messages, model,
         agent_id, specialist_ids, memory_context_count, consolidation_count,
         continuation, started_at
       ) VALUES (
         $1, $2, $3, $4, 'queued', $5, $6::jsonb, $7, $8, $9, 0, 0,
         NULL, $10
       )
       ON CONFLICT (id) DO NOTHING
       RETURNING id`,
      [
        lineage.target.runId,
        tenantId,
        forkThreadId,
        mode,
        prompt,
        safeMessages,
        source.model ? String(source.model) : null,
        agentId,
        specialistIds,
        createdAt,
      ],
    );
    if (insertedRuns.length !== 1) {
      throw new Error("Checkpoint fork target run identity already exists.");
    }

    await sql.query(
      `INSERT INTO omni_run_forks (
         schema_version, fork_id, tenant_id, initiating_actor_id,
         source_run_id, source_checkpoint_id, source_checkpoint_sha256,
         source_checkpoint_sequence, fork_run_id, execution_scope_sha256,
         context_grant_ids_sha256, capability_grant_ids_sha256,
         correction_length, correction_sha256, idempotency_key_sha256,
         source_event_prefix_count, source_event_prefix_last_seq,
         source_event_prefix_sha256, lineage_json, created_at
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
         $14, $15, $16, $17, $18, $19::jsonb, $20
       )`,
      lineageInsertParams(lineage),
    );

    await appendScopedDomainEvent({
      id: `run-fork-scope-bound:${lineage.forkId}`,
      streamId: `run:${lineage.target.runId}`,
      type: "run.scope_bound",
      executionScope,
      payload: {
        scopeVersion: executionScope.version,
        scopeSha256: lineage.target.executionScopeSha256,
      },
    }, { sql });
    const eventPayload = runForkEventPayload(lineage);
    await appendScopedDomainEvent({
      id: `run-fork-created:${lineage.forkId}`,
      streamId: `run:${lineage.target.runId}`,
      type: "run.fork.created",
      executionScope,
      payload: eventPayload,
    }, { sql });
    await appendScopedDomainEvent({
      id: `run-forked:${lineage.forkId}`,
      streamId: `run:${lineage.source.runId}`,
      type: "run.forked",
      executionScope,
      payload: eventPayload,
    }, { sql });

    if (forkThreadId) {
      await sql.query(
        `INSERT INTO omni_thread_turns (
           id, tenant_id, thread_id, role, content, run_id, created_at
         ) VALUES ($1, $2, $3, 'user', $4, $5, $6)
         ON CONFLICT (id) DO NOTHING`,
        [
          `run-fork-turn:${lineage.forkId}`,
          tenantId,
          forkThreadId,
          safeCorrection,
          lineage.target.runId,
          createdAt,
        ],
      );
      await sql.query(
        `UPDATE omni_threads SET updated_at = $3
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, forkThreadId, createdAt],
      );
    }
    return { lineage, created: true };
  }) as { lineage: RunForkLineageV1; created: boolean };

  const run = await getAgentRun(stored.lineage.target.runId, { tenantId });
  if (!run) throw new Error("Checkpoint fork target run could not be read.");
  if (run.continuation) {
    throw new Error("Checkpoint fork target unexpectedly inherited continuation state.");
  }
  return Object.freeze({ ...stored, run });
}

export async function listRunForkLineage(
  runId: string,
  options: { tenantId: string; limit?: number },
) {
  if (!hasDatabaseUrl()) return { parent: undefined, children: [] };
  await ensureDatabaseSchema();
  const limit = Math.min(Math.max(Math.trunc(options.limit || 50), 1), 100);
  const rows = await getSql().query(
    `SELECT lineage_json
     FROM omni_run_forks
     WHERE tenant_id = $1 AND (source_run_id = $2 OR fork_run_id = $2)
     ORDER BY created_at ASC, fork_id ASC
     LIMIT $3`,
    [options.tenantId, runId, limit + 1],
  );
  if (rows.length > limit) {
    throw new Error("Run fork lineage exceeds the bounded trajectory view.");
  }
  const lineages = rows.map((row) => parseRunForkLineageV1(row.lineage_json));
  const parents = lineages.filter((lineage) => lineage.target.runId === runId);
  if (parents.length > 1) throw new Error("Run has ambiguous fork parent lineage.");
  return Object.freeze({
    parent: parents[0],
    children: Object.freeze(
      lineages.filter((lineage) => lineage.source.runId === runId),
    ),
  });
}

function lineageInsertParams(lineage: RunForkLineageV1): unknown[] {
  return [
    lineage.schemaVersion,
    lineage.forkId,
    lineage.tenantId,
    lineage.initiatingActorId,
    lineage.source.runId,
    lineage.source.checkpointId,
    lineage.source.checkpointSha256,
    lineage.source.checkpointSequence,
    lineage.target.runId,
    lineage.target.executionScopeSha256,
    lineage.target.contextGrantIdsSha256,
    lineage.target.capabilityGrantIdsSha256,
    lineage.correction.length,
    lineage.correction.sha256,
    lineage.idempotencyKeySha256,
    lineage.source.eventPrefixCount,
    lineage.source.eventPrefixLastSeq,
    lineage.source.eventPrefixSha256,
    lineage,
    lineage.createdAt,
  ];
}

function runForkEventPayload(lineage: RunForkLineageV1) {
  return {
    schemaVersion: lineage.schemaVersion,
    forkId: lineage.forkId,
    sourceRunId: lineage.source.runId,
    sourceCheckpointId: lineage.source.checkpointId,
    sourceCheckpointSha256: lineage.source.checkpointSha256,
    sourceCheckpointSequence: lineage.source.checkpointSequence,
    sourceEventPrefixCount: lineage.source.eventPrefixCount,
    sourceEventPrefixLastSeq: lineage.source.eventPrefixLastSeq,
    sourceEventPrefixSha256: lineage.source.eventPrefixSha256,
    forkRunId: lineage.target.runId,
    executionScopeSha256: lineage.target.executionScopeSha256,
    contextGrantIdsSha256: lineage.target.contextGrantIdsSha256,
    capabilityGrantIdsSha256: lineage.target.capabilityGrantIdsSha256,
    correctionLength: lineage.correction.length,
    correctionSha256: lineage.correction.sha256,
    approvalInheritance: lineage.target.approvalInheritance,
    continuationInheritance: lineage.target.continuationInheritance,
  };
}

function assertIdempotentRunFork(
  existing: RunForkLineageV1,
  requested: RunForkLineageV1,
) {
  const existingComparable = { ...existing, createdAt: requested.createdAt };
  if (JSON.stringify(existingComparable) !== JSON.stringify(requested)) {
    throw new Error(
      "Checkpoint fork idempotency key is already bound to another correction or execution scope.",
    );
  }
}

function replayEventFromRow(row: SqlRow) {
  return {
    id: String(row.id || ""),
    seq: Number(row.seq),
    type: String(row.type || ""),
    payload: row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
      ? row.payload as Record<string, unknown>
      : {},
    at: new Date(String(row.at)).toISOString(),
  };
}

function messagesFromRow(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const candidate = item as Record<string, unknown>;
    if (
      (candidate.role !== "user" && candidate.role !== "assistant") ||
      typeof candidate.content !== "string"
    ) return [];
    return [{ role: candidate.role, content: candidate.content }];
  });
}

function agentModeFromRow(value: unknown): AgentMode {
  const mode = String(value || "orchestrate");
  if (["orchestrate", "research", "execute", "learn"].includes(mode)) {
    return mode as AgentMode;
  }
  throw new Error("Source run mode is invalid.");
}

function exactlyOne(rows: SqlRow[], label: string): SqlRow {
  if (rows.length !== 1) throw new Error(`Expected exactly one ${label}.`);
  return rows[0];
}

function required(value: string, label: string) {
  const text = value.trim();
  if (!text || text.length > 240) throw new Error(`Checkpoint fork ${label} is invalid.`);
  return text;
}

export function runForkRequestCorrelationId(idempotencyKey: string) {
  return `run-fork:${createHash("sha256")
    .update(idempotencyKey.trim())
    .digest("hex")}`;
}
