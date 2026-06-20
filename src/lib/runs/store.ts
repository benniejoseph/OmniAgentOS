import { randomUUID } from "node:crypto";
import { getDatabaseTenantContext, hasDatabaseUrl, ensureDatabaseSchema, getSql } from "@/lib/db/client";
import { appendDomainEventSafely } from "@/lib/events/store";
import type { AgentEvent, AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { AgentRunContinuation, AgentRunEventRecord, AgentRunRecord, RunLedger, RunStatus } from "@/lib/runs/types";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

export async function createAgentRun(input: {
  tenantId?: string;
  mode: AgentMode;
  prompt: string;
  messages: ChatMessage[];
  model?: string;
}) {
  const now = new Date().toISOString();
  const run: AgentRunRecord = {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
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
        id, tenant_id, mode, status, prompt, messages, model, memory_context_count, started_at
      )
      VALUES (
        ${run.id}, ${run.tenantId}, ${run.mode}, ${run.status}, ${run.prompt}, ${JSON.stringify(run.messages)}::jsonb,
        ${run.model || null}, ${run.memoryContextCount}, ${run.startedAt}
      )
    `;
    return run;
  }

  await updateRunLedger((ledger) => {
    ledger.runs.unshift(run);
    return ledger;
  });
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

  // Stage-1 event-log dual-write (docs/vision/EVENT_LOG.md). Text deltas are
  // skipped: they are streaming transport, not decisions worth replaying.
  if (event.type !== "delta") {
    await appendDomainEventSafely({
      streamId: `run:${runId}`,
      type: `run.${event.type}`,
      payload: event as unknown as Record<string, unknown>,
      correlationId: runId,
    });
  }

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = await resolveAgentRunTenantId(runId);
    record.tenantId = tenantId;
    await getSql()`
      INSERT INTO omni_agent_events (id, tenant_id, run_id, type, payload, created_at)
      VALUES (${record.id}, ${tenantId}, ${record.runId}, ${record.type}, ${JSON.stringify(record.payload)}::jsonb, ${record.createdAt})
    `;
    return record;
  }

  await updateRunLedger((ledger) => {
    record.tenantId = normalizeTenantId(ledger.runs.find((run) => run.id === runId)?.tenantId);
    ledger.events.push(record);
    return ledger;
  });
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

/** Mark agent runs stuck in 'running' for longer than staleAfterMs as failed. */
export async function repairStuckAgentRuns(staleAfterMs = 5 * 60 * 1000) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    // Use epoch arithmetic to avoid named-parameter / type issues with intervals.
    const staleBeforeEpoch = new Date(Date.now() - staleAfterMs).toISOString();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status = 'failed',
          error  = 'Run timed out (function invocation limit exceeded).',
          completed_at = NOW(),
          updated_at   = NOW()
      WHERE status = 'running'
        AND started_at <= ${staleBeforeEpoch}::timestamptz
      RETURNING id
    `;
    return rows.length;
  }
  return 0;
}

export async function markAgentRunWaitingForApproval(
  runId: string,
  values: { response: string; continuation: AgentRunContinuation },
) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_agent_runs
      SET status = 'waiting_approval',
          response = ${values.response || null},
          continuation = ${JSON.stringify(values.continuation)}::jsonb,
          completed_at = NULL
      WHERE id = ${runId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    run.status = "waiting_approval";
    run.response = values.response;
    run.continuation = values.continuation;
    run.completedAt = undefined;
  });
}

/**
 * Conditional transition: only one caller can move a run from
 * waiting_approval to resuming. Returns false if another approval already
 * claimed the run, so concurrent decisions cannot double-resume it.
 */
export async function markAgentRunResuming(runId: string): Promise<boolean> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status = 'resuming',
          completed_at = NULL
      WHERE id = ${runId}
        AND status = 'waiting_approval'
      RETURNING id
    `;
    return Boolean(rows[0]);
  }

  let transitioned = false;
  await updateFileRun(runId, (run) => {
    if (run.status === "waiting_approval") {
      run.status = "resuming";
      run.completedAt = undefined;
      transitioned = true;
    }
  });
  return transitioned;
}

export async function getAgentRun(runId: string, options: { tenantId?: string } = {}) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId ? normalizeTenantId(options.tenantId) : undefined;
    const rows = tenantId
      ? await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
          LIMIT 1
        `
      : await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE id = ${runId}
          LIMIT 1
        `;
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  const ledger = await readRunLedger();
  return ledger.runs.find((run) => run.id === runId && (!options.tenantId || normalizeTenantId(run.tenantId) === normalizeTenantId(options.tenantId)));
}

export async function findAgentRunWaitingForToolApproval(
  executionId: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = options.tenantId ? normalizeTenantId(options.tenantId) : undefined;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = tenantId
      ? await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE tenant_id = ${tenantId}
            AND status IN ('waiting_approval', 'resuming')
            AND continuation->'pendingToolCall'->>'executionId' = ${executionId}
          ORDER BY started_at DESC
          LIMIT 1
        `
      : await getSql()`
          SELECT *
          FROM omni_agent_runs
          WHERE status IN ('waiting_approval', 'resuming')
            AND continuation->'pendingToolCall'->>'executionId' = ${executionId}
          ORDER BY started_at DESC
          LIMIT 1
        `;
    return rows[0] ? runFromRow(rows[0]) : undefined;
  }

  const ledger = await readRunLedger();
  return ledger.runs.find((run) =>
    (run.status === "waiting_approval" || run.status === "resuming") &&
    run.continuation?.pendingToolCall.executionId === executionId &&
    (!tenantId || normalizeTenantId(run.tenantId) === tenantId)
  );
}

