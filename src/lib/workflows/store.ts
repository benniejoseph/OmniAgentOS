import { createHash, randomUUID } from "node:crypto";
import { ensureDatabaseSchema, getDatabaseTenantContext, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { appendDomainEventSafely } from "@/lib/events/store";
import { redactSensitive } from "@/lib/security/context";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
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

export async function createWorkflowRun(
  input: WorkflowRunInput & { tenantId?: string; idempotencyKey?: string },
) {
  const now = new Date().toISOString();
  const {
    tenantId: rawTenantId,
    idempotencyKey,
    ...workflowInput
  } = input;
  const safeWorkflowInput = redactSensitive(
    workflowInput,
  ) as WorkflowRunInput;
  const tenantId = normalizeTenantId(rawTenantId);
  const runId = idempotencyKey
    ? deterministicWorkflowId(tenantId, idempotencyKey)
    : randomUUID();
  const run: WorkflowRunRecord = {
    id: runId,
    tenantId,
    workflowType: AGENT_WORKFLOW_TYPE,
    status: "queued",
    goal: safeWorkflowInput.goal.trim(),
    input: safeWorkflowInput,
    currentStep: "preflight",
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    approvalRequired: input.requireApproval ?? true,
    createdAt: now,
    updatedAt: now,
  };
  const steps = workflowStepDefinitions.map<WorkflowStepRecord>((definition) => ({
    id: deterministicWorkflowStepId(run.id, definition.key),
    tenantId,
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
    const created = await getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const inserted = await sql`
          INSERT INTO omni_workflow_runs (
            id, tenant_id, workflow_type, status, goal, input, current_step, attempt,
            max_attempts, approval_required, created_at, updated_at
          )
          VALUES (
            ${run.id}, ${run.tenantId}, ${run.workflowType}, ${run.status}, ${run.goal},
            ${run.input}::jsonb, ${run.currentStep || null}, ${run.attempt},
            ${run.maxAttempts}, ${run.approvalRequired}, ${run.createdAt}, ${run.updatedAt}
          )
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
        if (!inserted[0]) {
          return false;
        }
        for (const step of steps) {
          await sql`
            INSERT INTO omni_workflow_steps (
              id, tenant_id, workflow_run_id, step_key, label, status, attempt,
              max_attempts, input, created_at, updated_at
            )
            VALUES (
              ${step.id}, ${tenantId}, ${step.workflowRunId}, ${step.stepKey},
              ${step.label}, ${step.status}, ${step.attempt}, ${step.maxAttempts},
              ${step.input}::jsonb, ${step.createdAt}, ${step.updatedAt}
            )
            ON CONFLICT (workflow_run_id, step_key) DO NOTHING
          `;
        }
        const event = createWorkflowEventRecord(
          run.id,
          "workflow.created",
          { goal: run.goal },
          tenantId,
        );
        await sql`
          INSERT INTO omni_workflow_events (
            id, tenant_id, workflow_run_id, type, payload, created_at
          )
          VALUES (
            ${event.id}, ${tenantId}, ${event.workflowRunId}, ${event.type},
            ${event.payload}::jsonb, ${event.createdAt}
          )
        `;
        return true;
      },
    ) as boolean;
    if (created) {
      await appendDomainEventSafely({
        streamId: `workflow:${run.id}`,
        type: "workflow.created",
        payload: { goal: run.goal },
        correlationId: run.id,
      });
    }
    return getWorkflowRunDetail(run.id) as Promise<WorkflowRunDetail>;
  }

  let created = false;
  await mutateWorkflowLedger((ledger) => {
    if (ledger.runs.some((existing) => existing.id === run.id)) {
      return ledger;
    }
    created = true;
    ledger.runs.unshift(run);
    ledger.steps.push(...steps);
    ledger.events.push(createWorkflowEventRecord(run.id, "workflow.created", { goal: run.goal }, tenantId));
    return trimWorkflowLedger(ledger);
  });
  if (created) {
    await appendDomainEventSafely({
      streamId: `workflow:${run.id}`,
      type: "workflow.created",
      payload: { goal: run.goal },
      correlationId: run.id,
    });
  }

  return getWorkflowRunDetail(run.id) as Promise<WorkflowRunDetail>;
}

export async function listWorkflowRuns(limit = 20, options: { tenantId?: string } = {}) {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_workflow_runs
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(workflowRunFromRow);
  }

  const ledger = await readWorkflowLedger();
  return ledger.runs.filter((run) => normalizeTenantId(run.tenantId) === tenantId).slice(0, limit);
}

export async function listWorkflowRunSummaries(
  limit = 20,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 50);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        id, tenant_id, workflow_type, status, goal,
        '{}'::jsonb AS input,
        current_step, attempt, max_attempts, approval_required, error,
        CASE
          WHEN jsonb_typeof(result -> 'report') = 'string'
          THEN jsonb_build_object('report', result -> 'report')
          ELSE NULL
        END AS result,
        created_at, updated_at, completed_at
      FROM omni_workflow_runs
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowRunFromRow);
  }

  const ledger = await readWorkflowLedger();
  return ledger.runs
    .filter((run) => normalizeTenantId(run.tenantId) === tenantId)
    .slice(0, boundedLimit);
}

export async function listWorkflowRunsByStatus(
  status: WorkflowRunStatus,
  limit = 20,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        id, tenant_id, workflow_type, status, goal, input, current_step,
        attempt, max_attempts, approval_required, approved_at, paused_at,
        canceled_at, error, result, created_at, updated_at, completed_at
      FROM omni_workflow_runs
      WHERE tenant_id = ${tenantId}
        AND status = ${status}
      ORDER BY updated_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowRunFromRow);
  }

  const ledger = await readWorkflowLedger();
  return ledger.runs
    .filter(
      (run) =>
        normalizeTenantId(run.tenantId) === tenantId &&
        run.status === status,
    )
    .slice(0, boundedLimit);
}

export async function listRunnableWorkflowRuns(
  limit = 50,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(limit, 1), 500);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        id, tenant_id, workflow_type, status, goal, input, current_step,
        attempt, max_attempts, approval_required, approved_at, paused_at,
        canceled_at, error, result, created_at, updated_at, completed_at
      FROM omni_workflow_runs
      WHERE tenant_id = ${tenantId}
        AND status = 'queued'
      ORDER BY created_at ASC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowRunFromRow);
  }

  const ledger = await readWorkflowLedger();
  return ledger.runs
    .filter(
      (run) =>
        normalizeTenantId(run.tenantId) === tenantId &&
        run.status === "queued",
    )
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .slice(0, boundedLimit);
}

export async function getWorkflowRunStatus(
  runId: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT id, status, current_step, error, updated_at, completed_at
      FROM omni_workflow_runs
      WHERE id = ${runId}
        AND tenant_id = ${tenantId}
      LIMIT 1
    `;
    const row = rows[0];
    return row
      ? {
          id: String(row.id),
          status: String(row.status) as WorkflowRunStatus,
          currentStep: row.current_step
            ? (String(row.current_step) as WorkflowStepKey)
            : undefined,
          error: row.error ? String(row.error) : undefined,
          updatedAt: normalizeDate(row.updated_at),
          completedAt: row.completed_at
            ? normalizeDate(row.completed_at)
            : undefined,
        }
      : null;
  }

  const ledger = await readWorkflowLedger();
  const run = ledger.runs.find(
    (candidate) =>
      candidate.id === runId &&
      normalizeTenantId(candidate.tenantId) === tenantId,
  );
  return run
    ? {
        id: run.id,
        status: run.status,
        currentStep: run.currentStep,
        error: run.error,
        updatedAt: run.updatedAt,
        completedAt: run.completedAt,
      }
    : null;
}

export async function getWorkflowRunDetail(runId: string, options: { tenantId?: string } = {}): Promise<WorkflowRunDetail | null> {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = options.tenantId ? normalizeTenantId(options.tenantId) : undefined;
    const runRows = tenantId
      ? await getSql()`
          SELECT *
          FROM omni_workflow_runs
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
          LIMIT 1
        `
      : await getSql()`
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
  if (!run || (options.tenantId && normalizeTenantId(run.tenantId) !== normalizeTenantId(options.tenantId))) {
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
  const nextRun = sanitizeWorkflowRunRecord({
    ...existing.run,
    ...patch,
    updatedAt: now,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_workflow_runs
      SET workflow_type = ${nextRun.workflowType},
          status = ${nextRun.status},
          goal = ${nextRun.goal},
          input = ${nextRun.input || {}}::jsonb,
          current_step = ${nextRun.currentStep || null},
          attempt = ${nextRun.attempt},
          max_attempts = ${nextRun.maxAttempts},
          approval_required = ${nextRun.approvalRequired},
          approved_at = ${nextRun.approvedAt || null},
          paused_at = ${nextRun.pausedAt || null},
          canceled_at = ${nextRun.canceledAt || null},
          error = ${nextRun.error || null},
          result = ${nextRun.result || null}::jsonb,
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

export async function transitionWorkflowRun(
  runId: string,
  expectedStatuses: readonly WorkflowRunStatus[],
  patch: Partial<Omit<WorkflowRunRecord, "id" | "createdAt">>,
  options: {
    tenantId?: string;
    expectedUpdatedAt?: string;
    requireNoActiveJobDedupeKey?: string;
  } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const existing = await getWorkflowRunDetail(runId, { tenantId });
  if (!existing || !expectedStatuses.includes(existing.run.status)) {
    return null;
  }
  const now = new Date().toISOString();
  const nextRun = sanitizeWorkflowRunRecord({
    ...existing.run,
    ...patch,
    updatedAt: now,
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      WITH recovery_jobs AS MATERIALIZED (
        SELECT status, lease_expires_at
        FROM omni_operation_jobs
        WHERE tenant_id = ${tenantId}
          AND dedupe_key = ${options.requireNoActiveJobDedupeKey || "__no_recovery_job__"}
        FOR UPDATE
      )
      UPDATE omni_workflow_runs
      SET workflow_type = ${nextRun.workflowType},
          status = ${nextRun.status},
          goal = ${nextRun.goal},
          input = ${nextRun.input || {}}::jsonb,
          current_step = ${nextRun.currentStep || null},
          attempt = ${nextRun.attempt},
          max_attempts = ${nextRun.maxAttempts},
          approval_required = ${nextRun.approvalRequired},
          approved_at = ${nextRun.approvedAt || null},
          paused_at = ${nextRun.pausedAt || null},
          canceled_at = ${nextRun.canceledAt || null},
          error = ${nextRun.error || null},
          result = ${nextRun.result || null}::jsonb,
          updated_at = ${nextRun.updatedAt},
          completed_at = ${nextRun.completedAt || null}
      WHERE id = ${runId}
        AND tenant_id = ${tenantId}
        AND status = ANY(${expectedStatuses as WorkflowRunStatus[]})
        AND (
          ${options.expectedUpdatedAt || null}::timestamptz IS NULL
          OR updated_at = ${options.expectedUpdatedAt || null}::timestamptz
        )
        AND (
          ${options.requireNoActiveJobDedupeKey || null}::text IS NULL
          OR NOT EXISTS (
            SELECT 1
            FROM recovery_jobs
            WHERE status = 'running'
              AND lease_expires_at > NOW()
          )
        )
      RETURNING *
    `;
    return rows[0] ? workflowRunFromRow(rows[0]) : null;
  }

  let transitioned: WorkflowRunRecord | null = null;
  await mutateWorkflowLedger((ledger) => {
    ledger.runs = ledger.runs.map((run) => {
      if (
        run.id !== runId ||
        normalizeTenantId(run.tenantId) !== tenantId ||
        !expectedStatuses.includes(run.status) ||
        (options.expectedUpdatedAt && run.updatedAt !== options.expectedUpdatedAt)
      ) {
        return run;
      }
      transitioned = sanitizeWorkflowRunRecord({
        ...run,
        ...patch,
        updatedAt: now,
      });
      return transitioned;
    });
    return ledger;
  });
  return transitioned;
}

export async function reclaimWorkflowRunForQueueDelivery(
  runId: string,
  {
    tenantId: requestedTenantId,
    jobId,
    leaseOwner,
    deliveryAttempt,
  }: {
    tenantId?: string;
    jobId: string;
    leaseOwner: string;
    deliveryAttempt: number;
  },
): Promise<"unchanged" | "requeued" | "failed" | "stale"> {
  const tenantId = normalizeTenantId(requestedTenantId);
  if (deliveryAttempt <= 1 || !leaseOwner) {
    return "unchanged";
  }
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const jobRows = await sql`
          SELECT id
          FROM omni_operation_jobs
          WHERE id = ${jobId}
            AND tenant_id = ${tenantId}
            AND type = 'workflow.tick'
            AND status = 'running'
            AND lease_owner = ${leaseOwner}
            AND lease_expires_at > NOW()
            AND payload->>'workflowRunId' = ${runId}
          FOR UPDATE
        `;
        if (!jobRows[0]) {
          return "stale";
        }
        const runRows = await sql`
          SELECT *
          FROM omni_workflow_runs
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
          FOR UPDATE
        `;
        if (!runRows[0] || String(runRows[0].status) !== "running") {
          return "unchanged";
        }
        const currentStep = runRows[0].current_step
          ? String(runRows[0].current_step)
          : undefined;
        const stepRows = currentStep
          ? await sql`
              SELECT *
              FROM omni_workflow_steps
              WHERE workflow_run_id = ${runId}
                AND tenant_id = ${tenantId}
                AND step_key = ${currentStep}
              FOR UPDATE
            `
          : [];
        const step = stepRows[0];
        const exhausted =
          step &&
          String(step.status) === "running" &&
          Number(step.attempt) >= Number(step.max_attempts);
        if (exhausted) {
          await sql`
            UPDATE omni_workflow_steps
            SET status = 'failed',
                error = 'Workflow delivery expired after the step exhausted its retry budget.',
                completed_at = ${now},
                updated_at = ${now}
            WHERE id = ${String(step.id)}
              AND tenant_id = ${tenantId}
          `;
          await sql`
            UPDATE omni_workflow_runs
            SET status = 'failed',
                error = 'Workflow delivery expired after the step exhausted its retry budget.',
                completed_at = ${now},
                updated_at = ${now}
            WHERE id = ${runId}
              AND tenant_id = ${tenantId}
              AND status = 'running'
          `;
          return "failed";
        }
        if (step && String(step.status) === "running") {
          await sql`
            UPDATE omni_workflow_steps
            SET status = 'pending',
                started_at = NULL,
                completed_at = NULL,
                error = NULL,
                updated_at = ${now}
            WHERE id = ${String(step.id)}
              AND tenant_id = ${tenantId}
          `;
        }
        await sql`
          UPDATE omni_workflow_runs
          SET status = 'queued',
              error = 'Recovered an interrupted workflow delivery.',
              completed_at = NULL,
              updated_at = ${now}
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
            AND status = 'running'
        `;
        return "requeued";
      },
    ) as Promise<"unchanged" | "requeued" | "failed" | "stale">;
  }

  let disposition: "unchanged" | "requeued" | "failed" = "unchanged";
  await mutateWorkflowLedger((ledger) => {
    const runIndex = ledger.runs.findIndex(
      (run) =>
        run.id === runId &&
        normalizeTenantId(run.tenantId) === tenantId &&
        run.status === "running",
    );
    if (runIndex < 0) {
      return ledger;
    }
    const run = ledger.runs[runIndex]!;
    const stepIndex = run.currentStep
      ? ledger.steps.findIndex(
          (step) =>
            step.workflowRunId === runId &&
            normalizeTenantId(step.tenantId) === tenantId &&
            step.stepKey === run.currentStep,
        )
      : -1;
    const step = stepIndex >= 0 ? ledger.steps[stepIndex] : undefined;
    if (
      step &&
      step.status === "running" &&
      step.attempt >= step.maxAttempts
    ) {
      ledger.steps[stepIndex] = {
        ...step,
        status: "failed",
        error:
          "Workflow delivery expired after the step exhausted its retry budget.",
        completedAt: now,
        updatedAt: now,
      };
      ledger.runs[runIndex] = {
        ...run,
        status: "failed",
        error:
          "Workflow delivery expired after the step exhausted its retry budget.",
        completedAt: now,
        updatedAt: now,
      };
      disposition = "failed";
      return ledger;
    }
    if (step && step.status === "running") {
      ledger.steps[stepIndex] = {
        ...step,
        status: "pending",
        startedAt: undefined,
        completedAt: undefined,
        error: undefined,
        updatedAt: now,
      };
    }
    ledger.runs[runIndex] = {
      ...run,
      status: "queued",
      error: "Recovered an interrupted workflow delivery.",
      completedAt: undefined,
      updatedAt: now,
    };
    disposition = "requeued";
    return ledger;
  });
  return disposition;
}

