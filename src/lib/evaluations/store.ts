import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type {
  EvalLedger,
  EvalResultRecord,
  EvalRunDetail,
  EvalRunRecord,
  EvalRunStatus,
  EvalRunSummary,
  EvalStats,
} from "@/lib/evaluations/types";

let evalFileWriteQueue: Promise<void> = Promise.resolve();

const emptySummary: EvalRunSummary = {
  total: 0,
  passed: 0,
  failed: 0,
  warnings: 0,
  averageLatencyMs: 0,
  estimatedCostUsd: 0,
};

export async function createEvalRun({
  suite,
  total,
}: {
  suite: string;
  total: number;
}) {
  const now = new Date().toISOString();
  const run: EvalRunRecord = {
    id: randomUUID(),
    suite,
    status: "running",
    summary: {
      ...emptySummary,
      total,
    },
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_eval_runs (
        id, suite, status, total, passed, failed, warnings,
        average_latency_ms, estimated_cost_usd, started_at, created_at, updated_at
      )
      VALUES (
        ${run.id}, ${run.suite}, ${run.status}, ${run.summary.total},
        ${run.summary.passed}, ${run.summary.failed}, ${run.summary.warnings},
        ${run.summary.averageLatencyMs}, ${run.summary.estimatedCostUsd},
        ${run.startedAt}, ${run.createdAt}, ${run.updatedAt}
      )
    `;
    return run;
  }

  await mutateEvalLedger((ledger) => {
    ledger.runs.unshift(run);
    return trimEvalLedger(ledger);
  });
  return run;
}

export async function saveEvalResult(result: Omit<EvalResultRecord, "id" | "createdAt">) {
  const record: EvalResultRecord = {
    ...result,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_eval_results (
        id, eval_run_id, case_id, case_name, case_type, status, score,
        latency_ms, estimated_cost_usd, input, output, error, created_at
      )
      VALUES (
        ${record.id}, ${record.evalRunId}, ${record.caseId}, ${record.caseName},
        ${record.caseType}, ${record.status}, ${record.score}, ${record.latencyMs},
        ${record.estimatedCostUsd}, ${JSON.stringify(record.input || {})}::jsonb,
        ${JSON.stringify(record.output || null)}::jsonb, ${record.error || null},
        ${record.createdAt}
      )
    `;
    return record;
  }

  await mutateEvalLedger((ledger) => {
    ledger.results.push(record);
    return trimEvalLedger(ledger);
  });
  return record;
}

export async function completeEvalRun(
  runId: string,
  summary: EvalRunSummary,
) {
  return updateEvalRun(runId, "completed", summary);
}

export async function failEvalRun(runId: string, summary: EvalRunSummary, error: string) {
  return updateEvalRun(runId, "failed", summary, error);
}

export async function listEvalRuns(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_eval_runs
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return rows.map(evalRunFromRow);
  }

  const ledger = await readEvalLedger();
  return ledger.runs.slice(0, limit);
}

export async function getEvalRunDetail(runId: string): Promise<EvalRunDetail | null> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const runRows = await getSql()`
      SELECT *
      FROM omni_eval_runs
      WHERE id = ${runId}
      LIMIT 1
    `;
    if (!runRows[0]) {
      return null;
    }

    const resultRows = await getSql()`
      SELECT *
      FROM omni_eval_results
      WHERE eval_run_id = ${runId}
      ORDER BY created_at ASC
    `;
    return {
      run: evalRunFromRow(runRows[0]),
      results: resultRows.map(evalResultFromRow),
    };
  }

  const ledger = await readEvalLedger();
  const run = ledger.runs.find((item) => item.id === runId);
  if (!run) {
    return null;
  }

  return {
    run,
    results: ledger.results.filter((result) => result.evalRunId === runId),
  };
}

export async function getEvalStats(): Promise<EvalStats> {
  const runs = await listEvalRuns(100);
  const byStatus = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});
  const latest = runs[0];
  const latestPassRate = latest?.summary.total
    ? latest.summary.passed / latest.summary.total
    : 0;

  return {
    total: runs.length,
    byStatus,
    latest,
    latestPassRate,
    averageLatencyMs: latest?.summary.averageLatencyMs || 0,
    estimatedCostUsd: latest?.summary.estimatedCostUsd || 0,
  };
}

async function updateEvalRun(
  runId: string,
  status: EvalRunStatus,
  summary: EvalRunSummary,
  error?: string,
) {
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_eval_runs
      SET status = ${status},
          total = ${summary.total},
          passed = ${summary.passed},
          failed = ${summary.failed},
          warnings = ${summary.warnings},
          average_latency_ms = ${summary.averageLatencyMs},
          estimated_cost_usd = ${summary.estimatedCostUsd},
          error = ${error || null},
          completed_at = ${now},
          updated_at = ${now}
      WHERE id = ${runId}
    `;
    const detail = await getEvalRunDetail(runId);
    return detail?.run || null;
  }

  await mutateEvalLedger((ledger) => {
    ledger.runs = ledger.runs.map((run) =>
      run.id === runId
        ? {
            ...run,
            status,
            summary,
            error,
            completedAt: now,
            updatedAt: now,
          }
        : run,
    );
    return ledger;
  });
  const detail = await getEvalRunDetail(runId);
  return detail?.run || null;
}

async function readEvalLedger() {
  return readJsonFile<EvalLedger>(getEvalFile(), { runs: [], results: [] });
}

async function mutateEvalLedger(mutator: (ledger: EvalLedger) => EvalLedger) {
  evalFileWriteQueue = evalFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readEvalLedger());
      await writeEvalLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readEvalLedger());
      await writeEvalLedger(ledger);
    },
  );
  await evalFileWriteQueue;
}

async function writeEvalLedger(ledger: EvalLedger) {
  await writeJsonFile(getEvalFile(), trimEvalLedger(ledger));
}

function trimEvalLedger(ledger: EvalLedger): EvalLedger {
  const runIds = new Set(ledger.runs.slice(0, 100).map((run) => run.id));
  return {
    runs: ledger.runs.slice(0, 100),
    results: ledger.results.filter((result) => runIds.has(result.evalRunId)).slice(-1000),
  };
}

function evalRunFromRow(row: Record<string, unknown>): EvalRunRecord {
  return {
    id: String(row.id),
    suite: String(row.suite),
    status: String(row.status) as EvalRunStatus,
    summary: {
      total: Number(row.total || 0),
      passed: Number(row.passed || 0),
      failed: Number(row.failed || 0),
      warnings: Number(row.warnings || 0),
      averageLatencyMs: Number(row.average_latency_ms || 0),
      estimatedCostUsd: Number(row.estimated_cost_usd || 0),
    },
    error: row.error ? String(row.error) : undefined,
    startedAt: normalizeDate(row.started_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function evalResultFromRow(row: Record<string, unknown>): EvalResultRecord {
  return {
    id: String(row.id),
    evalRunId: String(row.eval_run_id),
    caseId: String(row.case_id),
    caseName: String(row.case_name),
    caseType: String(row.case_type) as EvalResultRecord["caseType"],
    status: String(row.status) as EvalResultRecord["status"],
    score: Number(row.score || 0),
    latencyMs: Number(row.latency_ms || 0),
    estimatedCostUsd: Number(row.estimated_cost_usd || 0),
    input: parseObject(row.input) || {},
    output: parseObject(row.output),
    error: row.error ? String(row.error) : undefined,
    createdAt: normalizeDate(row.created_at),
  };
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}

function normalizeDate(value: unknown) {
  return value instanceof Date ? value.toISOString() : String(value);
}

function getEvalFile() {
  return getDataPath("evaluations.json");
}
