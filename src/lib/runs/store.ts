import { createHash, randomUUID } from "node:crypto";
import { getDatabaseTenantContext, hasDatabaseUrl, ensureDatabaseSchema, getSql } from "@/lib/db/client";
import {
  appendDomainEvent,
  appendDomainEventSafely,
} from "@/lib/events/store";
import {
  enqueueOperationJob,
  getAgentResumeJobDedupeKey,
} from "@/lib/operations/job-queue";
import { redactSensitive } from "@/lib/security/context";
import type { AgentEvent, AgentMode, ChatMessage } from "@/lib/orchestration/types";
import type { GroundingReport } from "@/lib/rag/citations";
import type { AgentRunContinuation, AgentRunEventRecord, AgentRunFeedback, AgentRunRecord, RunLedger, RunStatus } from "@/lib/runs/types";
import { getDataPath } from "@/lib/storage/paths";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";

export async function createAgentRun(input: {
  tenantId?: string;
  threadId?: string;
  mode: AgentMode;
  prompt: string;
  messages: ChatMessage[];
  model?: string;
  agentId?: string;
  specialistIds?: string[];
}) {
  const now = new Date().toISOString();
  const safeMessages = input.messages.map((message) => ({
    ...message,
    content: safeRunText(message.content, 30_000),
  }));
  const run: AgentRunRecord = {
    id: randomUUID(),
    tenantId: normalizeTenantId(input.tenantId),
    threadId: input.threadId,
    mode: input.mode,
    status: "running",
    prompt: safeRunText(input.prompt, 30_000),
    messages: safeMessages,
    model: input.model,
    agentId: input.agentId || "atlas",
    specialistIds: Array.from(
      new Set([input.agentId || "atlas", ...(input.specialistIds || [])]),
    ).slice(0, 5),
    memoryContextCount: 0,
    consolidationCount: 0,
    startedAt: now,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_agent_runs (
        id, tenant_id, thread_id, mode, status, prompt, messages, model, agent_id, specialist_ids, memory_context_count, started_at
      )
      VALUES (
        ${run.id}, ${run.tenantId}, ${run.threadId || null}, ${run.mode}, ${run.status}, ${run.prompt}, ${run.messages}::jsonb,
        ${run.model || null}, ${run.agentId}, ${run.specialistIds}, ${run.memoryContextCount}, ${run.startedAt}
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

export async function appendRunEvent(
  runId: string,
  event: AgentEvent,
  options: { tenantId?: string } = {},
) {
  const redactedEvent = redactSensitive(event) as AgentEvent;
  const record: AgentRunEventRecord = {
    id: randomUUID(),
    runId,
    type: event.type,
    payload: redactedEvent,
    createdAt: new Date().toISOString(),
  };

  // Text deltas are streaming transport rather than replayable decisions. The
  // completed response remains on the run, so persisting every token would
  // duplicate sensitive model output and inflate storage.
  if (event.type === "delta") {
    return record;
  }
  const domainEvent = {
    streamId: `run:${runId}`,
    type: `run.${event.type}`,
    payload: domainEventPayload(redactedEvent),
    correlationId: runId,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId
      ? normalizeTenantId(options.tenantId)
      : getDatabaseTenantContext() ||
        (await resolveAgentRunTenantId(runId));
    record.tenantId = tenantId;
    await getSql().transaction(async (sql: ReturnType<typeof getSql>) => {
      await appendDomainEvent(
        { ...domainEvent, tenantId },
        { sql },
      );
      await sql`
        INSERT INTO omni_agent_events (id, tenant_id, run_id, type, payload, created_at)
        VALUES (${record.id}, ${tenantId}, ${record.runId}, ${record.type}, ${record.payload}::jsonb, ${record.createdAt})
      `;
    });
    return record;
  }

  await appendDomainEventSafely({
    ...domainEvent,
    tenantId: options.tenantId,
  });
  await updateRunLedger((ledger) => {
    const runTenantId = normalizeTenantId(
      ledger.runs.find((run) => run.id === runId)?.tenantId,
    );
    if (
      options.tenantId &&
      runTenantId !== normalizeTenantId(options.tenantId)
    ) {
      throw new Error("Agent run event tenant does not match the run.");
    }
    record.tenantId = runTenantId;
    ledger.events.push(record);
    return ledger;
  });
  return record;
}

function domainEventPayload(event: AgentEvent): Record<string, unknown> {
  if (event.type !== "done") {
    return event as unknown as Record<string, unknown>;
  }
  return {
    type: event.type,
    responseLength: event.response.length,
    responseSha256: createHash("sha256").update(event.response).digest("hex"),
    grounding: event.grounding,
  };
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
  options: { tenantId?: string } = {},
) {
  const consolidatedAt = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId
      ? normalizeTenantId(options.tenantId)
      : await resolveAgentRunTenantId(runId);
    await getSql()`
      UPDATE omni_agent_runs
      SET consolidation_count = ${result.count},
          consolidation_error = ${result.error ? safeRunText(result.error, 2_000) : null},
          consolidated_at = ${consolidatedAt}
      WHERE id = ${runId}
        AND tenant_id = ${tenantId}
    `;
    return;
  }

  await updateFileRun(runId, (run) => {
    if (
      options.tenantId &&
      normalizeTenantId(run.tenantId) !== normalizeTenantId(options.tenantId)
    ) {
      throw new Error("Agent run consolidation tenant does not match the run.");
    }
    run.consolidationCount = result.count;
    run.consolidationError = result.error
      ? safeRunText(result.error, 2_000)
      : undefined;
    run.consolidatedAt = consolidatedAt;
  });
}

export async function recordAgentRunFeedback(
  runId: string,
  input: { verdict: AgentRunFeedback["verdict"]; correction?: string },
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const feedback: AgentRunFeedback = {
    verdict: input.verdict,
    correction: input.correction
      ? safeRunText(input.correction.trim(), 2_000)
      : undefined,
    updatedAt: new Date().toISOString(),
  };

  let updated: AgentRunRecord | undefined;
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET feedback = ${feedback}::jsonb
      WHERE id = ${runId}
        AND tenant_id = ${tenantId}
        AND status = 'completed'
      RETURNING *
    `;
    updated = rows[0] ? runFromRow(rows[0]) : undefined;
  } else {
    await updateFileRun(runId, (run) => {
      if (
        normalizeTenantId(run.tenantId) === tenantId &&
        run.status === "completed"
      ) {
        run.feedback = feedback;
        updated = run;
      }
    });
  }

  if (updated) {
    await appendDomainEventSafely({
      tenantId,
      streamId: `run:${runId}`,
      type: "run.feedback",
      payload: {
        verdict: feedback.verdict,
        hasCorrection: Boolean(feedback.correction),
      },
      correlationId: runId,
    });
  }
  return updated ? sanitizeAgentRunRecord(updated) : undefined;
}

export async function getAgentFeedbackGuidance(
  agentId: string,
  options: { tenantId?: string; limit?: number } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const limit = Math.min(Math.max(options.limit || 3, 1), 5);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT feedback
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
        AND agent_id = ${agentId}
        AND feedback->>'verdict' = 'needs_work'
        AND COALESCE(feedback->>'correction', '') <> ''
      ORDER BY started_at DESC
      LIMIT ${limit}
    `;
    return rows
      .map((row) => parseAgentRunFeedback(row.feedback)?.correction)
      .filter((value): value is string => Boolean(value));
  }

  const ledger = await readRunLedger();
  return ledger.runs
    .filter((run) =>
      normalizeTenantId(run.tenantId) === tenantId &&
      (run.agentId || "atlas") === agentId &&
      run.feedback?.verdict === "needs_work" &&
      Boolean(run.feedback.correction)
    )
    .slice(0, limit)
    .map((run) => run.feedback?.correction)
    .filter((value): value is string => Boolean(value));
}

export async function completeAgentRun(runId: string, response: string, grounding?: GroundingReport) {
  return setRunStatus(runId, "completed", { response, grounding });
}

export async function failAgentRun(runId: string, error: string) {
  return setRunStatus(runId, "failed", { error });
}

export async function cancelAgentRun(runId: string, reason = "Canceled by the operator.") {
  return setRunStatus(runId, "canceled", { error: reason });
}

/** Fail stale initial runs and interrupted resume claims without replaying work. */
export async function repairStuckAgentRuns({
  staleAfterMs = 7 * 60 * 1000,
  tenantId: requestedTenantId,
}: {
  staleAfterMs?: number;
  tenantId?: string;
} = {}) {
  const tenantId = normalizeTenantId(requestedTenantId);
  const staleBeforeEpoch = new Date(Date.now() - staleAfterMs).toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    // Use epoch arithmetic to avoid named-parameter / type issues with intervals.
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status       = 'failed',
          error        = CASE
            WHEN status = 'resuming'
              THEN 'Approved run resume was interrupted; side effects were not replayed.'
            ELSE 'Run timed out (function invocation limit exceeded).'
          END,
          continuation = NULL,
          completed_at = NOW()
      WHERE tenant_id = ${tenantId}
        AND (
          (status = 'running' AND started_at <= ${staleBeforeEpoch}::timestamptz)
          OR (
            status = 'resuming'
            AND COALESCE(
              (continuation->>'resumeClaimedAt')::timestamptz,
              started_at
            ) <= ${staleBeforeEpoch}::timestamptz
          )
        )
      RETURNING id
    `;
    return rows.length;
  }
  let repaired = 0;
  await updateRunLedger((ledger) => {
    const staleBefore = Date.parse(staleBeforeEpoch);
    for (const run of ledger.runs) {
      if (normalizeTenantId(run.tenantId) !== tenantId) {
        continue;
      }
      const staleRunning =
        run.status === "running" &&
        Date.parse(run.startedAt) <= staleBefore;
      const resumeClaimedAt =
        run.continuation?.resumeClaimedAt || run.startedAt;
      const staleResuming =
        run.status === "resuming" &&
        Date.parse(resumeClaimedAt) <= staleBefore;
      if (!staleRunning && !staleResuming) {
        continue;
      }
      repaired += 1;
      run.status = "failed";
      run.error = staleResuming
        ? "Approved run resume was interrupted; side effects were not replayed."
        : "Run timed out (function invocation limit exceeded).";
      run.continuation = undefined;
      run.completedAt = new Date().toISOString();
    }
    return ledger;
  });
  return repaired;
}

export async function markAgentRunWaitingForApproval(
  runId: string,
  values: { response: string; continuation: AgentRunContinuation },
) {
  const tenantId = normalizeTenantId(values.continuation.context.tenantId);
  const executionId = values.continuation.pendingToolCall.executionId;
  const resumeJobInput = {
    tenantId,
    type: "agent.resume" as const,
    dedupeKey: getAgentResumeJobDedupeKey(executionId),
    payload: { agentRunId: runId, executionId },
    priority: 20,
    maxAttempts: 10,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql`
          UPDATE omni_agent_runs
          SET status = 'waiting_approval',
              response = ${values.response ? safeRunText(values.response, 100_000) : null},
              continuation = ${values.continuation}::jsonb,
              completed_at = NULL
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
            AND status IN ('running', 'resuming')
          RETURNING id
        `;
        if (!rows[0]) {
          return { parked: false, resumeJob: undefined };
        }
        const resumeJob = await enqueueOperationJob(resumeJobInput, { sql });
        return { parked: true, resumeJob };
      },
    ) as Promise<{
      parked: boolean;
      resumeJob:
        | Awaited<ReturnType<typeof enqueueOperationJob>>
        | undefined;
    }>;
  }

  // File mode has no cross-file transaction. Pre-arm the durable job first;
  // the resume worker defers it while the continuation write is incomplete.
  const resumeJob = await enqueueOperationJob(resumeJobInput);
  let parked = false;
  await updateFileRun(runId, (run) => {
    if (
      normalizeTenantId(run.tenantId) !== tenantId ||
      !["running", "resuming"].includes(run.status)
    ) {
      return;
    }
    run.status = "waiting_approval";
    run.response = safeRunText(values.response, 100_000);
    run.continuation = values.continuation;
    run.completedAt = undefined;
    parked = true;
  });
  return { parked, resumeJob };
}

/**
 * Conditional transition: only one caller can move a run from
 * waiting_approval to resuming. Returns false if another approval already
 * claimed the run, so concurrent decisions cannot double-resume it.
 */
export async function markAgentRunResuming(runId: string): Promise<boolean> {
  const claimedAt = new Date().toISOString();
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status = 'resuming',
          continuation = jsonb_set(
            continuation,
            '{resumeClaimedAt}',
            to_jsonb(${claimedAt}::text),
            true
          ),
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
      if (run.continuation) {
        run.continuation = {
          ...run.continuation,
          resumeClaimedAt: claimedAt,
        };
      }
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

export async function listAgentRunSummaries(
  limit = 20,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 50);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        id, tenant_id, mode, status, prompt, response, grounding, feedback, error, continuation, agent_id, specialist_ids,
        started_at, completed_at
      FROM omni_agent_runs
      WHERE tenant_id = ${tenantId}
      ORDER BY started_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(runFromRow);
  }

  const ledger = await readRunLedger();
  return ledger.runs
    .filter((run) => normalizeTenantId(run.tenantId) === tenantId)
    .slice(0, boundedLimit);
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
  values: { response?: string; error?: string; grounding?: GroundingReport },
) {
  const completedAt = new Date().toISOString();
  const safeResponse = values.response
    ? safeRunText(values.response, 100_000)
    : undefined;
  const safeError = values.error ? safeRunText(values.error, 2_000) : undefined;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_agent_runs
      SET status = ${status},
          response = ${safeResponse || null},
          grounding = ${values.grounding || null}::jsonb,
          error = ${safeError || null},
          continuation = NULL,
          completed_at = ${completedAt}
      WHERE id = ${runId}
        AND status NOT IN ('completed', 'failed', 'canceled')
      RETURNING id
    `;
    return Boolean(rows[0]);
  }

  let changed = false;
  await updateFileRun(runId, (run) => {
    if (["completed", "failed", "canceled"].includes(run.status)) {
      return;
    }
    changed = true;
    run.status = status;
    run.response = safeResponse;
    run.grounding = values.grounding;
    run.error = safeError;
    run.continuation = undefined;
    run.completedAt = completedAt;
  });
  return changed;
}

