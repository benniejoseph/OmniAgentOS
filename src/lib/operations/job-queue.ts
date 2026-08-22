import { randomUUID } from "node:crypto";
import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import {
  ensureDatabaseSchema,
  getDatabaseTenantContext,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type OperationJobType = "workflow.tick" | "agent.resume";
export type OperationJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type OperationJobRecord = {
  id: string;
  tenantId: string;
  type: OperationJobType;
  status: OperationJobStatus;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  priority: number;
  attempt: number;
  maxAttempts: number;
  runAt: string;
  lockedAt?: string;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
};

export type OperationJobStats = {
  total: number;
  byStatus: Record<string, number>;
  runnable: number;
  delayed: number;
  expiredLeases: number;
  latest: OperationJobRecord[];
};

type OperationJobLedger = {
  jobs: OperationJobRecord[];
};

type EnqueueOperationJobInput = {
  tenantId?: string;
  type: OperationJobType;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
  runAt?: string;
};

type LeaseOperationJobInput = {
  tenantId?: string;
  type?: OperationJobType;
  dedupeKey?: string;
  limit?: number;
  leaseSeconds?: number;
  owner?: string;
};

export async function enqueueOperationJob(
  input: EnqueueOperationJobInput,
  options: { sql?: ReturnType<typeof getSql> } = {},
) {
  const now = new Date().toISOString();
  const runAt = input.runAt || now;
  const tenantId = normalizeTenantId(input.tenantId);
  const job: OperationJobRecord = {
    id: randomUUID(),
    tenantId,
    type: input.type,
    status: "queued",
    payload: input.payload,
    dedupeKey: input.dedupeKey,
    priority: input.priority ?? 0,
    attempt: 0,
    maxAttempts: input.maxAttempts ?? 3,
    runAt,
    createdAt: now,
    updatedAt: now,
  };

  if (hasDatabaseUrl()) {
    if (!options.sql) {
      await ensureDatabaseSchema();
    }
    const sql = options.sql || getSql();

    if (input.dedupeKey) {
      const rows = await sql`
        INSERT INTO omni_operation_jobs (
          id, tenant_id, type, status, payload, dedupe_key, priority, attempt,
          max_attempts, run_at, created_at, updated_at
        )
        VALUES (
          ${job.id}, ${tenantId}, ${job.type}, ${job.status}, ${JSON.stringify(job.payload)}::jsonb,
          ${storageDedupeKey(tenantId, job.dedupeKey!)}, ${job.priority}, ${job.attempt}, ${job.maxAttempts},
          ${job.runAt}, ${job.createdAt}, ${job.updatedAt}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
          type = EXCLUDED.type,
          payload = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN EXCLUDED.payload || '{"__rerunRequested":true}'::jsonb
            ELSE EXCLUDED.payload
          END,
          priority = GREATEST(omni_operation_jobs.priority, EXCLUDED.priority),
          max_attempts = EXCLUDED.max_attempts,
          status = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN omni_operation_jobs.status
            ELSE 'queued'
          END,
          attempt = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN omni_operation_jobs.attempt
            ELSE 0
          END,
          run_at = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN omni_operation_jobs.run_at
            WHEN omni_operation_jobs.status = 'queued'
            THEN LEAST(omni_operation_jobs.run_at, EXCLUDED.run_at)
            ELSE EXCLUDED.run_at
          END,
          locked_at = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN omni_operation_jobs.locked_at
            ELSE NULL
          END,
          lease_owner = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN omni_operation_jobs.lease_owner
            ELSE NULL
          END,
          lease_expires_at = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN omni_operation_jobs.lease_expires_at
            ELSE NULL
          END,
          last_error = CASE
            WHEN omni_operation_jobs.status = 'running'
              AND omni_operation_jobs.lease_expires_at > NOW()
            THEN omni_operation_jobs.last_error
            ELSE NULL
          END,
          completed_at = NULL,
          updated_at = NOW()
        RETURNING *
      `;
      return operationJobFromRow(rows[0]);
    }

    const rows = await sql`
      INSERT INTO omni_operation_jobs (
        id, tenant_id, type, status, payload, dedupe_key, priority, attempt,
        max_attempts, run_at, created_at, updated_at
      )
      VALUES (
        ${job.id}, ${tenantId}, ${job.type}, ${job.status}, ${JSON.stringify(job.payload)}::jsonb,
        ${job.dedupeKey || null}, ${job.priority}, ${job.attempt}, ${job.maxAttempts},
        ${job.runAt}, ${job.createdAt}, ${job.updatedAt}
      )
      RETURNING *
    `;
    return operationJobFromRow(rows[0]);
  }

  let saved = job;
  await mutateJobLedger((ledger) => {
    if (input.dedupeKey) {
      const existing = ledger.jobs.find(
        (item) => jobTenantId(item) === tenantId && item.dedupeKey === input.dedupeKey,
      );
      if (existing) {
        const activeLease = existing.status === "running" && Date.parse(existing.leaseExpiresAt || "") > Date.now();
        saved = {
          ...existing,
          type: input.type,
          payload: activeLease
            ? { ...input.payload, __rerunRequested: true }
            : input.payload,
          priority: Math.max(existing.priority, job.priority),
          maxAttempts: job.maxAttempts,
          status: activeLease ? existing.status : "queued",
          attempt: activeLease ? existing.attempt : 0,
          runAt: activeLease
            ? existing.runAt
            : existing.status === "queued" && Date.parse(existing.runAt) < Date.parse(runAt)
              ? existing.runAt
              : runAt,
          lockedAt: activeLease ? existing.lockedAt : undefined,
          leaseOwner: activeLease ? existing.leaseOwner : undefined,
          leaseExpiresAt: activeLease ? existing.leaseExpiresAt : undefined,
          lastError: activeLease ? existing.lastError : undefined,
          completedAt: undefined,
          updatedAt: now,
        };
        ledger.jobs = ledger.jobs.map((item) => (item.id === existing.id ? saved : item));
        return trimJobLedger(ledger);
      }
    }

    ledger.jobs.unshift(job);
    return trimJobLedger(ledger);
  });
  return saved;
}

export async function leaseOperationJobs(input: LeaseOperationJobInput = {}) {
  const tenantId = normalizeTenantId(input.tenantId);
  const limit = Math.min(Math.max(input.limit || 1, 1), 25);
  const leaseSeconds = Math.min(Math.max(input.leaseSeconds || OPERATION_QUEUE_LEASE_SECONDS, 10), 3600);
  const owner = input.owner || `worker:${randomUUID()}`;

  await repairExpiredOperationJobs({ tenantId });

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const filters = ["tenant_id = $1", "status = 'queued'", "run_at <= NOW()"];
    const params: Array<string | number> = [tenantId];
    if (input.type) {
      params.push(input.type);
      filters.push(`type = $${params.length}`);
    }
    if (input.dedupeKey) {
      params.push(storageDedupeKey(tenantId, input.dedupeKey));
      filters.push(`dedupe_key = $${params.length}`);
    }
    params.push(limit);
    const limitParam = params.length;
    params.push(owner);
    const ownerParam = params.length;
    params.push(leaseSeconds);
    const leaseParam = params.length;

    const rows = await getSql().query(
      `
        WITH next_jobs AS (
          SELECT id
          FROM omni_operation_jobs
          WHERE ${filters.join(" AND ")}
          ORDER BY priority DESC, run_at ASC, created_at ASC
          LIMIT $${limitParam}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE omni_operation_jobs jobs
        SET status = 'running',
            attempt = jobs.attempt + 1,
            locked_at = NOW(),
            lease_owner = $${ownerParam},
            lease_expires_at = NOW() + ($${leaseParam}::int * INTERVAL '1 second'),
            last_error = NULL,
            updated_at = NOW()
        FROM next_jobs
        WHERE jobs.id = next_jobs.id
        RETURNING jobs.*
      `,
      params,
    );
    return rows.map(operationJobFromRow);
  }

  const nowMs = Date.now();
  let leased: OperationJobRecord[] = [];
  await mutateJobLedger((ledger) => {
    const candidates = ledger.jobs
      .filter((job) => jobTenantId(job) === tenantId)
      .filter((job) => job.status === "queued")
      .filter((job) => Date.parse(job.runAt) <= nowMs)
      .filter((job) => !input.type || job.type === input.type)
      .filter((job) => !input.dedupeKey || job.dedupeKey === input.dedupeKey)
      .sort((left, right) => {
        const priority = right.priority - left.priority;
        if (priority !== 0) {
          return priority;
        }
        return Date.parse(left.runAt) - Date.parse(right.runAt);
      })
      .slice(0, limit);
    const candidateIds = new Set(candidates.map((job) => job.id));
    const leaseExpiresAt = new Date(nowMs + leaseSeconds * 1000).toISOString();
    ledger.jobs = ledger.jobs.map((job) => {
      if (!candidateIds.has(job.id)) {
        return job;
      }
      return {
        ...job,
        status: "running",
        attempt: job.attempt + 1,
        lockedAt: new Date(nowMs).toISOString(),
        leaseOwner: owner,
        leaseExpiresAt,
        lastError: undefined,
        updatedAt: new Date(nowMs).toISOString(),
      };
    });
    leased = ledger.jobs
      .filter((job) => candidateIds.has(job.id))
      .map((job) => ({ ...job, tenantId }));
    return trimJobLedger(ledger);
  });
  return leased;
}

