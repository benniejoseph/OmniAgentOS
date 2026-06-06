import { randomUUID } from "node:crypto";
import { OPERATION_QUEUE_LEASE_SECONDS } from "@/lib/config";
import { ensureDatabaseSchema, getSql, hasDatabaseUrl } from "@/lib/db/client";
import { readJsonFile, writeJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type OperationJobType = "workflow.tick";
export type OperationJobStatus = "queued" | "running" | "completed" | "failed" | "canceled";

export type OperationJobRecord = {
  id: string;
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
  type: OperationJobType;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  priority?: number;
  maxAttempts?: number;
  runAt?: string;
};

type LeaseOperationJobInput = {
  type?: OperationJobType;
  dedupeKey?: string;
  limit?: number;
  leaseSeconds?: number;
  owner?: string;
};

let jobFileWriteQueue: Promise<void> = Promise.resolve();

export async function enqueueOperationJob(input: EnqueueOperationJobInput) {
  const now = new Date().toISOString();
  const runAt = input.runAt || now;
  const job: OperationJobRecord = {
    id: randomUUID(),
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
    await ensureDatabaseSchema();
    const sql = getSql();

    if (input.dedupeKey) {
      const rows = await sql`
        INSERT INTO omni_operation_jobs (
          id, type, status, payload, dedupe_key, priority, attempt,
          max_attempts, run_at, created_at, updated_at
        )
        VALUES (
          ${job.id}, ${job.type}, ${job.status}, ${JSON.stringify(job.payload)}::jsonb,
          ${job.dedupeKey}, ${job.priority}, ${job.attempt}, ${job.maxAttempts},
          ${job.runAt}, ${job.createdAt}, ${job.updatedAt}
        )
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO UPDATE SET
          type = EXCLUDED.type,
          payload = EXCLUDED.payload,
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
        id, type, status, payload, dedupe_key, priority, attempt,
        max_attempts, run_at, created_at, updated_at
      )
      VALUES (
        ${job.id}, ${job.type}, ${job.status}, ${JSON.stringify(job.payload)}::jsonb,
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
      const existing = ledger.jobs.find((item) => item.dedupeKey === input.dedupeKey);
      if (existing) {
        const activeLease = existing.status === "running" && Date.parse(existing.leaseExpiresAt || "") > Date.now();
        saved = {
          ...existing,
          type: input.type,
          payload: input.payload,
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
  const limit = Math.min(Math.max(input.limit || 1, 1), 25);
  const leaseSeconds = Math.min(Math.max(input.leaseSeconds || OPERATION_QUEUE_LEASE_SECONDS, 10), 3600);
  const owner = input.owner || `worker:${randomUUID()}`;

  await repairExpiredOperationJobs();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const filters = ["status = 'queued'", "run_at <= NOW()"];
    const params: Array<string | number> = [];
    if (input.type) {
      params.push(input.type);
      filters.push(`type = $${params.length}`);
    }
    if (input.dedupeKey) {
      params.push(input.dedupeKey);
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
    leased = ledger.jobs.filter((job) => candidateIds.has(job.id));
    return trimJobLedger(ledger);
  });
  return leased;
}

export async function completeOperationJob(jobId: string) {
  const completedAt = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = 'completed',
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          completed_at = ${completedAt},
          updated_at = ${completedAt}
      WHERE id = ${jobId}
      RETURNING *
    `;
    return rows[0] ? operationJobFromRow(rows[0]) : null;
  }

  let saved: OperationJobRecord | null = null;
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (job.id !== jobId) {
        return job;
      }
      saved = {
        ...job,
        status: "completed",
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: undefined,
        completedAt,
        updatedAt: completedAt,
      };
      return saved;
    });
    return trimJobLedger(ledger);
  });
  return saved;
}