function safeRunText(value: string, maxChars: number) {
  return String(redactSensitive(value)).slice(0, maxChars);
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
  const ledger = await readJsonFile<RunLedger>(
    getRunsFile(),
    { runs: [], events: [] },
  );
  return {
    runs: ledger.runs.map(sanitizeAgentRunRecord),
    events: redactSensitive(ledger.events) as RunLedger["events"],
  };
}

async function updateRunLedger(mutate: (ledger: RunLedger) => RunLedger) {
  return updateJsonFile<RunLedger>(getRunsFile(), { runs: [], events: [] }, (ledger) =>
    trimLedger(mutate(ledger)),
  );
}

function trimLedger(ledger: RunLedger): RunLedger {
  const nonterminal = ledger.runs.filter((run) =>
    ["running", "waiting_approval", "resuming"].includes(run.status),
  );
  const terminal = ledger.runs.filter(
    (run) => !["running", "waiting_approval", "resuming"].includes(run.status),
  );
  const runs = [
    ...nonterminal,
    ...terminal.slice(0, Math.max(0, 100 - nonterminal.length)),
  ];
  const runIds = new Set(runs.map((run) => run.id));
  return {
    runs,
    events: ledger.events.filter((event) => runIds.has(event.runId)).slice(-1000),
  };
}