export async function heartbeatOperationJob(
  jobId: string,
  leaseOwner: string,
  options: { tenantId?: string; leaseSeconds?: number } = {},
) {
  if (!leaseOwner) {
    return null;
  }
  const tenantId = normalizeTenantId(options.tenantId);
  const leaseSeconds = Math.min(Math.max(options.leaseSeconds || OPERATION_QUEUE_LEASE_SECONDS, 10), 3600);
  const now = new Date().toISOString();
  const leaseExpiresAt = new Date(Date.now() + leaseSeconds * 1000).toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET lease_expires_at = ${leaseExpiresAt},
          updated_at = ${now}
      WHERE id = ${jobId}
        AND tenant_id = ${tenantId}
        AND status = 'running'
        AND lease_owner = ${leaseOwner}
        AND lease_expires_at > NOW()
      RETURNING *
    `;
    return rows[0] ? operationJobFromRow(rows[0]) : null;
  }

  let saved: OperationJobRecord | null = null;
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (
        job.id !== jobId ||
        jobTenantId(job) !== tenantId ||
        job.status !== "running" ||
        job.leaseOwner !== leaseOwner ||
        !job.leaseExpiresAt ||
        Date.parse(job.leaseExpiresAt) <= Date.now()
      ) {
        return job;
      }
      saved = { ...job, leaseExpiresAt, updatedAt: now };
      return saved;
    });
    return trimJobLedger(ledger);
  });
  return saved;
}

export async function completeOperationJob(jobId: string, leaseOwner?: string, requestedTenantId?: string) {
  if (!leaseOwner) {
    return null;
  }
  const completedAt = new Date().toISOString();
  const tenantId = normalizeTenantId(requestedTenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN 'queued'
            ELSE 'completed'
          END,
          payload = payload - '__rerunRequested',
          attempt = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN 0
            ELSE attempt
          END,
          run_at = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN NOW()
            ELSE run_at
          END,
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          completed_at = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN NULL
            ELSE ${completedAt}::timestamptz
          END,
          updated_at = ${completedAt}
      WHERE id = ${jobId}
        AND tenant_id = ${tenantId}
        AND status = 'running'
        AND lease_owner = ${leaseOwner}
        AND lease_expires_at > NOW()
      RETURNING *
    `;
    return rows[0] ? operationJobFromRow(rows[0]) : null;
  }

  let saved: OperationJobRecord | null = null;
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (
        jobTenantId(job) !== tenantId ||
        job.id !== jobId ||
        job.status !== "running" ||
        job.leaseOwner !== leaseOwner ||
        !job.leaseExpiresAt ||
        Date.parse(job.leaseExpiresAt) <= Date.now()
      ) {
        return job;
      }
      const rerunRequested = job.payload.__rerunRequested === true;
      const payload = { ...job.payload };
      delete payload.__rerunRequested;
      saved = {
        ...job,
        status: rerunRequested ? "queued" : "completed",
        payload,
        attempt: rerunRequested ? 0 : job.attempt,
        runAt: rerunRequested ? completedAt : job.runAt,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        completedAt: rerunRequested ? undefined : completedAt,
        updatedAt: completedAt,
      };
      return saved;
    });
    return trimJobLedger(ledger);
  });
  return saved;
}