export async function failWorkflowRunForQueueExhaustion(
  runId: string,
  {
    tenantId: requestedTenantId,
    jobId,
    leaseOwner,
    reason,
  }: {
    tenantId?: string;
    jobId: string;
    leaseOwner: string;
    reason: string;
  },
) {
  const tenantId = normalizeTenantId(requestedTenantId);
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const jobRows = await sql`
          SELECT id
          FROM omni_operation_jobs
          WHERE id = ${jobId}
            AND tenant_id = ${tenantId}
            AND type = 'workflow.tick'
            AND status = 'running'
            AND lease_owner = ${leaseOwner}
            AND lease_expires_at > NOW()
            AND attempt >= max_attempts
            AND payload->>'workflowRunId' = ${runId}
          FOR UPDATE
        `;
        if (!jobRows[0]) {
          return false;
        }
        const runRows = await sql`
          SELECT current_step, status
          FROM omni_workflow_runs
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
          FOR UPDATE
        `;
        if (
          !runRows[0] ||
          ["completed", "failed", "canceled"].includes(
            String(runRows[0].status),
          )
        ) {
          return false;
        }
        if (runRows[0].current_step) {
          await sql`
            UPDATE omni_workflow_steps
            SET status = 'failed',
                error = ${reason},
                completed_at = ${now},
                updated_at = ${now}
            WHERE workflow_run_id = ${runId}
              AND tenant_id = ${tenantId}
              AND step_key = ${String(runRows[0].current_step)}
              AND status IN ('pending', 'running')
          `;
        }
        const updated = await sql`
          UPDATE omni_workflow_runs
          SET status = 'failed',
              error = ${reason},
              completed_at = ${now},
              updated_at = ${now}
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
            AND status NOT IN ('completed', 'failed', 'canceled')
          RETURNING id
        `;
        return Boolean(updated[0]);
      },
    ) as Promise<boolean>;
  }

  let failed = false;
  await mutateWorkflowLedger((ledger) => {
    const runIndex = ledger.runs.findIndex(
      (run) =>
        run.id === runId &&
        normalizeTenantId(run.tenantId) === tenantId &&
        !["completed", "failed", "canceled"].includes(run.status),
    );
    if (runIndex < 0) {
      return ledger;
    }
    const run = ledger.runs[runIndex]!;
    ledger.runs[runIndex] = {
      ...run,
      status: "failed",
      error: reason,
      completedAt: now,
      updatedAt: now,
    };
    if (run.currentStep) {
      ledger.steps = ledger.steps.map((step) =>
        step.workflowRunId === runId &&
        normalizeTenantId(step.tenantId) === tenantId &&
        step.stepKey === run.currentStep &&
        ["pending", "running"].includes(step.status)
          ? {
              ...step,
              status: "failed",
              error: reason,
              completedAt: now,
              updatedAt: now,
            }
          : step,
      );
    }
    failed = true;
    return ledger;
  });
  return failed;
}

