import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getDatabaseTenantContext, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { AgentMode, ChatRole } from "@/lib/orchestration/types";
import type { CanonicalRequestActorBindingV1 } from "@/lib/security/canonical-actor";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import { threadActorReadOrder } from "@/lib/threads/actor-scope";
import {
  buildAggregateConversationSummaries,
  buildThreadConversationSummaries,
  conversationSummaryAccessScopeV1Schema,
  conversationSummaryRecordSchema,
  type ConversationSummaryLevel,
  type ConversationSummaryRecord,
} from "@/lib/threads/summaries";
import type { ThreadLedger, ThreadRecord, ThreadTurnRecord } from "@/lib/threads/types";

export async function createThread(input: {
  tenantId?: string;
  actorId: string;
  projectId?: string;
  title: string;
  mode: AgentMode;
}) {
  const now = new Date().toISOString();
  const thread: ThreadRecord = {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
    actorId: safeText(input.actorId, 200),
    projectId: optionalIdentifier(input.projectId),
    title: titleFrom(input.title),
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`INSERT INTO omni_threads (id, tenant_id, actor_id, project_id, title, mode, created_at, updated_at)
      VALUES (${thread.id}, ${thread.tenantId}, ${thread.actorId}, ${thread.projectId || null}, ${thread.title}, ${thread.mode}, ${now}, ${now})`;
    return thread;
  }
  await updateLedger((ledger) => ({ ...ledger, threads: [thread, ...ledger.threads] }));
  return thread;
}