export async function failOperationJob(
  jobId: string,
  error: string,
  leaseOwner?: string,
  requestedTenantId?: string,
) {
  if (!leaseOwner) {
    return null;
  }
  const now = new Date().toISOString();
  const tenantId = normalizeTenantId(requestedTenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN 'queued'
            WHEN attempt < max_attempts THEN 'queued'
            ELSE 'failed'
          END,
          payload = payload - '__rerunRequested',
          attempt = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN 0
            ELSE attempt
          END,
          run_at = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN NOW()
            WHEN attempt < max_attempts
            THEN NOW() + (LEAST(300, POWER(2, GREATEST(attempt - 1, 0))::int * 15) * INTERVAL '1 second')
            ELSE run_at
          END,
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = CASE
            WHEN payload->>'__rerunRequested' = 'true' THEN NULL
            ELSE ${error}
          END,
          completed_at = CASE
            WHEN payload->>'__rerunRequested' = 'true' OR attempt < max_attempts THEN NULL
            ELSE ${now}::timestamptz
          END,
          updated_at = ${now}
      WHERE id = ${jobId}
        AND tenant_id = ${tenantId}
        AND status = 'running'
        AND lease_owner = ${leaseOwner}
        AND lease_expires_at > NOW()
      RETURNING *
    `;
    return rows[0] ? operationJobFromRow(rows[0]) : null;
  }

  let saved: OperationJobRecord | null = null;
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (
        jobTenantId(job) !== tenantId ||
        job.id !== jobId ||
        job.status !== "running" ||
        job.leaseOwner !== leaseOwner ||
        !job.leaseExpiresAt ||
        Date.parse(job.leaseExpiresAt) <= Date.now()
      ) {
        return job;
      }
      const rerunRequested = job.payload.__rerunRequested === true;
      const willRetry = rerunRequested || job.attempt < job.maxAttempts;
      const delaySeconds = Math.min(300, 2 ** Math.max(job.attempt - 1, 0) * 15);
      const payload = { ...job.payload };
      delete payload.__rerunRequested;
      saved = {
        ...job,
        payload,
        attempt: rerunRequested ? 0 : job.attempt,
        status: willRetry ? "queued" : "failed",
        runAt: rerunRequested
          ? now
          : willRetry
            ? new Date(Date.now() + delaySeconds * 1000).toISOString()
            : job.runAt,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: rerunRequested ? undefined : error,
        completedAt: willRetry ? undefined : now,
        updatedAt: now,
      };
      return saved;
    });
    return trimJobLedger(ledger);
  });
  return saved;
}

export async function deferOperationJob(
  jobId: string,
  leaseOwner: string,
  {
    tenantId: requestedTenantId,
    delaySeconds = 30,
    reason = "Job deferred without consuming an attempt.",
  }: {
    tenantId?: string;
    delaySeconds?: number;
    reason?: string;
  } = {},
) {
  const tenantId = normalizeTenantId(requestedTenantId);
  const boundedDelay = Math.min(Math.max(Math.round(delaySeconds), 1), 3600);
  const now = new Date().toISOString();
  const runAt = new Date(Date.now() + boundedDelay * 1000).toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = 'queued',
          attempt = GREATEST(attempt - 1, 0),
          run_at = ${runAt},
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ${reason},
          completed_at = NULL,
          updated_at = ${now}
      WHERE id = ${jobId}
        AND tenant_id = ${tenantId}
        AND status = 'running'
        AND lease_owner = ${leaseOwner}
        AND lease_expires_at > NOW()
      RETURNING *
    `;
    return rows[0] ? operationJobFromRow(rows[0]) : null;
  }

  let saved: OperationJobRecord | null = null;
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (
        job.id !== jobId ||
        jobTenantId(job) !== tenantId ||
        job.status !== "running" ||
        job.leaseOwner !== leaseOwner ||
        !job.leaseExpiresAt ||
        Date.parse(job.leaseExpiresAt) <= Date.now()
      ) {
        return job;
      }
      saved = {
        ...job,
        status: "queued",
        attempt: Math.max(job.attempt - 1, 0),
        runAt,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: reason,
        completedAt: undefined,
        updatedAt: now,
      };
      return saved;
    });
    return trimJobLedger(ledger);
  });
  return saved;
}