export async function approveWorkflowRun(
  runId: string,
  {
    tenantId: requestedTenantId,
    approvedAt = new Date().toISOString(),
  }: {
    tenantId?: string;
    approvedAt?: string;
  } = {},
) {
  const tenantId = normalizeTenantId(requestedTenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return getSql().transaction(
      async (sql: ReturnType<typeof getSql>) => {
        const rows = await sql`
          UPDATE omni_workflow_runs
          SET status = 'queued',
              approved_at = ${approvedAt},
              error = NULL,
              completed_at = NULL,
              current_step = CASE
                WHEN current_step = 'approval_gate' THEN 'execute'
                ELSE current_step
              END,
              updated_at = ${approvedAt}
          WHERE id = ${runId}
            AND tenant_id = ${tenantId}
            AND status = 'waiting_approval'
          RETURNING *
        `;
        if (!rows[0]) {
          return null;
        }
        const steps = await sql`
          UPDATE omni_workflow_steps
          SET status = 'completed',
              output = ${{ approvedAt }}::jsonb,
              completed_at = ${approvedAt},
              updated_at = ${approvedAt}
          WHERE workflow_run_id = ${runId}
            AND tenant_id = ${tenantId}
            AND step_key = 'approval_gate'
          RETURNING id
        `;
        if (!steps[0]) {
          throw new Error("Workflow approval gate is missing.");
        }
        return workflowRunFromRow(rows[0]);
      },
    ) as Promise<WorkflowRunRecord | null>;
  }

  let approved: WorkflowRunRecord | null = null;
  await mutateWorkflowLedger((ledger) => {
    const runIndex = ledger.runs.findIndex(
      (run) =>
        run.id === runId &&
        normalizeTenantId(run.tenantId) === tenantId &&
        run.status === "waiting_approval",
    );
    const stepIndex = ledger.steps.findIndex(
      (step) =>
        step.workflowRunId === runId &&
        normalizeTenantId(step.tenantId) === tenantId &&
        step.stepKey === "approval_gate",
    );
    if (runIndex < 0 || stepIndex < 0) {
      return ledger;
    }
    const run = ledger.runs[runIndex]!;
    approved = {
      ...run,
      status: "queued",
      approvedAt,
      error: undefined,
      completedAt: undefined,
      currentStep:
        run.currentStep === "approval_gate" ? "execute" : run.currentStep,
      updatedAt: approvedAt,
    };
    ledger.runs[runIndex] = approved;
    ledger.steps[stepIndex] = {
      ...ledger.steps[stepIndex]!,
      status: "completed",
      output: { approvedAt },
      completedAt: approvedAt,
      updatedAt: approvedAt,
    };
    return ledger;
  });
  return approved;
}