export async function listAgentRuns(limit = 20, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows.map(runFromRow);
  }

  const ledger = await readRunLedger();
  return ledger.runs.filter((run) => normalizeTenantId(run.tenantId) === tenantId).slice(0, limit);
}

export async function getRunStats(options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const totals = await getSql()`
      SELECT status, COUNT(*)::int AS count
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
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
        AND tenant_id = ${tenantId}
    `;

    return {
      total,
      byStatus,
      consolidated: {
        runs: Number(consolidatedRows[0]?.runs || 0),
        memories: Number(consolidatedRows[0]?.memories || 0),
      },
      latest: await listAgentRuns(5, { tenantId }),
    };
  }

  const ledger = await readRunLedger();
  const runs = ledger.runs.filter((run) => normalizeTenantId(run.tenantId) === tenantId);
  const byStatus = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});

  return {
    total: runs.length,
    byStatus,
    consolidated: {
      runs: runs.filter((run) => run.consolidatedAt).length,
      memories: runs.reduce((sum, run) => sum + (run.consolidationCount || 0), 0),
    },
    latest: runs.slice(0, 5),
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
          continuation = NULL,
          completed_at = ${completedAt}
      WHERE id = ${runId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    run.status = status;
    run.response = values.response;
    run.error = values.error;
    run.continuation = undefined;
    run.completedAt = completedAt;
  });
}

async function updateFileRun(runId: string, mutate: (run: AgentRunRecord) => void) {
  await updateRunLedger((ledger) => {
    const run = ledger.runs.find((item) => item.id === runId);
    if (run) {
      mutate(run);
    }
    return ledger;
  });
}

async function readRunLedger() {
  return readJsonFile<RunLedger>(getRunsFile(), { runs: [], events: [] });
}

async function updateRunLedger(mutate: (ledger: RunLedger) => RunLedger) {
  return updateJsonFile<RunLedger>(getRunsFile(), { runs: [], events: [] }, (ledger) =>
    trimLedger(mutate(ledger)),
  );
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
    tenantId: String(row.tenant_id || "default"),
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
    continuation: parseContinuation(row.continuation),
    startedAt: normalizeDate(row.started_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    consolidatedAt: row.consolidated_at ? normalizeDate(row.consolidated_at) : undefined,
  };
}

function parseContinuation(value: unknown): AgentRunContinuation | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.instructions !== "string" ||
    !candidate.pendingToolCall ||
    typeof (candidate.pendingToolCall as { executionId?: unknown }).executionId !== "string"
  ) {
    return undefined;
  }

  return {
    conversationItems: Array.isArray(candidate.conversationItems)
      ? (candidate.conversationItems as Array<Record<string, unknown>>)
      : [],
    instructions: candidate.instructions,
    response: typeof candidate.response === "string" ? candidate.response : "",
    toolSteps: Number.isInteger(candidate.toolSteps) ? (candidate.toolSteps as number) : 0,
    outputsBeforeApproval: Array.isArray(candidate.outputsBeforeApproval)
      ? (candidate.outputsBeforeApproval as unknown[]).filter(isFunctionCallOutput)
      : [],
    pendingToolCall: {
      callId: String((candidate.pendingToolCall as { callId?: unknown }).callId || ""),
      toolId: String((candidate.pendingToolCall as { toolId?: unknown }).toolId || ""),
      toolName: String((candidate.pendingToolCall as { toolName?: unknown; toolId?: unknown }).toolName || (candidate.pendingToolCall as { toolId?: unknown }).toolId || ""),
      riskLevel: typeof (candidate.pendingToolCall as { riskLevel?: unknown }).riskLevel === "number" ? (candidate.pendingToolCall as { riskLevel: number }).riskLevel : undefined,
      executionId: (candidate.pendingToolCall as { executionId: string }).executionId,
    },
    context: {
      tenantId: String((candidate.context as { tenantId?: unknown })?.tenantId || "default"),
      actorId: String((candidate.context as { actorId?: unknown })?.actorId || "agent"),
      role: normalizeRole((candidate.context as { role?: unknown })?.role),
    },
    createdAt: typeof candidate.createdAt === "string" ? candidate.createdAt : new Date().toISOString(),
  };
}

function isFunctionCallOutput(value: unknown): value is AgentRunContinuation["outputsBeforeApproval"][number] {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { type?: unknown }).type === "function_call_output" &&
    typeof (value as { call_id?: unknown }).call_id === "string" &&
    typeof (value as { output?: unknown }).output === "string",
  );
}

async function resolveAgentRunTenantId(runId: string) {
  const rows = await getSql()`
    SELECT tenant_id
    FROM omni_agent_runs
    WHERE id = ${runId}
    LIMIT 1
  `;
  return normalizeTenantId(rows[0]?.tenant_id ? String(rows[0].tenant_id) : getDatabaseTenantContext());
}

function getRunsFile() {
  return getDataPath("runs.json");
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function normalizeTenantId(value?: string) {
  return (value || process.env.OMNIAGENT_DEFAULT_TENANT || "default").trim().replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 120) || "default";
}

function normalizeRole(value: unknown): AgentRunContinuation["context"]["role"] {
  return value === "viewer" || value === "operator" || value === "admin" || value === "system"
    ? value
    : "operator";
}