export async function wakeOperationJobByDedupeKey(
  dedupeKey: string,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = 'queued',
          run_at = NOW(),
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          completed_at = NULL,
          updated_at = NOW()
      WHERE tenant_id = ${tenantId}
        AND dedupe_key = ${storageDedupeKey(tenantId, dedupeKey)}
        AND (
          status = 'queued'
          OR status = 'failed'
          OR (
            status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
          )
        )
      RETURNING *
    `;
    return rows.map(operationJobFromRow);
  }

  const woken: OperationJobRecord[] = [];
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      const expired =
        job.status === "running" &&
        (!job.leaseExpiresAt ||
          Date.parse(job.leaseExpiresAt) <= Date.now());
      if (
        jobTenantId(job) !== tenantId ||
        job.dedupeKey !== dedupeKey ||
        !["queued", "failed"].includes(job.status) && !expired
      ) {
        return job;
      }
      const next: OperationJobRecord = {
        ...job,
        status: "queued",
        runAt: now,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        completedAt: undefined,
        updatedAt: now,
      };
      woken.push(next);
      return next;
    });
    return trimJobLedger(ledger);
  });
  return woken;
}

export async function cancelOperationJobByDedupeKey(
  dedupeKey: string,
  reason = "Job canceled.",
  options: { tenantId?: string } = {},
) {
  const now = new Date().toISOString();
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = 'canceled',
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ${reason},
          completed_at = ${now},
          updated_at = ${now}
      WHERE dedupe_key = ${storageDedupeKey(tenantId, dedupeKey)}
        AND tenant_id = ${tenantId}
        AND status IN ('queued', 'running')
      RETURNING *
    `;
    return rows.map(operationJobFromRow);
  }

  const canceled: OperationJobRecord[] = [];
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (
        jobTenantId(job) !== tenantId ||
        job.dedupeKey !== dedupeKey ||
        !["queued", "running"].includes(job.status)
      ) {
        return job;
      }
      const nextJob: OperationJobRecord = {
        ...job,
        status: "canceled",
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: reason,
        completedAt: now,
        updatedAt: now,
      };
      canceled.push(nextJob);
      return nextJob;
    });
    return trimJobLedger(ledger);
  });
  return canceled;
}

