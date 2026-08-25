import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getDatabaseTenantContext, getSql, hasDatabaseUrl } from "@/lib/db/client";
import type { AgentMode, ChatRole } from "@/lib/orchestration/types";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type { ThreadLedger, ThreadRecord, ThreadTurnRecord } from "@/lib/threads/types";

export async function createThread(input: {
  tenantId?: string;
  actorId: string;
  title: string;
  mode: AgentMode;
}) {
  const now = new Date().toISOString();
  const thread: ThreadRecord = {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
    actorId: safeText(input.actorId, 200),
    title: titleFrom(input.title),
    mode: input.mode,
    createdAt: now,
    updatedAt: now,
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`INSERT INTO omni_threads (id, tenant_id, actor_id, title, mode, created_at, updated_at)
      VALUES (${thread.id}, ${thread.tenantId}, ${thread.actorId}, ${thread.title}, ${thread.mode}, ${now}, ${now})`;
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

export async function listThreads(limit = 30, options: { tenantId?: string; actorId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);
  const actorId = options.actorId ? safeText(options.actorId, 200) : undefined;
  const bounded = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = actorId
      ? await getSql()`SELECT * FROM omni_threads WHERE tenant_id = ${tenantId} AND actor_id = ${actorId} ORDER BY updated_at DESC LIMIT ${bounded}`
      : await getSql()`SELECT * FROM omni_threads WHERE tenant_id = ${tenantId} ORDER BY updated_at DESC LIMIT ${bounded}`;
    return rows.map(threadFromRow);
  }
  const ledger = await readLedger();
  return ledger.threads.filter((thread) => thread.tenantId === tenantId && (!actorId || thread.actorId === actorId)).slice(0, bounded);
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
      const inserted = await sql`INSERT INTO omni_thread_turns (id, tenant_id, thread_id, role, content, run_id, created_at)
        SELECT ${turn.id}, ${tenantId}, ${turn.threadId}, ${turn.role}, ${turn.content}, ${turn.runId || null}, ${createdAt}
        WHERE EXISTS (SELECT 1 FROM omni_threads WHERE id = ${turn.threadId} AND tenant_id = ${tenantId}) RETURNING id`;
      if (inserted[0]) await sql`UPDATE omni_threads SET updated_at = ${createdAt} WHERE id = ${turn.threadId} AND tenant_id = ${tenantId}`;
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
    const rows = await getSql()`SELECT * FROM omni_thread_turns WHERE thread_id = ${threadId} AND tenant_id = ${tenantId} ORDER BY created_at ASC LIMIT ${limit}`;
    return rows.map(turnFromRow);
  }
  const ledger = await readLedger();
  return ledger.turns.filter((turn) => turn.threadId === threadId && turn.tenantId === tenantId).slice(-limit);
}

function readLedger() { return readJsonFile<ThreadLedger>(getDataPath("threads.json"), { threads: [], turns: [] }); }
function updateLedger(mutate: (ledger: ThreadLedger) => ThreadLedger) {
  return updateJsonFile<ThreadLedger>(getDataPath("threads.json"), { threads: [], turns: [] }, (ledger) => {
    const next = mutate(ledger);
    const threads = next.threads.slice(0, 100);
    const ids = new Set(threads.map((thread) => thread.id));
    return { threads, turns: next.turns.filter((turn) => ids.has(turn.threadId)).slice(-4000) };
  });
}
function threadFromRow(row: Record<string, unknown>): ThreadRecord { return { id: String(row.id), tenantId: String(row.tenant_id), actorId: String(row.actor_id), title: String(row.title), mode: String(row.mode) as AgentMode, createdAt: date(row.created_at), updatedAt: date(row.updated_at) }; }
function turnFromRow(row: Record<string, unknown>): ThreadTurnRecord { return { id: String(row.id), tenantId: String(row.tenant_id), threadId: String(row.thread_id), role: String(row.role) as ChatRole, content: safeText(String(row.content), 40_000), runId: row.run_id ? String(row.run_id) : undefined, createdAt: date(row.created_at) }; }
function titleFrom(value: string) { const title = safeText(value, 90).replace(/\s+/g, " ").trim(); return title || "New conversation"; }
function safeText(value: string, max: number) { return String(redactSensitive(value)).trim().slice(0, max); }
function date(value: unknown) { return value instanceof Date ? value.toISOString() : String(value); }
function normalizeTenantId(value?: string) { return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default"; }
