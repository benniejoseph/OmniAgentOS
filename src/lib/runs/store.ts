import { randomUUID } from "node:crypto";
import { hasDatabaseUrl, ensureDatabaseSchema, getSql } from "@/lib/db/client";
import type { AgentEvent, AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { AgentRunEventRecord, AgentRunRecord, RunLedger, RunStatus } from "@/lib/runs/types";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";

export async function createAgentRun(input: {
  mode: AgentMode;
  prompt: string;
  messages: ChatMessage[];
  model?: string;
}) {
  const now = new Date().toISOString();
  const run: AgentRunRecord = {
    id: randomUUID(),
    mode: input.mode,
    status: "running",
    prompt: input.prompt,
    messages: input.messages,
    model: input.model,
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: now,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_agent_runs (
        id, mode, status, prompt, messages, model, memory_context_count, started_at
      )
      VALUES (
        ${run.id}, ${run.mode}, ${run.status}, ${run.prompt}, ${JSON.stringify(run.messages)}::jsonb,
        ${run.model || null}, ${run.memoryContextCount}, ${run.startedAt}
      )
    `;
    return run;
  }

  const ledger = await readRunLedger();
  ledger.runs.unshift(run);
  await writeRunLedger(ledger);
  return run;
}

export async function appendRunEvent(runId: string, event: AgentEvent) {
  const record: AgentRunEventRecord = {
    id: randomUUID(),
    runId,
    type: event.type,
    payload: event,
    createdAt: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_agent_events (id, run_id, type, payload, created_at)
      VALUES (${record.id}, ${record.runId}, ${record.type}, ${JSON.stringify(record.payload)}::jsonb, ${record.createdAt})
    `;
    return record;
  }

  const ledger = await readRunLedger();
  ledger.events.push(record);
  await writeRunLedger(trimLedger(ledger));
  return record;
}

export async function updateRunContextCount(runId: string, count: number) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_agent_runs
      SET memory_context_count = ${count}
      WHERE id = ${runId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    run.memoryContextCount = count;
  });
}

export async function recordRunConsolidation(
  runId: string,
  result: { count: number; error?: string },
) {
  const consolidatedAt = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_agent_runs
      SET consolidation_count = ${result.count},
          consolidation_error = ${result.error || null},
          consolidated_at = ${consolidatedAt}
      WHERE id = ${runId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    run.consolidationCount = result.count;
    run.consolidationError = result.error;
    run.consolidatedAt = consolidatedAt;
  });
}

export async function completeAgentRun(runId: string, response: string) {
  await setRunStatus(runId, "completed", { response });
}

export async function failAgentRun(runId: string, error: string) {
  await setRunStatus(runId, "failed", { error });
}

export async function listAgentRuns(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_agent_runs
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.map(runFromRow);
  }

  const ledger = await readRunLedger();
  return ledger.runs.slice(0, limit);
}

export async function getRunStats() {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const totals = await getSql()`
      SELECT status, COUNT(*)::int AS count
      FROM omni_agent_runs
      GROUP BY status
    `;
    const byStatus = totals.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.status)] = Number(row.count);
      return acc;
    }, {});
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    const consolidatedRows = await getSql()`
      SELECT COUNT(*)::int AS runs,
             COALESCE(SUM(consolidation_count), 0)::int AS memories
      FROM omni_agent_runs
      WHERE consolidated_at IS NOT NULL
    `;

    return {
      total,
      byStatus,
      consolidated: {
        runs: Number(consolidatedRows[0]?.runs || 0),
        memories: Number(consolidatedRows[0]?.memories || 0),
      },
      latest: await listAgentRuns(5),
    };
  }

  const ledger = await readRunLedger();
  const byStatus = ledger.runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});

  return {
    total: ledger.runs.length,
    byStatus,
    consolidated: {
      runs: ledger.runs.filter((run) => run.consolidatedAt).length,
      memories: ledger.runs.reduce((sum, run) => sum + (run.consolidationCount || 0), 0),
    },
    latest: ledger.runs.slice(0, 5),
  };
}

async function setRunStatus(
  runId: string,
  status: RunStatus,
  values: { response?: string; error?: string },
) {
  const completedAt = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_agent_runs
      SET status = ${status},
          response = ${values.response || null},
          error = ${values.error || null},
          completed_at = ${completedAt}
      WHERE id = ${runId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    run.status = status;
    run.response = values.response;
    run.error = values.error;
    run.completedAt = completedAt;
  });
}

async function updateFileRun(runId: string, mutate: (run: AgentRunRecord) => void) {
  const ledger = await readRunLedger();
  const run = ledger.runs.find((item) => item.id === runId);
  if (run) {
    mutate(run);
    await writeRunLedger(ledger);
  }
}

async function readRunLedger() {
  return readJsonFile<RunLedger>(getRunsFile(), { runs: [], events: [] });
}

async function writeRunLedger(ledger: RunLedger) {
  await writeJsonFile(getRunsFile(), trimLedger(ledger));
}

function trimLedger(ledger: RunLedger): RunLedger {
  const runIds = new Set(ledger.runs.slice(0, 100).map((run) => run.id));
  return {
    runs: ledger.runs.slice(0, 100),
    events: ledger.events.filter((event) => runIds.has(event.runId)).slice(-1000),
  };
}

function runFromRow(row: Record<string, unknown>): AgentRunRecord {
  return {
    id: String(row.id),
    mode: String(row.mode) as AgentMode,
    status: String(row.status) as RunStatus,
    prompt: String(row.prompt || ""),
    messages: Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [],
    model: row.model ? String(row.model) : undefined,
    memoryContextCount: Number(row.memory_context_count || 0),
    consolidationCount: Number(row.consolidation_count || 0),
    response: row.response ? String(row.response) : undefined,
    error: row.error ? String(row.error) : undefined,
    consolidationError: row.consolidation_error ? String(row.consolidation_error) : undefined,
    startedAt: normalizeDate(row.started_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    consolidatedAt: row.consolidated_at ? normalizeDate(row.consolidated_at) : undefined,
  };
}

function getRunsFile() {
  return getDataPath("runs.json");
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}
