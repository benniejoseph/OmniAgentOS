import { randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";
import type {
  WorkflowEventRecord,
  WorkflowLedger,
  WorkflowRecoveryEventRecord,
  WorkflowRunDetail,
  WorkflowRunInput,
  WorkflowRunRecord,
  WorkflowRunStatus,
  WorkflowStats,
  WorkflowStepKey,
  WorkflowStepRecord,
  WorkflowStepStatus,
} from "@/lib/workflows/types";

export const AGENT_WORKFLOW_TYPE = "agent.workflow.v1";

export const workflowStepDefinitions: Array<{ key: WorkflowStepKey; label: string }> = [
  { key: "preflight", label: "Preflight" },
  { key: "retrieve_context", label: "Retrieve context" },
  { key: "plan", label: "Plan" },
  { key: "approval_gate", label: "Approval gate" },
  { key: "execute", label: "Execute" },
  { key: "verify", label: "Verify" },
  { key: "persist_report", label: "Persist report" },
];

let workflowFileWriteQueue: Promise<void> = Promise.resolve();

export async function createWorkflowRun(input: WorkflowRunInput) {
  const now = new Date().toISOString();
  const run: WorkflowRunRecord = {
    id: randomUUID(),
    workflowType: AGENT_WORKFLOW_TYPE,
    status: "queued",
    goal: input.goal.trim(),
    input,
    currentStep: "preflight",
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    approvalRequired: input.requireApproval ?? true,
    createdAt: now,
    updatedAt: now,
  };
  const steps = workflowStepDefinitions.map<WorkflowStepRecord>((definition) => ({
    id: randomUUID(),
    workflowRunId: run.id,
    stepKey: definition.key,
    label: definition.label,
    status: "pending",
    attempt: 0,
    maxAttempts: run.maxAttempts,
    input: {},
    createdAt: now,
    updatedAt: now,
  }));

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_workflow_runs (
        id, workflow_type, status, goal, input, current_step, attempt,
        max_attempts, approval_required, created_at, updated_at
      )
      VALUES (
        ${run.id}, ${run.workflowType}, ${run.status}, ${run.goal},
        ${JSON.stringify(run.input)}::jsonb, ${run.currentStep || null}, ${run.attempt},
        ${run.maxAttempts}, ${run.approvalRequired}, ${run.createdAt}, ${run.updatedAt}
      )
    `;
    for (const step of steps) {
      await saveWorkflowStep(step);
    }
    await appendWorkflowEvent(run.id, "workflow.created", { goal: run.goal });
    return getWorkflowRunDetail(run.id) as Promise<WorkflowRunDetail>;
  }

  await mutateWorkflowLedger((ledger) => {
    ledger.runs.unshift(run);
    ledger.steps.push(...steps);
    ledger.events.push(createWorkflowEventRecord(run.id, "workflow.created", { goal: run.goal }));
    return trimWorkflowLedger(ledger);
  });

  return getWorkflowRunDetail(run.id) as Promise<WorkflowRunDetail>;
}

export async function listWorkflowRuns(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_runs
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(workflowRunFromRow);
  }

  const ledger = await readWorkflowLedger();
  return ledger.runs.slice(0, limit);
}

export async function getWorkflowRunDetail(runId: string): Promise<WorkflowRunDetail | null> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const runRows = await getSql()`
      SELECT *
      FROM omni_workflow_runs
      WHERE id = ${runId}
      LIMIT 1
    `;
    if (!runRows[0]) {
      return null;
    }

    const [stepRows, eventRows] = await Promise.all([
      getSql()`
        SELECT *
        FROM omni_workflow_steps
        WHERE workflow_run_id = ${runId}
        ORDER BY created_at ASC
      `,
      getSql()`
        SELECT *
        FROM omni_workflow_events
        WHERE workflow_run_id = ${runId}
        ORDER BY created_at ASC
      `,
    ]);

    return {
      run: workflowRunFromRow(runRows[0]),
      steps: stepRows.map(workflowStepFromRow),
      events: eventRows.map(workflowEventFromRow),
    };
  }

  const ledger = await readWorkflowLedger();
  const run = ledger.runs.find((item) => item.id === runId);
  if (!run) {
    return null;
  }

  return {
    run,
    steps: ledger.steps.filter((step) => step.workflowRunId === runId),
    events: ledger.events.filter((event) => event.workflowRunId === runId),
  };
}

export async function getWorkflowStep(runId: string, stepKey: WorkflowStepKey) {
  const detail = await getWorkflowRunDetail(runId);
  return detail?.steps.find((step) => step.stepKey === stepKey) || null;
}

export async function updateWorkflowRun(
  runId: string,
  patch: Partial<Omit<WorkflowRunRecord, "id" | "createdAt">>,
) {
  const existing = await getWorkflowRunDetail(runId);
  if (!existing) {
    return null;
  }

  const now = new Date().toISOString();
  const nextRun: WorkflowRunRecord = {
    ...existing.run,
    ...patch,
    updatedAt: now,
  };

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_workflow_runs
      SET workflow_type = ${nextRun.workflowType},
          status = ${nextRun.status},
          goal = ${nextRun.goal},
          input = ${JSON.stringify(nextRun.input || {})}::jsonb,
          current_step = ${nextRun.currentStep || null},
          attempt = ${nextRun.attempt},
          max_attempts = ${nextRun.maxAttempts},
          approval_required = ${nextRun.approvalRequired},
          approved_at = ${nextRun.approvedAt || null},
          paused_at = ${nextRun.pausedAt || null},
          canceled_at = ${nextRun.canceledAt || null},
          error = ${nextRun.error || null},
          result = ${JSON.stringify(nextRun.result || null)}::jsonb,
          updated_at = ${nextRun.updatedAt},
          completed_at = ${nextRun.completedAt || null}
      WHERE id = ${runId}
    `;
    return nextRun;
  }

  await mutateWorkflowLedger((ledger) => {
    ledger.runs = ledger.runs.map((run) => (run.id === runId ? nextRun : run));
    return ledger;
  });
  return nextRun;
}