export async function getThread(id: string, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM omni_threads WHERE id = ${id} AND tenant_id = ${tenantId} LIMIT 1`;
    return rows[0] ? threadFromRow(rows[0]) : null;
  }
  const ledger = await readLedger();
  return ledger.threads.find((thread) => thread.id === id && thread.tenantId === tenantId) || null;
}

export async function getOwnedThread(
  id: string,
  options: {
    tenantId?: string;
    actorId: string;
    requestActorBinding?: CanonicalRequestActorBindingV1;
  },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const actorReadOrder = threadActorReadOrder(
      options.actorId,
      options.requestActorBinding,
      actorId,
    );
    const canonicalActorId = actorReadOrder[0];
    const exactActorId = actorReadOrder[1];
    const rows = await getSql()`
      SELECT * FROM omni_threads
      WHERE id = ${id} AND tenant_id = ${tenantId}
        AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
      LIMIT 1
    `;
    return rows[0]
      ? projectThreadForRequest(threadFromRow(rows[0]), exactActorId)
      : null;
  }
  const ledger = await readLedger();
  const thread = ledger.threads.find((candidate) =>
    candidate.id === id
      && candidate.tenantId === tenantId
      && candidate.actorId === actorId
  );
  return thread ? projectThreadForRequest(thread, actorId) : null;
}

export async function listThreads(
  limit = 30,
  options: {
    tenantId?: string;
    actorId?: string;
    requestActorBinding?: CanonicalRequestActorBindingV1;
  } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const requestActorId = options.actorId;
  const actorId = requestActorId === undefined
    ? undefined
    : safeText(requestActorId, 200);
  const bounded = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    if (requestActorId !== undefined && actorId !== undefined) {
      const actorReadOrder = threadActorReadOrder(
        requestActorId,
        options.requestActorBinding,
        actorId,
      );
      const canonicalActorId = actorReadOrder[0];
      const exactActorId = actorReadOrder[1];
      const rows = await getSql()`
        SELECT * FROM omni_threads
        WHERE tenant_id = ${tenantId}
          AND (actor_id = ${canonicalActorId} OR actor_id = ${exactActorId})
        ORDER BY updated_at DESC, id ASC
        LIMIT ${bounded}
      `;
      return rows.map((row) =>
        projectThreadForRequest(threadFromRow(row), exactActorId),
      );
    }
    const rows = await getSql()`
      SELECT * FROM omni_threads
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC, id ASC
      LIMIT ${bounded}
    `;
    return rows.map(threadFromRow);
  }
  const ledger = await readLedger();
  return ledger.threads
    .filter((thread) =>
      thread.tenantId === tenantId
        && (actorId === undefined || thread.actorId === actorId)
    )
    .slice(0, bounded)
    .map((thread) => actorId !== undefined
      ? projectThreadForRequest(thread, actorId)
      : thread
    );
}

export async function appendThreadTurn(input: {
  tenantId?: string;
  threadId: string;
  role: ChatRole;
  content: string;
  runId?: string;
}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const content = safeText(input.content, 40_000);
  const createdAt = new Date().toISOString();
  const turn: ThreadTurnRecord = { id: randomUUID(), tenantId, threadId: input.threadId, role: input.role, content, runId: input.runId, createdAt };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const parents = await sql`
        SELECT * FROM omni_threads
        WHERE id = ${turn.threadId} AND tenant_id = ${tenantId}
        FOR UPDATE
      `;
      const parent = parents[0] ? threadFromRow(parents[0]) : null;
      if (!parent) return [];
      const inserted = await sql`INSERT INTO omni_thread_turns (id, tenant_id, thread_id, role, content, run_id, created_at)
        SELECT ${turn.id}, ${tenantId}, ${turn.threadId}, ${turn.role}, ${turn.content}, ${turn.runId || null}, ${createdAt}
        WHERE EXISTS (SELECT 1 FROM omni_threads WHERE id = ${turn.threadId} AND tenant_id = ${tenantId}) RETURNING id`;
      if (inserted[0]) await sql`UPDATE omni_threads SET updated_at = ${createdAt} WHERE id = ${turn.threadId} AND tenant_id = ${tenantId}`;
      if (inserted[0]) {
        await rebuildConversationSummaryHierarchySql(sql, {
          ...parent,
          updatedAt: createdAt,
        }, createdAt);
      }
      return inserted;
    }) as Record<string, unknown>[];
    if (!rows[0]) throw new Error("Thread not found.");
    return turn;
  }
  let found = false;
  await updateLedger((ledger) => {
    const thread = ledger.threads.find((candidate) => candidate.id === turn.threadId && candidate.tenantId === tenantId);
    if (!thread) return ledger;
    found = true;
    thread.updatedAt = createdAt;
    ledger.threads.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    ledger.turns.push(turn);
    rebuildConversationSummaryHierarchyFile(ledger, thread, createdAt);
    return ledger;
  });
  if (!found) throw new Error("Thread not found.");
  return turn;
}

export async function listThreadTurns(threadId: string, options: { tenantId?: string; limit?: number } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 40, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`SELECT * FROM (
      SELECT * FROM omni_thread_turns
      WHERE thread_id = ${threadId} AND tenant_id = ${tenantId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    ) AS recent_turns
    ORDER BY created_at ASC`;
    return rows.map(turnFromRow);
  }
  const ledger = await readLedger();
  return ledger.turns.filter((turn) => turn.threadId === threadId && turn.tenantId === tenantId).slice(-limit);
}

export async function listConversationSummaries(
  threadId: string,
  options: {
    tenantId?: string;
    levels?: ConversationSummaryLevel[];
    limit?: number;
  } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const levels = options.levels?.length
    ? [...new Set(options.levels)]
    : ["episode" as const];
  const limit = Math.min(Math.max(options.limit || 100, 1), 500);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT * FROM omni_conversation_summaries
      WHERE tenant_id = ${tenantId}
        AND thread_id = ${threadId}
        AND level = ANY(${levels})
      ORDER BY starts_at ASC, id ASC
      LIMIT ${limit}
    `;
    return rows.map(conversationSummaryFromRow);
  }
  const ledger = await readLedger();
  return (ledger.summaries || [])
    .filter((summary) =>
      summary.tenantId === tenantId &&
      summary.threadId === threadId &&
      levels.includes(summary.level)
    )
    .sort(compareConversationSummaries)
    .slice(0, limit);
}