export async function requeueOperationJobByDedupeKey(
  dedupeKey: string,
  reason = "Job requeued.",
  options: { tenantId?: string } = {},
) {
  const now = new Date().toISOString();
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = 'queued',
          run_at = NOW(),
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ${reason},
          completed_at = NULL,
          updated_at = NOW()
      WHERE dedupe_key = ${storageDedupeKey(tenantId, dedupeKey)}
        AND tenant_id = ${tenantId}
        AND (
          status IN ('queued', 'failed')
          OR (
            status = 'running'
            AND (lease_expires_at IS NULL OR lease_expires_at <= NOW())
          )
        )
      RETURNING *
    `;
    return rows.map(operationJobFromRow);
  }

  const requeued: OperationJobRecord[] = [];
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      const expiredOrMissingLease = !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= Date.now();
      if (
        job.dedupeKey !== dedupeKey ||
        jobTenantId(job) !== tenantId ||
        (job.status !== "queued" && job.status !== "failed" && !(job.status === "running" && expiredOrMissingLease))
      ) {
        return job;
      }
      const nextJob: OperationJobRecord = {
        ...job,
        status: "queued",
        runAt: now,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: reason,
        completedAt: undefined,
        updatedAt: now,
      };
      requeued.push(nextJob);
      return nextJob;
    });
    return trimJobLedger(ledger);
  });
  return requeued;
}

export async function repairExpiredOperationJobs(
  options: { tenantId?: string } = {},
) {
  const now = new Date().toISOString();
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = CASE
            WHEN attempt < max_attempts OR type = 'workflow.tick'
              THEN 'queued'
            ELSE 'failed'
          END,
          run_at = CASE
            WHEN attempt < max_attempts OR type = 'workflow.tick'
              THEN NOW()
            ELSE run_at
          END,
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Lease expired before completion.'),
          completed_at = CASE
            WHEN attempt < max_attempts OR type = 'workflow.tick'
              THEN NULL
            ELSE NOW()
          END,
          updated_at = NOW()
      WHERE status = 'running'
        AND tenant_id = ${tenantId}
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
      RETURNING id
    `;
    return rows.length;
  }

  let repaired = 0;
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (
        jobTenantId(job) !== tenantId ||
        job.status !== "running" ||
        !job.leaseExpiresAt ||
        Date.parse(job.leaseExpiresAt) > Date.now()
      ) {
        return job;
      }
      repaired += 1;
      const willRetry =
        job.attempt < job.maxAttempts || job.type === "workflow.tick";
      return {
        ...job,
        status: willRetry ? "queued" : "failed",
        runAt: willRetry ? now : job.runAt,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: job.lastError || "Lease expired before completion.",
        completedAt: willRetry ? undefined : now,
        updatedAt: now,
      };
    });
    return trimJobLedger(ledger);
  });
  return repaired;
}