export async function failOperationJob(jobId: string, error: string) {
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      UPDATE omni_operation_jobs
      SET status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
          run_at = CASE
            WHEN attempt < max_attempts
            THEN NOW() + (LEAST(300, POWER(2, GREATEST(attempt - 1, 0))::int * 15) * INTERVAL '1 second')
            ELSE run_at
          END,
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = ${error},
          completed_at = CASE WHEN attempt < max_attempts THEN NULL ELSE ${now}::timestamptz END,
          updated_at = ${now}
      WHERE id = ${jobId}
      RETURNING *
    `;
    return rows[0] ? operationJobFromRow(rows[0]) : null;
  }

  let saved: OperationJobRecord | null = null;
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (job.id !== jobId) {
        return job;
      }
      const willRetry = job.attempt < job.maxAttempts;
      const delaySeconds = Math.min(300, 2 ** Math.max(job.attempt - 1, 0) * 15);
      saved = {
        ...job,
        status: willRetry ? "queued" : "failed",
        runAt: willRetry ? new Date(Date.now() + delaySeconds * 1000).toISOString() : job.runAt,
        lockedAt: undefined,
        leaseOwner: undefined,
        leaseExpiresAt: undefined,
        lastError: error,
        completedAt: willRetry ? undefined : now,
        updatedAt: now,
      };
      return saved;
    });
    return trimJobLedger(ledger);
  });
  return saved;
}

export async function cancelOperationJobByDedupeKey(dedupeKey: string, reason = "Job canceled.") {
  const now = new Date().toISOString();

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
      WHERE dedupe_key = ${dedupeKey}
        AND status IN ('queued', 'running')
      RETURNING *
    `;
    return rows.map(operationJobFromRow);
  }

  const canceled: OperationJobRecord[] = [];
  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (job.dedupeKey !== dedupeKey || !["queued", "running"].includes(job.status)) {
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

export async function repairExpiredOperationJobs() {
  const now = new Date().toISOString();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await getSql()`
      UPDATE omni_operation_jobs
      SET status = CASE WHEN attempt < max_attempts THEN 'queued' ELSE 'failed' END,
          run_at = CASE WHEN attempt < max_attempts THEN NOW() ELSE run_at END,
          locked_at = NULL,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = COALESCE(last_error, 'Lease expired before completion.'),
          completed_at = CASE WHEN attempt < max_attempts THEN NULL ELSE NOW() END,
          updated_at = NOW()
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= NOW()
    `;
    return;
  }

  await mutateJobLedger((ledger) => {
    ledger.jobs = ledger.jobs.map((job) => {
      if (job.status !== "running" || !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) > Date.now()) {
        return job;
      }
      const willRetry = job.attempt < job.maxAttempts;
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
}

export async function listOperationJobs(limit = 20) {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await getSql()`
      SELECT *
      FROM omni_operation_jobs
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(operationJobFromRow);
  }

  const ledger = await readJobLedger();
  return ledger.jobs.slice(0, limit);
}

export async function getOperationJobStats(): Promise<OperationJobStats> {
  await repairExpiredOperationJobs();

  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const [statusRows, runnableRows, delayedRows, expiredRows] = await Promise.all([
      getSql()`
        SELECT status, COUNT(*)::int AS count
        FROM omni_operation_jobs
        GROUP BY status
      `,
      getSql()`
        SELECT COUNT(*)::int AS count
        FROM omni_operation_jobs
        WHERE status = 'queued'
          AND run_at <= NOW()
      `,
      getSql()`
        SELECT COUNT(*)::int AS count
        FROM omni_operation_jobs
        WHERE status = 'queued'
          AND run_at > NOW()
      `,
      getSql()`
        SELECT COUNT(*)::int AS count
        FROM omni_operation_jobs
        WHERE status = 'running'
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
      latest: await listOperationJobs(5),
    };
  }

  const ledger = await readJobLedger();
  const now = Date.now();
  const byStatus = ledger.jobs.reduce<Record<string, number>>((acc, job) => {
    acc[job.status] = (acc[job.status] || 0) + 1;
    return acc;
  }, {});
  return {
    total: ledger.jobs.length,
    byStatus,
    runnable: ledger.jobs.filter((job) => job.status === "queued" && Date.parse(job.runAt) <= now).length,
    delayed: ledger.jobs.filter((job) => job.status === "queued" && Date.parse(job.runAt) > now).length,
    expiredLeases: ledger.jobs.filter(
      (job) => job.status === "running" && job.leaseExpiresAt && Date.parse(job.leaseExpiresAt) <= now,
    ).length,
    latest: ledger.jobs.slice(0, 5),
  };
}

function operationJobFromRow(row: Record<string, unknown>): OperationJobRecord {
  return {
    id: String(row.id),
    type: String(row.type) as OperationJobType,
    status: String(row.status) as OperationJobStatus,
    payload: parseObject(row.payload) || {},
    dedupeKey: row.dedupe_key ? String(row.dedupe_key) : undefined,
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
  return readJsonFile<OperationJobLedger>(getJobsFile(), { jobs: [] });
}

async function mutateJobLedger(mutator: (ledger: OperationJobLedger) => OperationJobLedger) {
  jobFileWriteQueue = jobFileWriteQueue.then(
    async () => {
      await writeJobLedger(mutator(await readJobLedger()));
    },
    async () => {
      await writeJobLedger(mutator(await readJobLedger()));
    },
  );
  await jobFileWriteQueue;
}

async function writeJobLedger(ledger: OperationJobLedger) {
  await writeJsonFile(getJobsFile(), trimJobLedger(ledger));
}

function trimJobLedger(ledger: OperationJobLedger): OperationJobLedger {
  return {
    jobs: ledger.jobs
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
      .slice(0, 500),
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

function getJobsFile() {
  return getDataPath("operation-jobs.json");
}