export async function rebuildConversationSummaryHierarchy(
  threadId: string,
  options: { tenantId?: string; actorId: string },
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = safeText(options.actorId, 200);
  const now = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      const rows = await sql`
        SELECT * FROM omni_threads
        WHERE id = ${threadId} AND tenant_id = ${tenantId}
          AND actor_id = ${actorId}
        FOR UPDATE
      `;
      if (!rows[0]) return [];
      return rebuildConversationSummaryHierarchySql(
        sql,
        threadFromRow(rows[0]),
        now,
      );
    }) as Promise<ConversationSummaryRecord[]>;
  }
  let rebuilt: ConversationSummaryRecord[] = [];
  await updateLedger((ledger) => {
    const thread = ledger.threads.find((candidate) =>
      candidate.id === threadId &&
      candidate.tenantId === tenantId &&
      candidate.actorId === actorId
    );
    if (!thread) return ledger;
    rebuilt = rebuildConversationSummaryHierarchyFile(ledger, thread, now);
    return ledger;
  });
  return rebuilt;
}

function readLedger() { return readJsonFile<ThreadLedger>(getDataPath("threads.json"), { threads: [], turns: [], summaries: [] }); }
function updateLedger(mutate: (ledger: ThreadLedger) => ThreadLedger) {
  return updateJsonFile<ThreadLedger>(getDataPath("threads.json"), { threads: [], turns: [], summaries: [] }, (ledger) => {
    const next = mutate(ledger);
    const threads = next.threads.slice(0, 100);
    const ids = new Set(threads.map((thread) => thread.id));
    const turns = next.turns.filter((turn) => ids.has(turn.threadId)).slice(-4000);
    const turnIds = new Set(turns.map((turn) => turn.id));
    const summaries = (next.summaries || []).filter((summary) =>
      summary.sourceTurnIds.some((id) => turnIds.has(id))
    ).slice(-16_000);
    return { threads, turns, summaries };
  });
}
function threadFromRow(row: Record<string, unknown>): ThreadRecord { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), projectId: row.project_id ? String(row.project_id) : undefined, title: String(row.title), mode: String(row.mode) as AgentMode, createdAt: date(row.created_at), updatedAt: date(row.updated_at) }; }
function projectThreadForRequest(thread: ThreadRecord, requestActorId: string): ThreadRecord { return { ...thread, actorId: requestActorId }; }
function turnFromRow(row: Record<string, unknown>): ThreadTurnRecord { return { id: String(row.id), tenantId: String(row.tenant_id), threadId: String(row.thread_id), role: String(row.role) as ChatRole, content: safeText(String(row.content), 40_000), runId: row.run_id ? String(row.run_id) : undefined, createdAt: date(row.created_at) }; }
function titleFrom(value: string) { const title = safeText(value, 90).replace(/\s+/g, " ").trim(); return title || "New conversation"; }
function safeText(value: string, max: number) { return String(redactSensitive(value)).trim().slice(0, max); }
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function normalizeTenantId(value?: string) { return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
function optionalIdentifier(value?: string) { const normalized = value?.trim().slice(0, 320); return normalized || undefined; }

async function rebuildConversationSummaryHierarchySql(
  sql: ReturnType<typeof getSql>,
  thread: ThreadRecord,
  now: string,
) {
  const turnRows = await sql`
    SELECT * FROM omni_thread_turns
    WHERE tenant_id = ${thread.tenantId} AND thread_id = ${thread.id}
    ORDER BY created_at ASC, id ASC
  `;
  const threadSummaries = buildThreadConversationSummaries({
    thread,
    turns: turnRows.map(turnFromRow),
    now,
  });
  await replaceSummaryPartition(sql, {
    tenantId: thread.tenantId,
    actorId: thread.actorId,
    threadId: thread.id,
    levels: ["turn", "episode"],
    summaries: threadSummaries,
    now,
  });

  const episodeRows = await sql`
    SELECT * FROM omni_conversation_summaries
    WHERE tenant_id = ${thread.tenantId}
      AND owner_actor_id = ${thread.actorId}
      AND level = 'episode'
    ORDER BY starts_at ASC, id ASC
  `;
  const episodes = episodeRows.map(conversationSummaryFromRow);
  const aggregateSummaries: ConversationSummaryRecord[] = [];
  if (thread.projectId) {
    const projectSummaries = buildAggregateConversationSummaries({
      level: "project",
      tenantId: thread.tenantId,
      actorId: thread.actorId,
      projectId: thread.projectId,
      children: episodes,
      now,
    });
    await replaceSummaryPartition(sql, {
      tenantId: thread.tenantId,
      actorId: thread.actorId,
      projectId: thread.projectId,
      levels: ["project"],
      summaries: projectSummaries,
      now,
    });
    aggregateSummaries.push(...projectSummaries);
  }
  const lifetimeSummaries = buildAggregateConversationSummaries({
    level: "lifetime_index",
    tenantId: thread.tenantId,
    actorId: thread.actorId,
    children: episodes,
    now,
  });
  await replaceSummaryPartition(sql, {
    tenantId: thread.tenantId,
    actorId: thread.actorId,
    levels: ["lifetime_index"],
    summaries: lifetimeSummaries,
    now,
  });
  return [...threadSummaries, ...aggregateSummaries, ...lifetimeSummaries];
}

async function replaceSummaryPartition(
  sql: ReturnType<typeof getSql>,
  input: {
    tenantId: string;
    actorId: string;
    threadId?: string;
    projectId?: string;
    levels: ConversationSummaryLevel[];
    summaries: readonly ConversationSummaryRecord[];
    now: string;
  },
) {
  const ids = input.summaries.map((summary) => summary.id);
  if (ids.length) {
    await sql`
      DELETE FROM omni_conversation_summaries
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
        AND level = ANY(${input.levels})
        AND thread_id IS NOT DISTINCT FROM ${input.threadId || null}
        AND project_id IS NOT DISTINCT FROM ${input.projectId || null}
        AND NOT (id = ANY(${ids}))
    `;
  } else {
    await sql`
      DELETE FROM omni_conversation_summaries
      WHERE tenant_id = ${input.tenantId}
        AND owner_actor_id = ${input.actorId}
        AND level = ANY(${input.levels})
        AND thread_id IS NOT DISTINCT FROM ${input.threadId || null}
        AND project_id IS NOT DISTINCT FROM ${input.projectId || null}
    `;
  }
  for (const summary of input.summaries) {
    const changed = await sql`
      INSERT INTO omni_conversation_summaries (
        id, tenant_id, owner_actor_id, level, bucket_index,
        thread_id, project_id, content, source_turn_ids,
        child_summary_ids, source_sha256, summary_sha256,
        access_scope, starts_at, ends_at, rebuildable,
        created_at, updated_at
      ) VALUES (
        ${summary.id}, ${summary.tenantId}, ${summary.actorId},
        ${summary.level}, ${summary.bucketIndex},
        ${summary.threadId || null}, ${summary.projectId || null},
        ${summary.content}, ${summary.sourceTurnIds},
        ${summary.childSummaryIds}, ${summary.sourceSha256},
        ${summary.summarySha256}, ${summary.accessScope},
        ${summary.startsAt}, ${summary.endsAt}, TRUE,
        ${summary.createdAt}, ${input.now}
      )
      ON CONFLICT (id) DO UPDATE SET
        content = EXCLUDED.content,
        source_turn_ids = EXCLUDED.source_turn_ids,
        child_summary_ids = EXCLUDED.child_summary_ids,
        source_sha256 = EXCLUDED.source_sha256,
        summary_sha256 = EXCLUDED.summary_sha256,
        access_scope = EXCLUDED.access_scope,
        starts_at = EXCLUDED.starts_at,
        ends_at = EXCLUDED.ends_at,
        updated_at = EXCLUDED.updated_at
      WHERE omni_conversation_summaries.source_sha256
          IS DISTINCT FROM EXCLUDED.source_sha256
         OR omni_conversation_summaries.summary_sha256
          IS DISTINCT FROM EXCLUDED.summary_sha256
      RETURNING id
    `;
    if (changed[0]) await appendConversationSummaryEvent(sql, summary, input.now);
  }
}

async function appendConversationSummaryEvent(
  sql: ReturnType<typeof getSql>,
  summary: ConversationSummaryRecord,
  at: string,
) {
  const eventId = [
    "conversation_summary_rebuilt",
    summary.id,
    summary.sourceSha256.slice(0, 16),
    summary.summarySha256.slice(0, 16),
  ].join("_");
  await sql`
    INSERT INTO omni_events (
      id, stream_id, type, tenant_id, actor_id, payload,
      causation_id, correlation_id, at
    ) VALUES (
      ${eventId}, ${`conversation-summary:${summary.id}`},
      'conversation.summary.rebuilt', ${summary.tenantId},
      ${summary.actorId}, ${{
        schemaVersion: 1,
        summaryId: summary.id,
        level: summary.level,
        bucketIndex: summary.bucketIndex,
        sourceTurnCount: summary.sourceTurnIds.length,
        childSummaryCount: summary.childSummaryIds.length,
        sourceSha256: summary.sourceSha256,
        summarySha256: summary.summarySha256,
        accessScopeSha256: summary.accessScope.scopeSha256,
        rebuildable: true,
      }}, ${summary.threadId || summary.projectId || summary.id},
      ${summary.sourceSha256}, ${at}
    )
    ON CONFLICT (id) DO NOTHING
  `;
}

function rebuildConversationSummaryHierarchyFile(
  ledger: ThreadLedger,
  thread: ThreadRecord,
  now: string,
) {
  const threadSummaries = buildThreadConversationSummaries({
    thread,
    turns: ledger.turns.filter((turn) =>
      turn.tenantId === thread.tenantId && turn.threadId === thread.id
    ),
    now,
  });
  const retained = (ledger.summaries || []).filter((summary) =>
    !(summary.tenantId === thread.tenantId &&
      summary.actorId === thread.actorId &&
      summary.threadId === thread.id &&
      (summary.level === "turn" || summary.level === "episode"))
  );
  const episodes = [...retained, ...threadSummaries].filter((summary) =>
    summary.tenantId === thread.tenantId &&
    summary.actorId === thread.actorId &&
    summary.level === "episode"
  );
  let aggregates = retained.filter((summary) =>
    !(summary.tenantId === thread.tenantId &&
      summary.actorId === thread.actorId &&
      summary.level === "lifetime_index") &&
    !(Boolean(thread.projectId) &&
      summary.tenantId === thread.tenantId &&
      summary.actorId === thread.actorId &&
      summary.level === "project" &&
      summary.projectId === thread.projectId)
  );
  const generatedAggregates: ConversationSummaryRecord[] = [];
  if (thread.projectId) {
    generatedAggregates.push(...buildAggregateConversationSummaries({
      level: "project",
      tenantId: thread.tenantId,
      actorId: thread.actorId,
      projectId: thread.projectId,
      children: episodes,
      now,
    }));
  }
  generatedAggregates.push(...buildAggregateConversationSummaries({
    level: "lifetime_index",
    tenantId: thread.tenantId,
    actorId: thread.actorId,
    children: episodes,
    now,
  }));
  aggregates = [...aggregates, ...threadSummaries, ...generatedAggregates]
    .sort(compareConversationSummaries);
  ledger.summaries = aggregates;
  return [...threadSummaries, ...generatedAggregates];
}

function conversationSummaryFromRow(
  row: Record<string, unknown>,
): ConversationSummaryRecord {
  return conversationSummaryRecordSchema.parse({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    actorId: String(row.owner_actor_id),
    level: String(row.level),
    bucketIndex: Number(row.bucket_index),
    ...(row.thread_id ? { threadId: String(row.thread_id) } : {}),
    ...(row.project_id ? { projectId: String(row.project_id) } : {}),
    content: String(row.content),
    sourceTurnIds: Array.isArray(row.source_turn_ids)
      ? row.source_turn_ids.map(String)
      : [],
    childSummaryIds: Array.isArray(row.child_summary_ids)
      ? row.child_summary_ids.map(String)
      : [],
    sourceSha256: String(row.source_sha256),
    summarySha256: String(row.summary_sha256),
    accessScope: conversationSummaryAccessScopeV1Schema.parse(row.access_scope),
    startsAt: date(row.starts_at),
    endsAt: date(row.ends_at),
    rebuildable: Boolean(row.rebuildable),
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
  });
}

function compareConversationSummaries(
  left: ConversationSummaryRecord,
  right: ConversationSummaryRecord,
) {
  return left.startsAt.localeCompare(right.startsAt) || left.id.localeCompare(right.id);
}