export async function listOperationJobs(
  limit = 20,
  options: { tenantId?: string } = {},
) {
  const tenantId = normalizeTenantId(options.tenantId);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_operation_jobs
      WHERE tenant_id = ${tenantId}
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(operationJobFromRow);
  }

  const ledger = await readJobLedger();
  return ledger.jobs
    .filter((job) => jobTenantId(job) === tenantId)
    .map((job) => ({ ...job, tenantId }))
    .slice(0, limit);
}

export async function listRunnableWorkflowTenantIds(limit = 10) {
  const boundedLimit = Math.min(Math.max(limit, 1), 25);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      "Find tenant-owned workflow work for the dedicated worker.",
      async () => {
        const rows = await getSql()`
          SELECT tenant_id
          FROM (
            SELECT
              tenant_id,
              MIN(CASE
                WHEN status = 'queued' THEN run_at
                ELSE lease_expires_at
              END) AS runnable_at
            FROM omni_operation_jobs
            WHERE type = 'workflow.tick'
              AND (
                (status = 'queued' AND run_at <= NOW())
                OR (status = 'running' AND lease_expires_at <= NOW())
              )
            GROUP BY tenant_id
            UNION ALL
            SELECT tenant_id, MIN(updated_at) AS runnable_at
            FROM omni_workflow_runs
            WHERE status = 'queued'
            GROUP BY tenant_id
          ) candidates
          GROUP BY tenant_id
          ORDER BY MIN(runnable_at) ASC, tenant_id ASC
          LIMIT ${boundedLimit}
        `;
        return rows.map((row) => String(row.tenant_id));
      },
    );
  }

  const now = Date.now();
  const ledger = await readJobLedger();
  const tenants = new Set(
    ledger.jobs
      .filter(
        (job) =>
          job.type === "workflow.tick" &&
          (
            (job.status === "queued" && Date.parse(job.runAt) <= now) ||
            (job.status === "running" && Date.parse(job.leaseExpiresAt || "") <= now)
          ),
      )
      .map(jobTenantId),
  );
  return [...tenants].sort().slice(0, boundedLimit);
}