export async function setWorkflowRunStatus(
  runId: string,
  status: WorkflowRunStatus,
  patch: Partial<WorkflowRunRecord> = {},
) {
  const completedAt =
    status === "completed" || status === "failed" || status === "canceled"
      ? new Date().toISOString()
      : patch.completedAt;
  return updateWorkflowRun(runId, { ...patch, status, completedAt });
}

export async function saveWorkflowStep(step: WorkflowStepRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_workflow_steps (
        id, workflow_run_id, step_key, label, status, attempt, max_attempts,
        input, output, error, started_at, completed_at, created_at, updated_at
      )
      VALUES (
        ${step.id}, ${step.workflowRunId}, ${step.stepKey}, ${step.label},
        ${step.status}, ${step.attempt}, ${step.maxAttempts},
        ${JSON.stringify(step.input || {})}::jsonb,
        ${JSON.stringify(step.output || null)}::jsonb, ${step.error || null},
        ${step.startedAt || null}, ${step.completedAt || null},
        ${step.createdAt}, ${step.updatedAt}
      )
      ON CONFLICT (workflow_run_id, step_key) DO UPDATE SET
        label = EXCLUDED.label,
        status = EXCLUDED.status,
        attempt = EXCLUDED.attempt,
        max_attempts = EXCLUDED.max_attempts,
        input = EXCLUDED.input,
        output = EXCLUDED.output,
        error = EXCLUDED.error,
        started_at = EXCLUDED.started_at,
        completed_at = EXCLUDED.completed_at,
        updated_at = EXCLUDED.updated_at
    `;
    return step;
  }

  await mutateWorkflowLedger((ledger) => {
    const existingIndex = ledger.steps.findIndex((item) => item.id === step.id);
    if (existingIndex >= 0) {
      ledger.steps[existingIndex] = step;
    } else {
      ledger.steps.push(step);
    }
    return ledger;
  });
  return step;
}

export async function updateWorkflowStep(
  runId: string,
  stepKey: WorkflowStepKey,
  patch: Partial<Omit<WorkflowStepRecord, "id" | "workflowRunId" | "stepKey" | "createdAt">>,
) {
  const existing = await getWorkflowStep(runId, stepKey);
  if (!existing) {
    return null;
  }

  const nextStep: WorkflowStepRecord = {
    ...existing,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  return saveWorkflowStep(nextStep);
}

export async function appendWorkflowEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  const record = createWorkflowEventRecord(runId, type, payload);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      INSERT INTO omni_workflow_events (id, workflow_run_id, type, payload, created_at)
      VALUES (${record.id}, ${record.workflowRunId}, ${record.type}, ${JSON.stringify(record.payload)}::jsonb, ${record.createdAt})
    `;
    return record;
  }

  await mutateWorkflowLedger((ledger) => {
    ledger.events.push(record);
    return trimWorkflowLedger(ledger);
  });
  return record;
}