function runFromRow(row: Record<string, unknown>): AgentRunRecord {
  return sanitizeAgentRunRecord({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    threadId: row.thread_id ? String(row.thread_id) : undefined,
    mode: String(row.mode) as AgentMode,
    status: String(row.status) as RunStatus,
    prompt: String(row.prompt || ""),
    messages: Array.isArray(row.messages) ? (row.messages as ChatMessage[]) : [],
    model: row.model ? String(row.model) : undefined,
    agentId: row.agent_id ? String(row.agent_id) : "atlas",
    specialistIds: Array.isArray(row.specialist_ids) ? row.specialist_ids.map(String) : [],
    feedback: parseAgentRunFeedback(row.feedback),
    memoryContextCount: Number(row.memory_context_count || 0),
    consolidationCount: Number(row.consolidation_count || 0),
    response: row.response ? String(row.response) : undefined,
    grounding: parseGroundingReport(row.grounding),
    error: row.error ? String(row.error) : undefined,
    consolidationError: row.consolidation_error ? String(row.consolidation_error) : undefined,
    continuation: parseContinuation(row.continuation),
    startedAt: normalizeDate(row.started_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    consolidatedAt: row.consolidated_at ? normalizeDate(row.consolidated_at) : undefined,
  });
}

function sanitizeAgentRunRecord(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    prompt: String(redactSensitive(run.prompt)).slice(0, 20_000),
    messages: redactSensitive(run.messages) as ChatMessage[],
    response: run.response
      ? String(redactSensitive(run.response))
      : undefined,
    grounding: run.grounding
      ? (redactSensitive(run.grounding) as GroundingReport)
      : undefined,
    error: run.error
      ? String(redactSensitive(run.error)).slice(0, 2_000)
      : undefined,
    consolidationError: run.consolidationError
      ? String(redactSensitive(run.consolidationError)).slice(0, 2_000)
      : undefined,
    continuation: run.continuation
      ? (redactSensitive(run.continuation) as AgentRunContinuation)
      : undefined,
  };
}