export async function saveWorkflowStep(step: WorkflowStepRecord) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = normalizeTenantId(step.tenantId || await resolveWorkflowRunTenantId(step.workflowRunId));
    const nextStep = sanitizeWorkflowStepRecord({ ...step, tenantId });
    await getSql()`
      INSERT INTO omni_workflow_steps (
        id, tenant_id, workflow_run_id, step_key, label, status, attempt, max_attempts,
        input, output, error, started_at, completed_at, created_at, updated_at
      )
      VALUES (
        ${nextStep.id}, ${tenantId}, ${nextStep.workflowRunId}, ${nextStep.stepKey}, ${nextStep.label},
        ${nextStep.status}, ${nextStep.attempt}, ${nextStep.maxAttempts},
        ${nextStep.input || {}}::jsonb,
        ${nextStep.output || null}::jsonb, ${nextStep.error || null},
        ${nextStep.startedAt || null}, ${nextStep.completedAt || null},
        ${nextStep.createdAt}, ${nextStep.updatedAt}
      )
      ON CONFLICT (workflow_run_id, step_key) DO UPDATE SET
        tenant_id = EXCLUDED.tenant_id,
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
    return nextStep;
  }

  let savedStep = step;
  await mutateWorkflowLedger((ledger) => {
    const tenantId = normalizeTenantId(step.tenantId || ledger.runs.find((run) => run.id === step.workflowRunId)?.tenantId);
    const nextStep = sanitizeWorkflowStepRecord({ ...step, tenantId });
    savedStep = nextStep;
    const existingIndex = ledger.steps.findIndex((item) => item.id === nextStep.id);
    if (existingIndex >= 0) {
      ledger.steps[existingIndex] = nextStep;
    } else {
      ledger.steps.push(nextStep);
    }
    return ledger;
  });
  return savedStep;
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

export async function updateWorkflowStepForRunFence(
  runId: string,
  stepKey: WorkflowStepKey,
  patch: Partial<
    Omit<WorkflowStepRecord, "id" | "workflowRunId" | "stepKey" | "createdAt">
  >,
  {
    tenantId: requestedTenantId,
    expectedRunUpdatedAt,
  }: {
    tenantId?: string;
    expectedRunUpdatedAt: string;
  },
) {
  const tenantId = normalizeTenantId(requestedTenantId);
  const existing = await getWorkflowStep(runId, stepKey);
  if (!existing) {
    return null;
  }
  const nextStep = sanitizeWorkflowStepRecord({
    ...existing,
    ...patch,
    tenantId,
    updatedAt: new Date().toISOString(),
  });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_workflow_steps step
      SET label = ${nextStep.label},
          status = ${nextStep.status},
          attempt = ${nextStep.attempt},
          max_attempts = ${nextStep.maxAttempts},
          input = ${nextStep.input || {}}::jsonb,
          output = ${nextStep.output || null}::jsonb,
          error = ${nextStep.error || null},
          started_at = ${nextStep.startedAt || null},
          completed_at = ${nextStep.completedAt || null},
          updated_at = ${nextStep.updatedAt}
      WHERE step.workflow_run_id = ${runId}
        AND step.step_key = ${stepKey}
        AND step.tenant_id = ${tenantId}
        AND EXISTS (
          SELECT 1
          FROM omni_workflow_runs run
          WHERE run.id = step.workflow_run_id
            AND run.tenant_id = step.tenant_id
            AND run.status = 'running'
            AND run.current_step = ${stepKey}
            AND run.updated_at = ${expectedRunUpdatedAt}::timestamptz
        )
      RETURNING step.*
    `;
    return rows[0] ? workflowStepFromRow(rows[0]) : null;
  }

  let saved: WorkflowStepRecord | null = null;
  await mutateWorkflowLedger((ledger) => {
    const run = ledger.runs.find(
      (item) =>
        item.id === runId &&
        normalizeTenantId(item.tenantId) === tenantId,
    );
    if (
      !run ||
      run.status !== "running" ||
      run.currentStep !== stepKey ||
      run.updatedAt !== expectedRunUpdatedAt
    ) {
      return ledger;
    }
    ledger.steps = ledger.steps.map((step) => {
      if (
        step.workflowRunId !== runId ||
        step.stepKey !== stepKey ||
        normalizeTenantId(step.tenantId) !== tenantId
      ) {
        return step;
      }
      saved = nextStep;
      return nextStep;
    });
    return ledger;
  });
  return saved;
}