export async function listWorkflowRecoveryEvents(limit = 20): Promise<WorkflowRecoveryEventRecord[]> {
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        event.id,
        event.workflow_run_id,
        event.type,
        event.payload,
        event.created_at,
        run.goal,
        run.status AS workflow_status,
        run.current_step,
        run.attempt,
        run.max_attempts,
        run.error AS workflow_error
      FROM omni_workflow_events event
      INNER JOIN omni_workflow_runs run ON run.id = event.workflow_run_id
      WHERE event.type IN ('workflow.recovery.requeued', 'workflow.recovery.failed')
      ORDER BY event.created_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowRecoveryEventFromRow);
  }

  const ledger = await readWorkflowLedger();
  return ledger.events
    .filter((event) => isWorkflowRecoveryEventType(event.type))
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, boundedLimit)
    .map((event) => {
      const run = ledger.runs.find((item) => item.id === event.workflowRunId);
      return workflowRecoveryEventFromRecord(event, run);
    });
}

export async function getWorkflowStats(): Promise<WorkflowStats> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT status, COUNT(*)::int AS count
      FROM omni_workflow_runs
      GROUP BY status
    `;
    const byStatus = rows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.status)] = Number(row.count);
      return acc;
    }, {});
    const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
    return {
      total,
      byStatus,
      active: ["queued", "running", "paused"].reduce((sum, status) => sum + (byStatus[status] || 0), 0),
      waitingApproval: byStatus.waiting_approval || 0,
      latest: await listWorkflowRuns(5),
    };
  }

  const ledger = await readWorkflowLedger();
  const byStatus = ledger.runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});
  return {
    total: ledger.runs.length,
    byStatus,
    active: ["queued", "running", "paused"].reduce((sum, status) => sum + (byStatus[status] || 0), 0),
    waitingApproval: byStatus.waiting_approval || 0,
    latest: ledger.runs.slice(0, 5),
  };
}

function createWorkflowEventRecord(
  workflowRunId: string,
  type: string,
  payload: Record<string, unknown>,
): WorkflowEventRecord {
  return {
    id: randomUUID(),
    workflowRunId,
    type,
    payload,
    createdAt: new Date().toISOString(),
  };
}

async function readWorkflowLedger() {
  return readJsonFile<WorkflowLedger>(getWorkflowFile(), { runs: [], steps: [], events: [] });
}

async function mutateWorkflowLedger(mutator: (ledger: WorkflowLedger) => WorkflowLedger) {
  workflowFileWriteQueue = workflowFileWriteQueue.then(
    async () => {
      const ledger = mutator(await readWorkflowLedger());
      await writeWorkflowLedger(ledger);
    },
    async () => {
      const ledger = mutator(await readWorkflowLedger());
      await writeWorkflowLedger(ledger);
    },
  );
  await workflowFileWriteQueue;
}

async function writeWorkflowLedger(ledger: WorkflowLedger) {
  await writeJsonFile(getWorkflowFile(), trimWorkflowLedger(ledger));
}

function trimWorkflowLedger(ledger: WorkflowLedger): WorkflowLedger {
  const runIds = new Set(ledger.runs.slice(0, 100).map((run) => run.id));
  return {
    runs: ledger.runs.slice(0, 100),
    steps: ledger.steps.filter((step) => runIds.has(step.workflowRunId)).slice(-1000),
    events: ledger.events.filter((event) => runIds.has(event.workflowRunId)).slice(-2000),
  };
}

function workflowRunFromRow(row: Record<string, unknown>): WorkflowRunRecord {
  return {
    id: String(row.id),
    workflowType: String(row.workflow_type),
    status: String(row.status) as WorkflowRunStatus,
    goal: String(row.goal || ""),
    input: parseObject(row.input) as WorkflowRunInput,
    currentStep: row.current_step ? (String(row.current_step) as WorkflowStepKey) : undefined,
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 3),
    approvalRequired: Boolean(row.approval_required),
    approvedAt: row.approved_at ? normalizeDate(row.approved_at) : undefined,
    pausedAt: row.paused_at ? normalizeDate(row.paused_at) : undefined,
    canceledAt: row.canceled_at ? normalizeDate(row.canceled_at) : undefined,
    error: row.error ? String(row.error) : undefined,
    result: parseObject(row.result),
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
  };
}

function workflowStepFromRow(row: Record<string, unknown>): WorkflowStepRecord {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    stepKey: String(row.step_key) as WorkflowStepKey,
    label: String(row.label),
    status: String(row.status) as WorkflowStepStatus,
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 3),
    input: parseObject(row.input) || {},
    output: parseObject(row.output),
    error: row.error ? String(row.error) : undefined,
    startedAt: row.started_at ? normalizeDate(row.started_at) : undefined,
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
  };
}

function workflowEventFromRow(row: Record<string, unknown>): WorkflowEventRecord {
  return {
    id: String(row.id),
    workflowRunId: String(row.workflow_run_id),
    type: String(row.type),
    payload: parseObject(row.payload) || {},
    createdAt: normalizeDate(row.created_at),
  };
}

function workflowRecoveryEventFromRow(row: Record<string, unknown>): WorkflowRecoveryEventRecord {
  return workflowRecoveryEventFromRecord(
    workflowEventFromRow(row),
    {
      id: String(row.workflow_run_id),
      workflowType: AGENT_WORKFLOW_TYPE,
      status: String(row.workflow_status) as WorkflowRunStatus,
      goal: String(row.goal || ""),
      input: { goal: String(row.goal || "") },
      currentStep: row.current_step ? (String(row.current_step) as WorkflowStepKey) : undefined,
      attempt: Number(row.attempt || 0),
      maxAttempts: Number(row.max_attempts || 3),
      approvalRequired: false,
      error: row.workflow_error ? String(row.workflow_error) : undefined,
      createdAt: normalizeDate(row.created_at),
      updatedAt: normalizeDate(row.created_at),
    },
  );
}

function workflowRecoveryEventFromRecord(
  event: WorkflowEventRecord,
  run?: WorkflowRunRecord,
): WorkflowRecoveryEventRecord {
  return {
    ...event,
    disposition: event.type === "workflow.recovery.requeued" ? "requeued" : "failed",
    workflow: {
      id: run?.id || event.workflowRunId,
      goal: run?.goal || "Unknown workflow",
      status: run?.status || "failed",
      currentStep: run?.currentStep,
      attempt: run?.attempt || 0,
      maxAttempts: run?.maxAttempts || 0,
      error: run?.error,
    },
  };
}

function isWorkflowRecoveryEventType(type: string) {
  return type === "workflow.recovery.requeued" || type === "workflow.recovery.failed";
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

function getWorkflowFile() {
  return getDataPath("workflows.json");
}