export async function listRunnableAgentResumeTenantIds(limit = 10) {
  const boundedLimit = Math.min(Math.max(limit, 1), 25);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      "Find tenant-owned agent continuation work for the dedicated worker.",
      async () => {
        const rows = await getSql()`
          SELECT tenant_id
          FROM omni_operation_jobs
          WHERE type = 'agent.resume'
            AND (
              (status = 'queued' AND run_at <= NOW())
              OR (status = 'running' AND lease_expires_at <= NOW())
            )
          GROUP BY tenant_id
          ORDER BY MIN(
            CASE
              WHEN status = 'queued' THEN run_at
              ELSE lease_expires_at
            END
          ) ASC, tenant_id ASC
          LIMIT ${boundedLimit}
        `;
        return rows.map((row) => String(row.tenant_id));
      },
    );
  }

  const now = Date.now();
  const ledger = await readJobLedger();
  return [
    ...new Set(
      ledger.jobs
        .filter(
          (job) =>
            job.type === "agent.resume" &&
            ((job.status === "queued" && Date.parse(job.runAt) <= now) ||
              (job.status === "running" &&
                Date.parse(job.leaseExpiresAt || "") <= now)),
        )
        .map(jobTenantId),
    ),
  ]
    .sort()
    .slice(0, boundedLimit);
}

export async function listMaintenanceTenantIds({
  after,
  limit = 25,
}: {
  after?: string;
  limit?: number;
} = {}) {
  // Callers request one sentinel row beyond a 100-tenant page so pagination
  // does not silently stop at exactly 100 tenants.
  const boundedLimit = Math.min(Math.max(limit, 1), 101);
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    return runWithDatabaseSystemScope(
      "Page through tenants for scheduled SLO and alert maintenance.",
      async () => {
        const rows = await getSql()`
          WITH tenant_ids AS (
            SELECT id AS tenant_id FROM omni_auth_tenants
            UNION
            SELECT tenant_id FROM omni_operation_jobs
            UNION
            SELECT tenant_id FROM omni_agent_runs
            UNION
            SELECT tenant_id FROM omni_tool_executions
            UNION
            SELECT tenant_id FROM omni_observability_slo_policies
            UNION
            SELECT tenant_id FROM omni_incidents
            UNION
            SELECT tenant_id FROM omni_alert_deliveries
          )
          SELECT tenant_id
          FROM tenant_ids
          WHERE tenant_id IS NOT NULL
            AND tenant_id <> ''
            AND (${after || null}::text IS NULL OR tenant_id > ${after || null})
          ORDER BY tenant_id ASC
          LIMIT ${boundedLimit}
        `;
        return rows.map((row) => String(row.tenant_id));
      },
    );
  }

  const ledger = await readJobLedger();
  const tenants = new Set([
    process.env.OMNIAGENT_DEFAULT_TENANT || "default",
    ...ledger.jobs.map(jobTenantId),
  ]);
  return [...tenants]
    .sort()
    .filter((tenantId) => !after || tenantId > after)
    .slice(0, boundedLimit);
}

export async function getOperationJobStats(
  options: { tenantId?: string } = {},
): Promise<OperationJobStats> {
  const tenantId = normalizeTenantId(options.tenantId);

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const [statusRows, runnableRows, delayedRows, expiredRows] = await Promise.all([
      getSql()`
        SELECT status, COUNT(*)::int AS count
        FROM omni_operation_jobs
        WHERE tenant_id = ${tenantId}
        GROUP BY status
      `,
      getSql()`
        SELECT COUNT(*)::int AS count
        FROM omni_operation_jobs
        WHERE status = 'queued'
          AND tenant_id = ${tenantId}
          AND run_at <= NOW()
      `,
      getSql()`
        SELECT COUNT(*)::int AS count
        FROM omni_operation_jobs
        WHERE status = 'queued'
          AND tenant_id = ${tenantId}
          AND run_at > NOW()
      `,
      getSql()`
        SELECT COUNT(*)::int AS count
        FROM omni_operation_jobs
        WHERE status = 'running'
          AND tenant_id = ${tenantId}
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= NOW()
      `,
    ]);
    const byStatus = statusRows.reduce<Record<string, number>>((acc, row) => {
      acc[String(row.status)] = Number(row.count);
      return acc;
    }, {});
    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
      runnable: Number(runnableRows[0]?.count || 0),
      delayed: Number(delayedRows[0]?.count || 0),
      expiredLeases: Number(expiredRows[0]?.count || 0),
      latest: await listOperationJobs(5, { tenantId }),
    };
  }

  const ledger = await readJobLedger();
  const jobs = ledger.jobs
    .filter((job) => jobTenantId(job) === tenantId)
    .map((job) => ({ ...job, tenantId }));
  const now = Date.now();
  const byStatus = jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  return {
    total: jobs.length,
    byStatus,
    runnable: jobs.filter((job) => job.status === "queued" && Date.parse(job.runAt) <= now).length,
    delayed: jobs.filter((job) => job.status === "queued" && Date.parse(job.runAt) > now).length,
    expiredLeases: jobs.filter(
      (job) => job.status === "running" && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= now,
    ).length,
    latest: jobs.slice(0, 5),
  };
}