export async function appendWorkflowEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
) {
  // Stage-1 event-log dual-write (docs/vision/EVENT_LOG.md).
  await appendDomainEventSafely({
    streamId: `workflow:${runId}`,
    type: `workflow.${type.replace(/^workflow\./, "")}`,
    payload,
    correlationId: runId,
  });

  let record: WorkflowEventRecord | undefined;

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const tenantId = await resolveWorkflowRunTenantId(runId);
    record = createWorkflowEventRecord(runId, type, payload, tenantId);
    await getSql()`
      INSERT INTO omni_workflow_events (id, tenant_id, workflow_run_id, type, payload, created_at)
      VALUES (${record.id}, ${tenantId}, ${record.workflowRunId}, ${record.type}, ${record.payload}::jsonb, ${record.createdAt})
    `;
    return record;
  }

  await mutateWorkflowLedger((ledger) => {
    const tenantId = normalizeTenantId(ledger.runs.find((run) => run.id === runId)?.tenantId);
    record = createWorkflowEventRecord(runId, type, payload, tenantId);
    ledger.events.push(record);
    return trimWorkflowLedger(ledger);
  });
  return record as WorkflowEventRecord;
}

export async function listWorkflowRecoveryEvents(
  limit = 20,
  options: { tenantId?: string } = {},
): Promise<WorkflowRecoveryEventRecord[]> {
  const tenantId = normalizeTenantId(options.tenantId);
  const boundedLimit = Math.min(Math.max(Math.round(limit), 1), 100);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT
        event.id,
        event.tenant_id,
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
      WHERE event.tenant_id = ${tenantId}
        AND event.type IN ('workflow.recovery.requeued', 'workflow.recovery.failed')
      ORDER BY event.created_at DESC
      LIMIT ${boundedLimit}
    `;
    return rows.map(workflowRecoveryEventFromRow);
  }

  const ledger = await readWorkflowLedger();
  return ledger.events
    .filter(
      (event) =>
        normalizeTenantId(event.tenantId) === tenantId &&
        isWorkflowRecoveryEventType(event.type),
    )
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, boundedLimit)
    .map((event) => {
      const run = ledger.runs.find((item) => item.id === event.workflowRunId);
      return workflowRecoveryEventFromRecord(event, run);
    });
}

export async function getWorkflowStats(options: { tenantId?: string } = {}): Promise<WorkflowStats> {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT status, COUNT(*)::int AS count
      FROM omni_workflow_runs
      WHERE tenant_id = ${tenantId}
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
      latest: await listWorkflowRuns(5, { tenantId }),
    };
  }

  const ledger = await readWorkflowLedger();
  const runs = ledger.runs.filter((run) => normalizeTenantId(run.tenantId) === tenantId);
  const byStatus = runs.reduce<Record<string, number>>((acc, run) => {
    acc[run.status] = (acc[run.status] || 0) + 1;
    return acc;
  }, {});
  return {
    total: runs.length,
    byStatus,
    active: ["queued", "running", "paused"].reduce((sum, status) => sum + (byStatus[status] || 0), 0),
    waitingApproval: byStatus.waiting_approval || 0,
    latest: runs.slice(0, 5),
  };
}

function createWorkflowEventRecord(
  workflowRunId: string,
  type: string,
  payload: Record<string, unknown>,
  tenantId?: string,
): WorkflowEventRecord {
  return {
    id: randomUUID(),
    tenantId: normalizeTenantId(tenantId),
    workflowRunId,
    type,
    payload: redactSensitive(payload) as Record<string, unknown>,
    createdAt: new Date().toISOString(),
  };
}

function sanitizeWorkflowRunRecord(
  run: WorkflowRunRecord,
): WorkflowRunRecord {
  return {
    ...run,
    goal: String(redactSensitive(run.goal)).slice(0, 4_000),
    input: redactSensitive(run.input) as WorkflowRunInput,
    error: run.error
      ? String(redactSensitive(run.error)).slice(0, 2_000)
      : undefined,
    result: run.result
      ? (redactSensitive(run.result) as Record<string, unknown>)
      : undefined,
  };
}

function sanitizeWorkflowStepRecord(
  step: WorkflowStepRecord,
): WorkflowStepRecord {
  return {
    ...step,
    input: redactSensitive(step.input) as Record<string, unknown>,
    output: step.output
      ? (redactSensitive(step.output) as Record<string, unknown>)
      : undefined,
    error: step.error
      ? String(redactSensitive(step.error)).slice(0, 2_000)
      : undefined,
  };
}

async function readWorkflowLedger() {
  const ledger = await readJsonFile<WorkflowLedger>(
    getWorkflowFile(),
    { runs: [], steps: [], events: [] },
  );
  return {
    runs: ledger.runs.map(sanitizeWorkflowRunRecord),
    steps: ledger.steps.map(sanitizeWorkflowStepRecord),
    events: ledger.events.map((event) => ({
      ...event,
      payload: redactSensitive(event.payload) as Record<string, unknown>,
    })),
  };
}

async function mutateWorkflowLedger(mutator: (ledger: WorkflowLedger) => WorkflowLedger) {
  await updateJsonFile<WorkflowLedger>(
    getWorkflowFile(),
    { runs: [], steps: [], events: [] },
    (ledger) => trimWorkflowLedger(mutator(ledger)),
  );
}

function trimWorkflowLedger(ledger: WorkflowLedger): WorkflowLedger {
  const activeRuns = ledger.runs.filter(
    (run) => !["completed", "failed", "canceled"].includes(run.status),
  );
  const terminalRuns = ledger.runs.filter(
    (run) => ["completed", "failed", "canceled"].includes(run.status),
  );
  const runs = [
    ...activeRuns,
    ...terminalRuns.slice(0, Math.max(0, 100 - activeRuns.length)),
  ];
  const runIds = new Set(runs.map((run) => run.id));
  const activeRunIds = new Set(activeRuns.map((run) => run.id));
  const activeSteps = ledger.steps.filter((step) => activeRunIds.has(step.workflowRunId));
  const terminalSteps = ledger.steps.filter(
    (step) => runIds.has(step.workflowRunId) && !activeRunIds.has(step.workflowRunId),
  );
  const terminalStepLimit = Math.max(0, 1000 - activeSteps.length);
  return {
    runs,
    steps: [
      ...activeSteps,
      ...(terminalStepLimit ? terminalSteps.slice(-terminalStepLimit) : []),
    ],
    events: ledger.events.filter((event) => runIds.has(event.workflowRunId)).slice(-2000),
  };
}

function workflowRunFromRow(row: Record<string, unknown>): WorkflowRunRecord {
  return sanitizeWorkflowRunRecord({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
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
  });
}

function workflowStepFromRow(row: Record<string, unknown>): WorkflowStepRecord {
  return sanitizeWorkflowStepRecord({
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
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
  });
}

function workflowEventFromRow(row: Record<string, unknown>): WorkflowEventRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id || "default"),
    workflowRunId: String(row.workflow_run_id),
    type: String(row.type),
    payload: redactSensitive(parseObject(row.payload) || {}) as Record<
      string,
      unknown
    >,
    createdAt: normalizeDate(row.created_at),
  };
}

function workflowRecoveryEventFromRow(row: Record<string, unknown>): WorkflowRecoveryEventRecord {
  return workflowRecoveryEventFromRecord(
    workflowEventFromRow(row),
    sanitizeWorkflowRunRecord({
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
    }),
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

async function resolveWorkflowRunTenantId(runId: string) {
  const rows = await getSql()`
    SELECT tenant_id
    FROM omni_workflow_runs
    WHERE id = ${runId}
    LIMIT 1
  `;
  return normalizeTenantId(rows[0]?.tenant_id ? String(rows[0].tenant_id) : getDatabaseTenantContext());
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

function deterministicWorkflowId(tenantId: string, idempotencyKey: string) {
  return `wf_${createHash("sha256")
    .update(`${tenantId}\0${idempotencyKey}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function deterministicWorkflowStepId(runId: string, stepKey: WorkflowStepKey) {
  return `wfs_${createHash("sha256")
    .update(`${runId}\0${stepKey}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function normalizeTenantId(value?: string) {
  return (value || getDatabaseTenantContext() || process.env.OMNIAGENT_DEFAULT_TENANT || "default")
    .trim()
    .replace(/[^a-zA-Z0-9_.:-]/g, "_")
    .slice(0, 120) || "default";
}

function getWorkflowFile() {
  return getDataPath("workflows.json");
}
