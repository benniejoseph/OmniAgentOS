import { randomUUID } from "node:crypto";
import {
  ensureDatabaseSchema,
  getSql,
  hasDatabaseUrl,
  runWithDatabaseSystemScope,
} from "@/lib/db/client";
import { readJsonFile, updateJsonFile } from "@/lib/storage/json";
import { getDataPath } from "@/lib/storage/paths";

export type WorkerHeartbeat = {
  instanceId: string;
  revision?: string;
  recordedAt: string;
};

type WorkerHeartbeatLedger = {
  latest?: WorkerHeartbeat;
};

export async function recordWorkerHeartbeat(input: {
  instanceId: string;
  revision?: string;
}) {
  const heartbeat: WorkerHeartbeat = {
    instanceId: input.instanceId.slice(0, 160),
    revision: input.revision?.slice(0, 160) || undefined,
    recordedAt: new Date().toISOString(),
  };
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    await runWithDatabaseSystemScope(
      "Record the dedicated worker heartbeat for release readiness.",
      () =>
        getSql()`
          INSERT INTO omni_system_health_checks (
            id, tenant_id, status, scope, components, metrics, incidents,
            recovery_actions, latency_ms, created_at
          )
          VALUES (
            ${randomUUID()},
            'system',
            'healthy',
            'worker_heartbeat',
            ${[{
              name: "dedicated_worker",
              status: "healthy",
              instanceId: heartbeat.instanceId,
              revision: heartbeat.revision,
            }]}::jsonb,
            '{}'::jsonb,
            '[]'::jsonb,
            '[]'::jsonb,
            0,
            ${heartbeat.recordedAt}
          )
        `,
    );
    return heartbeat;
  }

  await updateJsonFile<WorkerHeartbeatLedger>(
    getDataPath("worker-heartbeat.json"),
    {},
    () => ({ latest: heartbeat }),
  );
  return heartbeat;
}

export async function getLatestWorkerHeartbeat() {
  if (hasDatabaseUrl()) {
    await ensureDatabaseSchema();
    const rows = await runWithDatabaseSystemScope(
      "Read the dedicated worker heartbeat for release readiness.",
      () =>
        getSql()`
          SELECT components, created_at
          FROM omni_system_health_checks
          WHERE scope = 'worker_heartbeat'
          ORDER BY created_at DESC
          LIMIT 1
        `,
    );
    const row = rows[0];
    const component =
      Array.isArray(row?.components) &&
      row.components[0] &&
      typeof row.components[0] === "object"
        ? row.components[0] as Record<string, unknown>
        : {};
    return row
      ? {
          instanceId: String(component.instanceId || "unknown"),
          revision: component.revision
            ? String(component.revision)
            : undefined,
          recordedAt:
            row.created_at instanceof Date
              ? row.created_at.toISOString()
              : new Date(String(row.created_at)).toISOString(),
        }
      : undefined;
  }

  return (
    await readJsonFile<WorkerHeartbeatLedger>(
      getDataPath("worker-heartbeat.json"),
      {},
    )
  ).latest;
}