function operationJobFromRow(row: Record<string, unknown>): OperationJobRecord {
  const tenantId = jobTenantId({
    tenantId: row.tenant_id ? String(row.tenant_id) : undefined,
  });
  return {
    id: String(row.id),
    tenantId,
    type: String(row.type) as OperationJobType,
    status: String(row.status) as OperationJobStatus,
    payload: parseObject(row.payload) || {},
    dedupeKey: row.dedupe_key
      ? logicalDedupeKey(tenantId, String(row.dedupe_key))
      : undefined,
    priority: Number(row.priority || 0),
    attempt: Number(row.attempt || 0),
    maxAttempts: Number(row.max_attempts || 3),
    runAt: normalizeDate(row.run_at),
    lockedAt: row.locked_at ? normalizeDate(row.locked_at) : undefined,
    leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined,
    leaseExpiresAt: row.lease_expires_at ? normalizeDate(row.lease_expires_at) : undefined,
    lastError: row.last_error ? String(row.last_error) : undefined,
    createdAt: normalizeDate(row.created_at),
    updatedAt: normalizeDate(row.updated_at),
    completedAt: row.completed_at ? normalizeDate(row.completed_at) : undefined,
  };
}

async function readJobLedger() {
  const ledger = await readJsonFile<OperationJobLedger>(getJobsFile(), { jobs: [] });
  return {
    jobs: ledger.jobs.map((job) => ({ ...job, tenantId: jobTenantId(job) })),
  };
}

async function mutateJobLedger(mutator: (ledger: OperationJobLedger) => OperationJobLedger) {
  await updateJsonFile<OperationJobLedger>(
    getJobsFile(),
    { jobs: [] },
    (ledger) => trimJobLedger(mutator({
      jobs: ledger.jobs.map((job) => ({ ...job, tenantId: jobTenantId(job) })),
    })),
  );
}

function trimJobLedger(ledger: OperationJobLedger): OperationJobLedger {
  const sorted = ledger.jobs
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  const durable = sorted.filter((job) => job.status === "queued" || job.status === "running");
  const terminal = sorted.filter((job) => job.status !== "queued" && job.status !== "running");
  return {
    jobs: [...durable, ...terminal.slice(0, Math.max(0, 500 - durable.length))],
  };
}

function parseObject(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  // Supabase's transaction pooler requires prepare:false, under which the
  // postgres driver returns jsonb columns as raw strings rather than parsed
  // objects. Parse them here so payloads survive the round-trip.
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return undefined;
    }
  }

  return undefined;
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

function jobTenantId(job: { tenantId?: string }) {
  return normalizeTenantId(
    job.tenantId || process.env.OMNIAGENT_DEFAULT_TENANT || "default",
  );
}

export function storageDedupeKey(tenantId: string | undefined, dedupeKey: string) {
  const normalizedTenantId = normalizeTenantId(tenantId);
  return normalizedTenantId === "default"
    ? dedupeKey
    : `${normalizedTenantId}/${dedupeKey}`;
}

export function getAgentResumeJobDedupeKey(executionId: string) {
  return `agent.resume:${executionId}`;
}

function logicalDedupeKey(tenantId: string, dedupeKey: string) {
  const prefix = `${tenantId}/`;
  return tenantId !== "default" && dedupeKey.startsWith(prefix)
    ? dedupeKey.slice(prefix.length)
    : dedupeKey;
}

function getJobsFile() {
  return getDataPath("operation-jobs.json");
}