function parseGroundingReport(value: unknown): GroundingReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<GroundingReport>;
  if (!candidate.status || !["verified", "not_required", "missing", "invalid"].includes(candidate.status)) {
    return undefined;
  }
  return {
    status: candidate.status,
    citedIds: Array.isArray(candidate.citedIds) ? candidate.citedIds.map(String) : [],
    invalidIds: Array.isArray(candidate.invalidIds) ? candidate.invalidIds.map(String) : [],
    sources: Array.isArray(candidate.sources) ? candidate.sources : [],
  };
}

function parseAgentRunFeedback(value: unknown): AgentRunFeedback | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Partial<AgentRunFeedback>;
  if (candidate.verdict !== "useful" && candidate.verdict !== "needs_work") return undefined;
  return {
    verdict: candidate.verdict,
    correction: candidate.correction ? safeRunText(String(candidate.correction), 2_000) : undefined,
    updatedAt: candidate.updatedAt ? String(candidate.updatedAt) : new Date(0).toISOString(),
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
    resumeClaimedAt:
      typeof candidate.resumeClaimedAt === "string"
        ? candidate.resumeClaimedAt
        : undefined,
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
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function normalizeRole(value: unknown): AgentRunContinuation["context"]["role"] {
  return value === "viewer" || value === "operator" || value === "admin" || value === "system"
    ? value
    : "operator";
}
